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

const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.vercel.app';

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
      this.logger.log(`handleMessage type=${type} phone=${phone} payload=${JSON.stringify(payload).slice(0, 150)}`);

      // Mark as read
      this.wa.markRead(waMessageId).catch(() => {});

      // Find user by phone
      const normalized = this.wa.normalizePhone(phone);
      const user = await this.findUserByPhone(phone);

      if (!user) {
        await this.wa.sendText(phone,
          'Este numero no se encuentra registrado en Tolvink.\n\n' +
          `Registrese en la plataforma: ${APP_URL}`,
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
          await this.wa.sendText(phone, '─────────────────────\n  Operacion cancelada\n─────────────────────');
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
      } else if (type === 'image' || type === 'document') {
        await this.handleMedia(phone, user, type, payload);
      } else {
        await this.wa.sendText(phone, 'Actualmente se procesan mensajes de texto, audio, ubicaciones e imagenes/documentos. Escriba "menu" para ver las opciones disponibles.');
      }
    } catch (e) {
      this.logger.error(`handleMessage error for ${phone}: ${e.message}`, e.stack);
      await this.wa.sendText(phone, 'Se produjo un error al procesar su mensaje. Por favor, intente nuevamente.');
    }
  }

  // ======================== TEXT HANDLER =================================

  private async handleText(phone: string, user: any, text: string) {
    const t = text.trim();

    // Edge case: empty or whitespace-only message
    if (!t) return;

    // Fast path: freight code lookup (no AI needed)
    if (/^FLT-\d{4,}$/i.test(t)) {
      await this.showFreightByCode(phone, user, t.toUpperCase());
      return;
    }

    // Greeting / generic message detection — show main menu directly
    // Covers: hola, buenas, buen dia, buenos dias, buenas tardes/noches, que tal, como estas, hey, etc.
    const GREETING_RE = /^(hola|hi|hey|buenas?|buen\s*d[ií]a|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|qu[eé]\s*tal|c[oó]mo\s*(est[aá]s?|and[aá]s?|va)|saludos?|menu|inicio)[\s?!.,]*$/i;
    if (GREETING_RE.test(t)) {
      await this.showMainMenu(phone, user);
      return;
    }

    // Emoji-only or very short messages without active AI session → show menu
    const emojiOnly = /^[\p{Emoji_Presentation}\p{Emoji}\uFE0F\u200D\s]{1,16}$/u.test(t) && !/[a-zA-Z0-9]/.test(t);
    const tooShort = t.length <= 2 && !/^(si|no|ok)$/i.test(t);
    if (emojiOnly || tooShort) {
      // Check for active AI session — if exists, forward to AI for context continuity
      const activeSession = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
        select: { id: true, flowState: true },
      });
      const hasHistory = activeSession && ((activeSession.flowState as any)?.aiMessages?.length > 0);
      if (hasHistory && this.ai.isEnabled()) {
        const msg = emojiOnly ? `[El usuario envio solo emojis: ${t}]` : t;
        await this.handleAiChat(phone, user, msg);
      } else {
        await this.showMainMenu(phone, user);
      }
      return;
    }

    // AI-powered handler for all other text (actual requests/queries)
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

      const result = await this.ai.chat(phone, text, user, session);
      const reply = result.text;
      const buttons = result.buttons;

      // Split long messages (WhatsApp max ~4096 chars per message)
      if (reply.length > 4000) {
        const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
        for (let i = 0; i < chunks.length; i++) {
          // Attach buttons only to the last chunk
          if (i === chunks.length - 1 && buttons?.length) {
            await this.wa.sendButtons(phone, chunks[i], buttons);
          } else {
            await this.wa.sendText(phone, chunks[i]);
          }
        }
      } else if (buttons?.length) {
        await this.wa.sendButtons(phone, reply, buttons);
      } else {
        await this.wa.sendText(phone, reply);
      }
    } catch (e) {
      this.logger.error(`AI chat error: ${e.message}`, e.stack?.slice(0, 300));
      await this.wa.sendText(phone,
        'Se produjo un inconveniente tecnico. Por favor, utilice las opciones del menu.',
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
      await this.wa.sendText(phone, 'El procesamiento de audio no se encuentra disponible. Por favor, envie su mensaje como texto.');
      return;
    }

    try {
      await this.wa.sendText(phone, 'Procesando audio. Aguarde un momento.');

      // Download audio from Meta
      const { buffer, mimeType } = await this.wa.downloadMedia(payload.mediaId);

      // Size check: Whisper API limit is 25MB, WhatsApp max ~16MB
      const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB safety margin
      if (buffer.length > MAX_AUDIO_BYTES) {
        this.logger.warn(`Audio too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB from ${phone}`);
        await this.wa.sendText(phone, 'El audio excede el limite permitido. Por favor, envie un mensaje mas breve (menos de 2 minutos) o escriba como texto.');
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
        await this.wa.sendText(phone, 'No fue posible procesar el audio. Por favor, intente nuevamente o envie un mensaje de texto.');
        return;
      }

      this.logger.log(`Audio transcribed (${buffer.length} bytes): "${text.slice(0, 100)}"`);

      // Tag as audio-sourced so AI knows to handle filler words/noise
      const taggedText = `[Audio transcripto] ${text}`;

      // Pass transcription to AI chat (preprocessing in ai.service strips fillers)
      await this.handleAiChat(phone, user, taggedText);
    } catch (e) {
      this.logger.error(`Audio processing error: ${e.message}`, e.stack?.slice(0, 300));
      await this.wa.sendText(phone, 'No fue posible procesar el audio. Por favor, intente nuevamente o envie un mensaje de texto.');
    }
  }

  // ======================== MEDIA HANDLER (IMAGE / DOCUMENT) =============

  private async handleMedia(phone: string, user: any, type: string, payload: any) {
    try {
      const { mediaId, mimeType } = payload;
      const filename = payload.filename || '';
      const caption = payload.caption || '';

      // 1. Download from Meta API
      const { buffer } = await this.wa.downloadMedia(mediaId);
      this.logger.log(`Media downloaded: type=${type}, mime=${mimeType}, size=${buffer.length}`);

      // Size guard (16 MB WhatsApp limit)
      if (buffer.length > 16 * 1024 * 1024) {
        await this.wa.sendText(phone, 'El archivo es demasiado grande. El limite es 16 MB.');
        return;
      }

      // 2. Upload to Supabase Storage
      const extMap: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
        'application/pdf': '.pdf', 'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
      };
      // Strict MIME allowlist
      const ALLOWED_MIMES = new Set(Object.keys(extMap));
      if (!ALLOWED_MIMES.has(mimeType)) {
        await this.wa.sendText(phone, 'Tipo de archivo no admitido. Se aceptan imagenes (JPG, PNG, WebP), PDF y documentos Office.');
        return;
      }
      const ext = extMap[mimeType];
      const storagePath = `whatsapp/${user.id}/${Date.now()}${ext}`;

      const publicUrl = await this.wa.uploadToStorage(buffer, storagePath, mimeType);
      this.logger.log(`Media uploaded to storage: ${publicUrl}`);

      // 3. Determine display name
      const displayName = filename || `${type === 'image' ? 'foto' : 'documento'}${ext}`;
      const docType = type === 'image' ? 'photo' : 'document';

      // 4. Store pendingDocument in AI session
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
          flowState: { ...state, pendingDocument: { url: publicUrl, name: displayName, type: docType } },
        },
      });

      // 5. Forward to AI with context
      const contextMsg = caption
        ? `[El usuario envio ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName}] ${caption}`
        : `[El usuario envio ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName}]`;

      await this.handleAiChat(phone, user, contextMsg);
    } catch (e) {
      this.logger.error(`Media processing error: ${e.message}`, e.stack?.slice(0, 300));
      await this.wa.sendText(phone, 'No fue posible procesar el archivo. Por favor, intente nuevamente.');
    }
  }

  // ======================== BUTTON REPLY HANDLER ========================

  private async handleButtonReply(phone: string, user: any, buttonId: string, title: string) {
    // Button ID format: "action:entityId" or "action:entityId:extra"
    const parts = buttonId.split(':');
    const action = parts[0];
    const entityId = parts[1] || '';

    const synUser = this.buildSyntheticUser(user);

    // Access check for freight actions
    const freightActions = ['accept', 'reject', 'start', 'confirm_loaded', 'confirm_finished', 'cancel'];
    if (freightActions.includes(action) && entityId) {
      const freight = await this.prisma.freight.findUnique({
        where: { id: entityId },
        select: { originCompanyId: true, destCompanyId: true, assignments: { select: { transportCompanyId: true, driverId: true } } },
      }).catch(() => null);
      if (!freight) {
        await this.wa.sendText(phone, 'Flete no encontrado.');
        return;
      }
      const activeCoId = user.activeCompanyId || user.companyId;
      const canAccess = activeCoId === freight.originCompanyId || activeCoId === freight.destCompanyId
        || freight.assignments.some(a => a.transportCompanyId === activeCoId || a.driverId === user.id);
      if (!canAccess) {
        await this.wa.sendText(phone, 'No tiene acceso a este flete.');
        return;
      }
    }

    try {
      switch (action) {
        case 'accept': {
          await this.freights.respond(entityId, { action: 'accepted' } as any, synUser);
          await this.wa.sendText(phone, '─────────────────────\n  Flete aceptado\n─────────────────────');
          break;
        }
        case 'reject': {
          // Start reject flow (needs reason)
          await this.flow.startFlow('reject_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'start': {
          await this.freights.start(entityId, synUser);
          await this.wa.sendText(phone, '─────────────────────\n  Viaje iniciado\n─────────────────────');
          break;
        }
        case 'confirm_loaded': {
          // Start loaded flow (needs tons)
          await this.flow.startFlow('confirm_loaded', phone, user, { freightId: entityId });
          break;
        }
        case 'confirm_finished': {
          await this.freights.confirmFinished(entityId, synUser);
          await this.wa.sendText(phone, '─────────────────────\n  Entrega confirmada\n─────────────────────');
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
        case 'location_done': {
          // User pressed "UBICACION LISTA" → forward to AI so it picks up the saved location
          await this.handleAiChat(phone, user, 'Ubicacion confirmada.');
          break;
        }
        case 'ai_confirm_freight': {
          // User pressed "CONFIRMAR" on freight summary → forward to AI as confirmation
          await this.handleAiChat(phone, user, 'Confirmar.');
          break;
        }
        case 'ai_cancel_freight': {
          // User pressed "CANCELAR" on freight summary → forward to AI
          await this.handleAiChat(phone, user, 'No, cancelar.');
          break;
        }
        case 'ai_confirm': {
          // Generic confirmation for any staged AI action
          await this.handleAiChat(phone, user, 'Confirmar.');
          break;
        }
        case 'ai_cancel': {
          // Generic cancellation for any staged AI action
          await this.handleAiChat(phone, user, 'No, cancelar.');
          break;
        }
        default: {
          await this.wa.sendText(phone, 'Accion no reconocida. Escriba "menu" para ver las opciones disponibles.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${e.message}`, e.stack);
      const userMessage = e.status === 400 || e.response?.statusCode === 400
        ? e.message
        : 'Ocurrio un error procesando su solicitud. Intente nuevamente.';
      await this.wa.sendText(phone, userMessage);
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
    const name = user.name || 'Usuario';
    const role = this.getUserRole(user);
    const companyName = user.company?.name || '';
    const roleLabel = role === 'producer' ? 'Productor' : role === 'plant' ? 'Planta' : role === 'transporter' ? 'Transportista' : '';

    const userLine = `${name}` +
      (companyName ? `  ·  ${companyName}` : '') +
      (roleLabel ? `  ·  ${roleLabel}` : '');

    const header =
      `T O L V I N K\n` +
      `─────────────────────\n` +
      `${userLine}\n` +
      `─────────────────────\n\n`;

    const features = this.getRoleFeatureSummary(role);

    await this.wa.sendButtons(phone,
      header + features +
      `\nEnvie un mensaje de texto o un audio con su pedido, o seleccione una opcion.`,
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const role = this.getUserRole(user);

    const header =
      `GUIA DE USO\n` +
      `─────────────────────\n\n`;

    const body =
      `Enviando un mensaje de texto o audio puede realizar las gestiones que tenga habilitadas. ` +
      `Comience la conversacion y Tolvink lo ayudara.\n\n`;

    const roleSection = this.getRoleHelpSection(role);

    const footer =
      `─────────────────────\n` +
      `Plataforma web:\n${APP_URL}`;

    await this.wa.sendText(phone, header + body + roleSection + footer);

    await this.wa.sendButtons(phone,
      'Seleccione una opcion:',
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
        `Funciones disponibles\n\n` +
        `  ▸ Crear fletes\n` +
        `  ▸ Gestionar flota propia\n` +
        `  ▸ Consultar estado en tiempo real\n` +
        `  ▸ Confirmar cargas\n` +
        `  ▸ Seguimiento en vivo\n` +
        `  ▸ Informes PDF\n` +
        `  ▸ Campos y lotes\n` +
        `  ▸ Equipo\n`
      );
    }
    if (role === 'plant') {
      return (
        `Funciones disponibles\n\n` +
        `  ▸ Fletes pendientes de asignacion\n` +
        `  ▸ Asignar transportistas\n` +
        `  ▸ Confirmar recepciones y entregas\n` +
        `  ▸ Seguimiento en vivo\n` +
        `  ▸ Informes PDF\n` +
        `  ▸ Equipo\n`
      );
    }
    if (role === 'transporter') {
      return (
        `Funciones disponibles\n\n` +
        `  ▸ Fletes asignados\n` +
        `  ▸ Aceptar o rechazar asignaciones\n` +
        `  ▸ Iniciar viajes\n` +
        `  ▸ Confirmar carga y entrega\n` +
        `  ▸ Seguimiento en vivo\n` +
        `  ▸ Informes PDF\n` +
        `  ▸ Choferes y camiones\n`
      );
    }
    return (
      `Funciones disponibles\n\n` +
      `  ▸ Crear y gestionar fletes\n` +
      `  ▸ Consultar estado\n` +
      `  ▸ Confirmar cargas y entregas\n` +
      `  ▸ Seguimiento en vivo\n` +
      `  ▸ Informes PDF\n`
    );
  }

  private getRoleMenuButtons(role: string): Array<{ id: string; title: string }> {
    if (role === 'producer') {
      return [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'SOLICITAR FLETE' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    if (role === 'plant') {
      return [
        { id: 'active_freights', title: 'FLETES PENDIENTES' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    if (role === 'transporter') {
      return [
        { id: 'active_freights', title: 'MIS ASIGNACIONES' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    return [
      { id: 'active_freights', title: 'MIS FLETES' },
      { id: 'create_freight', title: 'SOLICITAR FLETE' },
      { id: 'show_help', title: 'GUIA DE USO' },
    ];
  }

  private getRoleHelpSection(role: string): string {
    if (role === 'producer') {
      return (
        `Productor\n\n` +
        `  ▸ Crear fletes indicando grano, toneladas, planta y fecha\n` +
        `  ▸ Administrar campos y lotes\n` +
        `  ▸ Gestionar flota propia y asignar camiones\n` +
        `  ▸ Confirmar cargas de flota propia\n` +
        `  ▸ Solicitar informes PDF\n` +
        `  ▸ Seguimiento en vivo de unidades\n` +
        `  ▸ Gestionar equipo y choferes\n\n`
      );
    }
    if (role === 'plant') {
      return (
        `Planta\n\n` +
        `  ▸ Consultar fletes pendientes de asignacion\n` +
        `  ▸ Asignar transportistas a fletes\n` +
        `  ▸ Confirmar recepcion y entrega de cargas\n` +
        `  ▸ Solicitar informes PDF\n` +
        `  ▸ Seguimiento en vivo de unidades\n` +
        `  ▸ Gestionar equipo\n\n`
      );
    }
    if (role === 'transporter') {
      return (
        `Transportista\n\n` +
        `  ▸ Consultar asignaciones y fletes\n` +
        `  ▸ Aceptar o rechazar asignaciones\n` +
        `  ▸ Iniciar viajes\n` +
        `  ▸ Confirmar carga con toneladas reales\n` +
        `  ▸ Confirmar entrega en destino\n` +
        `  ▸ Solicitar informes PDF\n` +
        `  ▸ Gestionar choferes y camiones\n\n`
      );
    }
    return (
      `Funciones habilitadas\n\n` +
      `  ▸ Crear y gestionar fletes\n` +
      `  ▸ Consultar estado de fletes\n` +
      `  ▸ Confirmar cargas y entregas\n` +
      `  ▸ Informes PDF\n` +
      `  ▸ Seguimiento en vivo\n\n`
    );
  }

  // ======================== SHOW ACTIVE FREIGHTS ========================

  async showActiveFreights(phone: string, user: any) {
    // Resolve the user's active company — only show freights for that company
    const activeCompanyId = user.activeCompanyId || user.companyId;

    if (!activeCompanyId) {
      await this.wa.sendText(phone, 'No se encontro una empresa activa asociada a su cuenta.');
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
      await this.wa.sendText(phone, 'No se registran fletes activos en este momento.');
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
      `${activeFreights.length} flete${activeFreights.length > 1 ? 's' : ''} activo${activeFreights.length > 1 ? 's' : ''}\n─────────────────────\nSeleccione uno para ver el detalle.`,
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
      await this.wa.sendText(phone, 'No dispone de acceso a este flete con su empresa activa.');
      return;
    }

    // Ensure shareToken exists for public tracking link (after access check)
    if (!freight.shareToken) {
      const token = require('crypto').randomUUID();
      await this.prisma.freight.update({ where: { id: freightId }, data: { shareToken: token } });
      (freight as any).shareToken = token;
    }

    const statusLabel = STATUS_LABELS[freight.status] || freight.status;

    // Build detail text
    const items = freight.items.map((i: any) => `${i.grain}  ·  ${i.tons} tn`).join(', ');
    const assignment = freight.assignments[0];
    const transportLine = assignment
      ? `${assignment.transportCompany?.name || 'Transportista'}${assignment.truck ? ` (${assignment.truck.plate})` : ''}${assignment.driver ? `  ·  ${assignment.driver.name}` : ''}`
      : 'Sin transportista asignado';

    const loadDate = freight.loadDate
      ? new Date(freight.loadDate).toLocaleDateString('es-UY', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '';

    let text = `${freight.code}  ·  ${statusLabel}\n`;
    text += `─────────────────────\n`;
    text += `Carga: ${items}\n`;
    text += `Origen: ${freight.originName || freight.originCompany?.name || '–'}\n`;
    text += `Destino: ${freight.destName || freight.destCompany?.name || '–'}\n`;
    text += `Transporte: ${transportLine}\n`;
    if (loadDate) text += `Fecha: ${loadDate}${freight.loadTime ? `  ${freight.loadTime}` : ''}\n`;
    if (freight.notes) text += `Obs: ${freight.notes}\n`;
    text += `─────────────────────\n`;
    text += `${APP_URL}/track?token=${freight.shareToken}`;

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
        company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } } },
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
    let companyId = dbUser.activeCompanyId || dbUser.companyId || null;

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
