// =====================================================================
// TOLVINK — WhatsApp Message Router
// Routes incoming WhatsApp messages to appropriate handlers
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsService } from '../freights/freights.service';
import { AiService } from '../ai/ai.service';
import OpenAI from 'openai';

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  pending_assignment: 'Sin asignar',
  assigned: 'Asignado',
  accepted: 'Aceptado',
  in_progress: 'En camino',
  loaded: 'Cargado',
  finished: 'Finalizado',
  canceled: 'Cancelado',
};

const STATUS_EMOJI: Record<string, string> = {
  draft: '📝',
  pending_assignment: '⏳',
  assigned: '📋',
  accepted: '✅',
  in_progress: '🚛',
  loaded: '📦',
  finished: '🏁',
  canceled: '❌',
};

const APP_URL = 'https://tolvink.vercel.app';

@Injectable()
export class WhatsAppRouterService {
  private readonly logger = new Logger(WhatsAppRouterService.name);
  private openai: OpenAI | null = null;

  constructor(
    private prisma: PrismaService,
    private wa: WhatsAppService,
    private flow: WhatsAppFlowService,
    private freights: FreightsService,
    private ai: AiService,
  ) {
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
      this.logger.log('OpenAI Whisper enabled for audio transcription');
    } else {
      this.logger.warn('OPENAI_API_KEY not set — audio transcription disabled');
    }
  }

  // ======================== MAIN ENTRY POINT ============================

  async handleMessage(phone: string, type: string, payload: any, waMessageId: string) {
    try {
      console.log(`[WA-ROUTER] handleMessage type=${type} phone=${phone} payload=${JSON.stringify(payload).slice(0, 150)}`);

      // Mark as read
      this.wa.markRead(waMessageId).catch(() => {});

      // Find user by phone
      const normalized = this.wa.normalizePhone(phone);
      const user = await this.findUserByPhone(phone);

      if (!user) {
        await this.wa.sendText(phone,
          'Este numero no esta registrado en Tolvink.\n\n' +
          `Registrate en la app primero: ${APP_URL}`,
        );
        return;
      }

      // Check for active flow
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });

      if (session?.flowType) {
        // Handle cancel/menu command inside any flow
        const cmd = type === 'text' ? payload.body?.trim().toLowerCase() : '';
        if (/^(cancelar|salir|exit|cancel)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.wa.sendText(phone, 'Operacion cancelada.');
          await this.showMainMenu(phone, user);
          return;
        }
        if (/^(menu|inicio|hola)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.showMainMenu(phone, user);
          return;
        }

        await this.flow.continueFlow(session, type, payload, phone, user);
        return;
      }

      // Route by message type
      if (type === 'button_reply') {
        await this.handleButtonReply(phone, user, payload.id, payload.title);
      } else if (type === 'list_reply') {
        await this.handleListReply(phone, user, payload.id, payload.title);
      } else if (type === 'text') {
        // Detect forwarded messages and tag them for AI context
        let textBody = payload.body || '';
        if (payload.forwarded) {
          textBody = `[Mensaje reenviado] ${textBody}`;
        }
        await this.handleText(phone, user, textBody);
      } else if (type === 'location') {
        await this.handleLocation(phone, user, payload);
      } else if (type === 'audio') {
        await this.handleAudio(phone, user, payload);
      } else {
        await this.wa.sendText(phone, 'Por ahora solo puedo procesar mensajes de texto, audio y ubicaciones. Escribi *menu* para ver las opciones.');
      }
    } catch (e) {
      this.logger.error(`handleMessage error for ${phone}: ${e.message}`, e.stack);
      await this.wa.sendText(phone, 'Ocurrio un error procesando tu mensaje. Intenta de nuevo.');
    }
  }

  // ======================== TEXT HANDLER =================================

  private async handleText(phone: string, user: any, text: string) {
    const t = text.trim();

    // Edge case: empty or whitespace-only message
    if (!t) return;

    // Edge case: emoji-only message (1-4 emojis, no text)
    const emojiOnly = /^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\s]{1,16}$/u.test(t) && !/[a-zA-Z0-9]/.test(t);
    if (emojiOnly && this.ai.isEnabled()) {
      // Forward to AI with context so it can interpret naturally
      await this.handleAiChat(phone, user, `[El usuario envio solo emojis: ${t}]`);
      return;
    }

    // Edge case: very short message (1-2 chars, not a command)
    if (t.length <= 2 && !/^(si|no|ok)$/i.test(t) && this.ai.isEnabled()) {
      await this.handleAiChat(phone, user, t);
      return;
    }

    // Fast path: freight code lookup (no AI needed)
    if (/^FLT-\d{4,}$/i.test(t)) {
      await this.showFreightByCode(phone, user, t.toUpperCase());
      return;
    }

    // Fast path: explicit menu/hola commands
    if (/^(menu|inicio|hola|hi)$/i.test(t)) {
      await this.showMainMenu(phone, user);
      return;
    }

    // AI-powered handler for all other text
    if (this.ai.isEnabled()) {
      await this.handleAiChat(phone, user, t);
      return;
    }

    // Fallback: regex intent matching (when AI disabled)
    if (/^(estado|status|mis fletes|fletes)$/i.test(t)) {
      await this.showActiveFreights(phone, user);
      return;
    }

    if (/^(crear|nuevo|nuevo flete|solicitar)$/i.test(t)) {
      await this.flow.startFlow('create_freight', phone, user);
      return;
    }

    if (/^(ayuda|help)$/i.test(t)) {
      await this.showHelp(phone, user);
      return;
    }

    // Default: show menu
    await this.showMainMenu(phone, user);
  }

  // ======================== AI CHAT HANDLER ==============================

  private async handleAiChat(phone: string, user: any, text: string) {
    try {
      // Find or create an AI session (flowType = null)
      let session = await this.prisma.whatsAppSession.findFirst({
        where: {
          userId: user.id,
          flowType: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (!session) {
        session = await this.prisma.whatsAppSession.create({
          data: {
            userId: user.id,
            phone: this.wa.normalizePhone(phone),
            flowType: null,
            flowStep: '0',
            flowState: {},
            expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
          },
        });
      }

      const reply = await this.ai.chat(phone, text, user, session);

      // Split long messages (WhatsApp max ~4096 chars per message)
      if (reply.length > 4000) {
        const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
        for (const chunk of chunks) {
          await this.wa.sendText(phone, chunk);
        }
      } else {
        await this.wa.sendText(phone, reply);
      }
    } catch (e) {
      console.error(`[WA-AI] handleAiChat error:`, e.message, e.stack?.slice(0, 300));
      this.logger.error(`AI chat error: ${e.message}`);
      await this.wa.sendText(phone,
        'Estoy teniendo problemas tecnicos. Usa los botones del menu.',
      );
      await this.showMainMenu(phone, user);
    }
  }

  // ======================== LOCATION HANDLER ==============================

  private async handleLocation(phone: string, user: any, payload: any) {
    const { latitude, longitude, name, address } = payload;

    // Save location in AI session for later use (create_field, create_lot, prepare_freight)
    let session = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });

    if (!session) {
      session = await this.prisma.whatsAppSession.create({
        data: {
          userId: user.id,
          phone: this.wa.normalizePhone(phone),
          flowType: null,
          flowStep: '0',
          flowState: {},
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
    }

    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          lastLocation: { lat: latitude, lng: longitude, name: name || '', address: address || '' },
        },
      },
    });

    // Forward as text to AI so Claude knows the user shared a location
    const locationDesc = name || address || `${latitude}, ${longitude}`;
    const textForAi = `[Ubicacion compartida: ${locationDesc} (lat: ${latitude}, lng: ${longitude})]`;
    await this.handleAiChat(phone, user, textForAi);
  }

  // ======================== AUDIO HANDLER =================================

  private async handleAudio(phone: string, user: any, payload: any) {
    if (!this.openai) {
      await this.wa.sendText(phone, 'El procesamiento de audio no esta disponible. Envia tu mensaje como texto.');
      return;
    }

    try {
      await this.wa.sendText(phone, '🎙️ Procesando tu audio...');

      // Download audio from Meta
      const { buffer, mimeType } = await this.wa.downloadMedia(payload.mediaId);

      // Size check: Whisper API limit is 25MB, WhatsApp max ~16MB
      const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB safety margin
      if (buffer.length > MAX_AUDIO_BYTES) {
        this.logger.warn(`Audio too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB from ${phone}`);
        await this.wa.sendText(phone, 'El audio es demasiado largo. Envia un mensaje mas corto (menos de 2 minutos) o escribi como texto.');
        return;
      }
      if (buffer.length > 10 * 1024 * 1024) {
        this.logger.warn(`Large audio (${(buffer.length / 1024 / 1024).toFixed(1)}MB) from ${phone}`);
      }

      // Map MIME type to file extension for Whisper
      const ext = mimeType.includes('ogg') ? 'ogg'
        : mimeType.includes('mp4') ? 'mp4'
        : mimeType.includes('mpeg') ? 'mp3'
        : 'ogg';

      // Transcribe with OpenAI Whisper (convert Buffer to Uint8Array for TS compat)
      const uint8 = new Uint8Array(buffer);
      const file = new File([uint8], `audio.${ext}`, { type: mimeType });
      const transcription = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: 'es',
      });

      const text = transcription.text?.trim();
      if (!text) {
        await this.wa.sendText(phone, 'No pude entender el audio. Intenta de nuevo o envia un mensaje de texto.');
        return;
      }

      this.logger.log(`Audio transcribed (${buffer.length} bytes): "${text.slice(0, 100)}"`);

      // Tag as audio-sourced so AI knows to handle filler words/noise
      const taggedText = `[Audio transcripto] ${text}`;

      // Pass transcription to AI chat (preprocessing in ai.service strips fillers)
      await this.handleAiChat(phone, user, taggedText);
    } catch (e) {
      this.logger.error(`Audio processing error: ${e.message}`, e.stack?.slice(0, 300));
      await this.wa.sendText(phone, 'No pude procesar el audio. Intenta de nuevo o envia un mensaje de texto.');
    }
  }

  // ======================== BUTTON REPLY HANDLER ========================

  private async handleButtonReply(phone: string, user: any, buttonId: string, title: string) {
    // Button ID format: "action:entityId" or "action:entityId:extra"
    const parts = buttonId.split(':');
    const action = parts[0];
    const entityId = parts[1] || '';

    const synUser = this.buildSyntheticUser(user);

    try {
      switch (action) {
        case 'accept': {
          await this.freights.respond(entityId, { action: 'accepted' } as any, synUser);
          await this.wa.sendText(phone, '✅ Flete aceptado correctamente.');
          break;
        }
        case 'reject': {
          // Start reject flow (needs reason)
          await this.flow.startFlow('reject_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'start': {
          await this.freights.start(entityId, synUser);
          await this.wa.sendText(phone, '🚛 Viaje iniciado. Buen camino!');
          break;
        }
        case 'confirm_loaded': {
          // Start loaded flow (needs tons)
          await this.flow.startFlow('confirm_loaded', phone, user, { freightId: entityId });
          break;
        }
        case 'confirm_finished': {
          await this.freights.confirmFinished(entityId, synUser);
          await this.wa.sendText(phone, '🏁 Entrega confirmada.');
          break;
        }
        case 'cancel': {
          // Start cancel flow (needs reason)
          await this.flow.startFlow('cancel_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'detail': {
          await this.showFreightDetail(phone, user, entityId);
          break;
        }
        case 'menu': {
          await this.showMainMenu(phone, user);
          break;
        }
        case 'active_freights': {
          await this.showActiveFreights(phone, user);
          break;
        }
        case 'create_freight': {
          await this.flow.startFlow('create_freight', phone, user);
          break;
        }
        case 'show_help': {
          await this.showHelp(phone, user);
          break;
        }
        default: {
          await this.wa.sendText(phone, 'Accion no reconocida. Escribi *menu* para ver opciones.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${e.message}`);
      await this.wa.sendText(phone, `Error: ${e.message}`);
    }
  }

  // ======================== LIST REPLY HANDLER ==========================

  private async handleListReply(phone: string, user: any, listId: string, title: string) {
    // List IDs: "freight:uuid" or "action:freightId"
    const parts = listId.split(':');
    const type = parts[0];
    const id = parts.slice(1).join(':');

    if (type === 'freight') {
      await this.showFreightDetail(phone, user, id);
    } else {
      // Treat as button reply for action-based lists
      await this.handleButtonReply(phone, user, listId, title);
    }
  }

  // ======================== SHOW MAIN MENU ==============================

  async showMainMenu(phone: string, user: any) {
    const name = user.name?.split(' ')[0] || 'usuario';
    const role = this.getUserRole(user);
    const companyName = user.company?.name || '';
    const roleLabel = role === 'producer' ? 'Productor' : role === 'plant' ? 'Planta' : role === 'transporter' ? 'Transportista' : '';
    const tag = companyName ? `${companyName}${roleLabel ? ` · ${roleLabel}` : ''}` : '';

    const greeting = `Hola *${name}*! Soy el asistente de *Tolvink* 🌾` +
      (tag ? `\n_${tag}_` : '') +
      `\n\n`;

    const features = this.getRoleFeatureSummary(role);

    await this.wa.sendButtons(phone,
      greeting + features + `\nEscribi lo que necesitas o usa los botones:`,
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const role = this.getUserRole(user);

    const header = `*Guia de Tolvink por WhatsApp* 📋\n━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const commands =
      `*Atajos rapidos:*\n` +
      `• *menu* → volver al inicio\n` +
      `• *crear* → crear flete nuevo\n` +
      `• *fletes* → ver tus fletes activos\n` +
      `• *FLT-0001* → ver detalle de un flete\n` +
      `• *cancelar* → salir de una operacion\n\n`;

    const roleSection = this.getRoleHelpSection(role);

    const tips =
      `\n*Tips:*\n` +
      `💬 Podes escribir en lenguaje natural\n` +
      `🎤 Tambien acepto mensajes de voz\n` +
      `📍 Comparti ubicacion para origen/destino\n` +
      `📄 Pedi un _informe PDF_ de cualquier flete\n` +
      `🗺️ Pedi un _link de seguimiento_ en vivo\n\n` +
      `📱 App completa: ${APP_URL}`;

    await this.wa.sendText(phone, header + commands + roleSection + tips);

    await this.wa.sendButtons(phone,
      'Que queres hacer?',
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== ROLE HELPERS ================================

  private getUserRole(user: any): string {
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    if (userTypes.length > 0) return userTypes[0];
    if (user.company?.type) return user.company.type;
    if (user.memberships?.length > 0) {
      const co = user.memberships[0].company;
      const types = Array.isArray(co?.types) && co.types.length > 0 ? co.types : [co?.type];
      return types[0] || 'unknown';
    }
    return 'unknown';
  }

  private getRoleFeatureSummary(role: string): string {
    if (role === 'producer') {
      return (
        `*Lo que podes hacer:*\n` +
        `📦 Crear fletes (grano, toneladas, planta, fecha)\n` +
        `🚛 Gestionar tu flota propia\n` +
        `📋 Ver estado de tus fletes en tiempo real\n` +
        `✅ Confirmar cargas de flota propia\n` +
        `🗺️ Seguimiento en vivo de camiones\n` +
        `📄 Descargar informes PDF\n` +
        `🌾 Administrar campos y lotes\n` +
        `👥 Gestionar equipo (admin)\n\n`
      );
    }
    if (role === 'plant') {
      return (
        `*Lo que podes hacer:*\n` +
        `📋 Ver fletes pendientes de asignacion\n` +
        `🚛 Asignar transportistas a fletes\n` +
        `✅ Confirmar recepciones y entregas\n` +
        `🗺️ Seguimiento en vivo de camiones\n` +
        `📄 Descargar informes PDF\n` +
        `👥 Gestionar equipo (admin)\n\n`
      );
    }
    if (role === 'transporter') {
      return (
        `*Lo que podes hacer:*\n` +
        `📋 Ver fletes asignados\n` +
        `✅ Aceptar o rechazar asignaciones\n` +
        `🚛 Iniciar viajes\n` +
        `📦 Confirmar carga (con toneladas reales)\n` +
        `🏁 Confirmar entrega en destino\n` +
        `🗺️ Seguimiento en vivo\n` +
        `📄 Descargar informes PDF\n` +
        `👥 Gestionar choferes y camiones\n\n`
      );
    }
    // Generic fallback
    return (
      `*Lo que podes hacer:*\n` +
      `📦 Crear y gestionar fletes\n` +
      `📋 Ver estado de fletes en tiempo real\n` +
      `✅ Confirmar cargas y entregas\n` +
      `🗺️ Seguimiento en vivo\n` +
      `📄 Descargar informes PDF\n\n`
    );
  }

  private getRoleMenuButtons(role: string): Array<{ id: string; title: string }> {
    if (role === 'producer') {
      return [
        { id: 'create_freight', title: 'CREAR FLETE' },
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'show_help', title: 'GUIA COMPLETA' },
      ];
    }
    if (role === 'plant') {
      return [
        { id: 'active_freights', title: 'FLETES PENDIENTES' },
        { id: 'show_help', title: 'GUIA COMPLETA' },
      ];
    }
    if (role === 'transporter') {
      return [
        { id: 'active_freights', title: 'MIS ASIGNACIONES' },
        { id: 'show_help', title: 'GUIA COMPLETA' },
      ];
    }
    return [
      { id: 'active_freights', title: 'MIS FLETES' },
      { id: 'create_freight', title: 'CREAR FLETE' },
      { id: 'show_help', title: 'GUIA COMPLETA' },
    ];
  }

  private getRoleHelpSection(role: string): string {
    if (role === 'producer') {
      return (
        `*Funciones de Productor:*\n` +
        `📦 *Crear flete* → decime el grano, toneladas, planta y fecha\n` +
        `   _Ej: "quiero mandar 60 tn de soja a Cargill mañana 8am"_\n` +
        `🌾 *Campos y lotes* → "mostrame mis campos" / "crear campo"\n` +
        `🚛 *Flota propia* → asigna tus camiones al crear\n` +
        `✅ *Confirmar carga* → cuando tu flota carga en origen\n` +
        `📊 *Informes* → "mandame el informe del FLT-XXXX"\n` +
        `🗺️ *Tracking* → "donde esta el FLT-XXXX?"\n` +
        `👥 *Equipo* → "mostrame los usuarios" / "crear chofer"\n\n`
      );
    }
    if (role === 'plant') {
      return (
        `*Funciones de Planta:*\n` +
        `📋 *Ver fletes* → "fletes pendientes" / "mis fletes"\n` +
        `🚛 *Asignar transportista* → "asignar transportista al FLT-XXXX"\n` +
        `✅ *Confirmar recepcion* → cuando el camion llega a planta\n` +
        `📊 *Informes* → "mandame el informe del FLT-XXXX"\n` +
        `🗺️ *Tracking* → "donde esta el FLT-XXXX?"\n` +
        `👥 *Equipo* → "mostrame los usuarios"\n\n`
      );
    }
    if (role === 'transporter') {
      return (
        `*Funciones de Transportista:*\n` +
        `📋 *Ver asignaciones* → "mis fletes" / "fletes asignados"\n` +
        `✅ *Aceptar/rechazar* → cuando te asignan un flete\n` +
        `🚛 *Iniciar viaje* → "iniciar viaje del FLT-XXXX"\n` +
        `📦 *Confirmar carga* → con toneladas reales cargadas\n` +
        `🏁 *Confirmar entrega* → al llegar a destino\n` +
        `📊 *Informes* → "mandame el informe del FLT-XXXX"\n` +
        `👥 *Equipo* → "mis choferes" / "mis camiones"\n\n`
      );
    }
    return (
      `*Funciones disponibles:*\n` +
      `📦 Crear y gestionar fletes\n` +
      `📋 Ver estado de fletes\n` +
      `✅ Confirmar cargas y entregas\n` +
      `📊 Descargar informes PDF\n` +
      `🗺️ Seguimiento en vivo\n\n`
    );
  }

  // ======================== SHOW ACTIVE FREIGHTS ========================

  async showActiveFreights(phone: string, user: any) {
    // Resolve the user's active company — only show freights for that company
    const activeCompanyId = user.activeCompanyId || user.companyId;

    if (!activeCompanyId) {
      await this.wa.sendText(phone, 'No tenes una empresa activa configurada.');
      return;
    }

    // Query freights where the active company participates
    const activeFreights = await this.prisma.freight.findMany({
      where: {
        status: { notIn: ['finished', 'canceled'] },
        OR: [
          { originCompanyId: activeCompanyId },
          { destCompanyId: activeCompanyId },
          {
            assignments: {
              some: {
                transportCompanyId: activeCompanyId,
                status: { in: ['active', 'accepted'] },
              },
            },
          },
          {
            assignments: {
              some: {
                driverId: user.id,
                status: { in: ['active', 'accepted'] },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: {
        items: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (activeFreights.length === 0) {
      await this.wa.sendText(phone, 'No tenes fletes activos en este momento.');
      return;
    }

    // Build list message
    const rows = activeFreights.slice(0, 10).map((f: any) => {
      const grain = f.items?.[0]?.grain || 'Sin grano';
      const tons = f.items?.[0]?.tons || '?';
      const emoji = STATUS_EMOJI[f.status] || '';
      const label = STATUS_LABELS[f.status] || f.status;

      return {
        id: `freight:${f.id}`,
        title: f.code,
        description: `${emoji} ${label} | ${grain} ${tons}tn`,
      };
    });

    await this.wa.sendList(phone,
      `Tenes *${activeFreights.length}* flete${activeFreights.length > 1 ? 's' : ''} activo${activeFreights.length > 1 ? 's' : ''}:\n\n📱 ${APP_URL}`,
      'VER FLETES',
      [{ title: 'FLETES ACTIVOS', rows }],
    );
  }

  // ======================== SHOW FREIGHT BY CODE ========================

  private async showFreightByCode(phone: string, user: any, code: string) {
    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: { id: true },
    });

    if (!freight) {
      await this.wa.sendText(phone, `No se encontro el flete ${code}.`);
      return;
    }

    await this.showFreightDetail(phone, user, freight.id);
  }

  // ======================== SHOW FREIGHT DETAIL =========================

  async showFreightDetail(phone: string, user: any, freightId: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true } },
            truck: { select: { id: true, plate: true } },
          },
        },
      },
    });

    if (!freight) {
      await this.wa.sendText(phone, 'Flete no encontrado.');
      return;
    }

    // Verify access using active company only
    const activeCompanyId = user.activeCompanyId || user.companyId;
    const isDriver = freight.assignments.some(a => a.driverId === user.id);
    const hasAccess =
      activeCompanyId === freight.originCompanyId ||
      activeCompanyId === freight.destCompanyId ||
      freight.assignments.some(a => a.transportCompanyId === activeCompanyId) ||
      isDriver;

    if (!hasAccess) {
      await this.wa.sendText(phone, 'No tenes acceso a este flete con tu empresa activa.');
      return;
    }

    const emoji = STATUS_EMOJI[freight.status] || '';
    const statusLabel = STATUS_LABELS[freight.status] || freight.status;

    // Build detail text
    const items = freight.items.map((i: any) => `${i.grain} ${i.tons}tn`).join(', ');
    const assignment = freight.assignments[0];
    const transportLine = assignment
      ? `🚚 ${assignment.transportCompany?.name || 'Transportista'}${assignment.truck ? ` (${assignment.truck.plate})` : ''}${assignment.driver ? ` - ${assignment.driver.name}` : ''}`
      : '🚚 Sin transportista asignado';

    const loadDate = freight.loadDate
      ? new Date(freight.loadDate).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';

    let text = `*${freight.code}* — ${emoji} ${statusLabel}\n`;
    text += '━━━━━━━━━━━━━━━\n';
    text += `📦 ${items}\n`;
    text += `📍 ${freight.originName || freight.originCompany?.name || 'Origen'} → ${freight.destName || freight.destCompany?.name || 'Destino'}\n`;
    text += `${transportLine}\n`;
    if (loadDate) text += `📅 ${loadDate}${freight.loadTime ? ` ${freight.loadTime}` : ''}\n`;
    if (freight.notes) text += `📝 ${freight.notes}\n`;
    text += `\n📱 Ver en la app: ${APP_URL}/freights/${freight.id}`;

    // Determine pending actions based on user's active company role
    const buttons = this.getActionButtons(freight, user, activeCompanyId);

    if (buttons.length > 0) {
      await this.wa.sendButtons(phone, text, buttons);
    } else {
      await this.wa.sendText(phone, text);
    }
  }

  // ======================== GET ACTION BUTTONS ==========================

  private getActionButtons(freight: any, user: any, activeCompanyId: string) {
    const buttons: { id: string; title: string }[] = [];
    const assignment = freight.assignments?.[0];
    const isOwnFleet = assignment?.transportCompanyId === freight.originCompanyId;

    // Determine user's role in this freight based on active company
    const isOrigin = activeCompanyId === freight.originCompanyId;
    const isDest = activeCompanyId === freight.destCompanyId;
    const isTransporter = assignment && activeCompanyId === assignment.transportCompanyId;
    const isDriver = assignment?.driverId === user.id;
    const isTransporterRole = isTransporter || isDriver || (isOrigin && isOwnFleet);

    switch (freight.status) {
      case 'assigned':
        if (isTransporterRole) {
          buttons.push({ id: `accept:${freight.id}`, title: 'ACEPTAR' });
          buttons.push({ id: `reject:${freight.id}`, title: 'RECHAZAR' });
        }
        break;

      case 'accepted':
        if (isTransporterRole) {
          buttons.push({ id: `start:${freight.id}`, title: 'INICIAR VIAJE' });
        }
        break;

      case 'in_progress':
        if (isTransporterRole) {
          buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
        }
        break;

      case 'loaded':
        if (isTransporterRole && !freight.transporterFinishedConfirmedAt) {
          buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR ENTREGA' });
        }
        if (isDest && !freight.plantFinishedConfirmedAt) {
          buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR RECEPCION' });
        }
        if (isOrigin && !isOwnFleet && !freight.producerLoadedConfirmedAt) {
          buttons.push({ id: `confirm_loaded:${freight.id}`, title: 'CONFIRMAR CARGA' });
        }
        break;
    }

    // Max 3 buttons — trim if needed
    return buttons.slice(0, 3);
  }

  // ======================== USER LOOKUP =================================

  private async findUserByPhone(phone: string): Promise<any | null> {
    const normalized = this.wa.normalizePhone(phone);

    // Try multiple formats
    const variants = [
      normalized,
      '+' + normalized,
      '0' + normalized.slice(3), // 598 → 0xx
    ];

    const user = await this.prisma.user.findFirst({
      where: {
        active: true,
        OR: variants.map(p => ({ phone: p })),
      },
      include: {
        company: { select: { id: true, name: true, type: true, types: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, types: true } } },
        },
      },
    });

    return user;
  }

  // ======================== BUILD SYNTHETIC USER ========================

  buildSyntheticUser(dbUser: any): any {
    // Build a user object compatible with FreightsService methods
    const companyByType = (dbUser.companyByType as any) || {};
    const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];

    // Determine primary company type from memberships
    let companyType = 'unknown';
    let companyId = dbUser.activeCompanyId || dbUser.companyId || '';

    if (userTypes.length > 0) {
      companyType = userTypes[0];
    } else if (dbUser.company?.type) {
      companyType = dbUser.company.type;
    } else if (dbUser.memberships?.length > 0) {
      const firstMembership = dbUser.memberships[0];
      const types = Array.isArray(firstMembership.company?.types) && firstMembership.company.types.length > 0
        ? firstMembership.company.types
        : [firstMembership.company?.type];
      companyType = types[0] || 'unknown';
      companyId = companyId || firstMembership.companyId;
    }

    return {
      sub: dbUser.id,
      role: dbUser.role || 'operator',
      companyId,
      companyType,
      userType: companyType,
      activeCompanyId: dbUser.activeCompanyId,
    };
  }
}
