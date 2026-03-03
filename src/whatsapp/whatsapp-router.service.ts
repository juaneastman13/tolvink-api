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
import { buildSyntheticUser as buildSyntheticUserHelper } from '../common/build-synthetic-user';
import { SelectionItem, resolveSelectionReply } from '../common/selection-helpers';
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

const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';

@Injectable()
export class WhatsAppRouterService {
  private readonly logger = new Logger(WhatsAppRouterService.name);
  private openai: OpenAI | null = null;
  /** Per-user GPS write cooldown — max 1 location save per 30s */
  private gpsWriteCooldowns = new Map<string, number>();
  /** In-memory TTL cache for freight counts per company (60s) */
  private freightCountsCache = new Map<string, { data: Record<string, number>; ts: number }>();
  private readonly COUNTS_TTL = 60_000;
  /**
   * Per-phone processing lock — ensures sequential message handling per user.
   * SCALING NOTE: In-memory only. Does NOT synchronize across multiple instances.
   * If horizontal scaling is needed, replace with Redis-based distributed lock.
   */
  private phoneLocks = new Map<string, Promise<void>>();
  private readonly MAX_PHONE_LOCKS = 10000;
  /** Cooldown for "not registered" replies — avoids spamming unregistered phones */
  private unregisteredCooldown = new Map<string, number>();

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
    // Serialize per phone — prevents concurrent AI/session races for same user
    // Safety: evict oldest entries if map grows too large (leak protection)
    if (this.phoneLocks.size > this.MAX_PHONE_LOCKS) {
      const first = this.phoneLocks.keys().next().value;
      if (first) this.phoneLocks.delete(first);
    }
    const prev = this.phoneLocks.get(phone) || Promise.resolve();
    let unlock: () => void;
    const lock = new Promise<void>(r => unlock = r);
    this.phoneLocks.set(phone, lock);
    await prev;
    try {
      return await this._handleMessage(phone, type, payload, waMessageId);
    } finally {
      unlock!();
      if (this.phoneLocks.get(phone) === lock) this.phoneLocks.delete(phone);
    }
  }

  private async _handleMessage(phone: string, type: string, payload: any, waMessageId: string) {
    try {
      this.logger.log(`handleMessage type=${type} phone=${phone} payload=${JSON.stringify(payload).slice(0, 150)}`);

      // Mark as read
      this.wa.markRead(waMessageId).catch(e => this.logger.warn(e.message));

      // Find user by phone
      const user = await this.findUserByPhone(phone);

      if (!user) {
        // Cooldown: only send "not registered" once per 10 minutes per phone
        const lastSent = this.unregisteredCooldown.get(phone);
        if (!lastSent || Date.now() - lastSent > 10 * 60 * 1000) {
          this.unregisteredCooldown.set(phone, Date.now());
          await this.wa.sendText(phone,
            'Este número no se encuentra registrado en Tolvink.\n\n' +
            `Regístrese en la plataforma: ${APP_URL}`,
          );
          // Prune stale cooldown entries
          if (this.unregisteredCooldown.size > 500) {
            const now = Date.now();
            for (const [k, v] of this.unregisteredCooldown) {
              if (now - v > 10 * 60 * 1000) this.unregisteredCooldown.delete(k);
            }
          }
        }
        return;
      }

      // Load session ONCE at the top — reused by multi-company check, flow check, and sub-handlers
      let cachedSession = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });

      // Multi-company: prompt company selection if not confirmed in session
      const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
      if (activeMemberships.length > 1) {
        const sState = (cachedSession?.flowState as any) || {};
        const dbCompanyId = user.activeCompanyId || user.companyId;
        const isConfirmed = sState.companyConfirmed === true
          && sState.selectedCompanyId
          && sState.selectedCompanyId === dbCompanyId;

        if (!isConfirmed) {
          // Let company selection list replies through
          if (type === 'list_reply' && payload.id?.startsWith('selco:')) {
            await this.handleCompanySelection(phone, user, payload.id.split(':').slice(1).join(':'));
            return;
          }
          // Handle numeric/text reply for company selection (>10 companies)
          if (type === 'text' && sState.selectionContext?.purpose === 'company_selection') {
            const resolved = resolveSelectionReply(payload.body?.trim() || '', sState.selectionContext);
            if (resolved === 'next_page' || resolved === 'prev_page') {
              await this.handleSelectionPagination(phone, user, cachedSession!, sState, resolved);
              return;
            }
            if (resolved && typeof resolved === 'object' && resolved.id.startsWith('selco:')) {
              await this.handleCompanySelection(phone, user, resolved.id.replace('selco:', ''));
              return;
            }
          }
          // Save original message/action so it can be replayed after company confirmation
          const GREETING_RE_MC = /^(hola|hi|hey|buenas?|buen\s*d[ií]a|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|qu[eé]\s*tal|c[oó]mo\s*(est[aá]s?|and[aá]s?|va)|saludos?|menu|inicio)[\s?!.,]*$/i;
          const textBody = type === 'text' ? (payload.body || '').trim() : '';
          const isOperational = textBody && !GREETING_RE_MC.test(textBody);
          // Save button/list actions as _pendingAction
          const isButtonAction = type === 'button_reply' && payload.id;
          const pendingData: any = {};
          if (isOperational) pendingData._pendingMessage = textBody;
          if (isButtonAction) pendingData._pendingAction = { id: payload.id, title: payload.title };
          if (Object.keys(pendingData).length > 0 && cachedSession) {
            this.logger.log(`[MultiCo] Saving _pendingMessage="${pendingData._pendingMessage || ''}" to session ${cachedSession.id}`);
            await this.prisma.whatsAppSession.update({
              where: { id: cachedSession.id },
              data: { flowState: { ...sState, ...pendingData } },
            });
          } else if (Object.keys(pendingData).length > 0) {
            this.logger.log(`[MultiCo] Creating session with _pendingMessage="${pendingData._pendingMessage || ''}"`);
            await this.prisma.whatsAppSession.create({
              data: {
                userId: user.id, phone: this.wa.normalizePhone(phone),
                flowType: null, flowStep: '0',
                flowState: pendingData,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
              },
            });
          } else {
            this.logger.log(`[MultiCo] No pending data to save — type=${type} textBody="${type === 'text' ? (payload.body || '').trim() : ''}" isOperational=${isOperational}`);
          }
          await this.sendCompanySelectionList(phone, user);
          return;
        }
      }

      // Check for active flow (reuse cached session)
      const session = cachedSession;

      if (session?.flowType) {
        // Handle cancel/menu command inside any flow
        const cmd = type === 'text' ? payload.body?.trim().toLowerCase() : '';
        if (/^(cancelar|salir|exit|cancel)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.wa.sendText(phone, '❌ Operación cancelada.');
          await this.showMainMenu(phone, user);
          return;
        }
        if (/^(menu|inicio|hola)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.showMainMenu(phone, user);
          return;
        }

        // Notification action buttons (accept, reject, confirm_loaded, etc.) override active flow
        if (type === 'button_reply' && payload.id && /^(accept|reject|confirm_loaded|confirm_finished|detail):/.test(payload.id)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.handleButtonReply(phone, user, payload.id, payload.title);
          return;
        }

        await this.flow.continueFlow(session, type, payload, phone, user);
        return;
      }

      // Route by message type — pass cached session to avoid redundant DB lookups
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
        await this.handleText(phone, user, textBody, session);
      } else if (type === 'location') {
        await this.handleLocation(phone, user, payload, session);
      } else if (type === 'audio') {
        await this.handleAudio(phone, user, payload);
      } else if (type === 'image' || type === 'document') {
        await this.handleMedia(phone, user, type, payload, session);
      } else {
        await this.wa.sendText(phone, 'Actualmente se procesan mensajes de texto, audio, ubicaciones e imagenes/documentos. Escriba "menu" para ver las opciones disponibles.');
      }
    } catch (e) {
      this.logger.error(`handleMessage error for ${phone}: ${e.message}`, e.stack);
      await this.wa.sendText(phone, 'Se produjo un error al procesar su mensaje. Por favor, intente nuevamente.');
    }
  }

  // ======================== TEXT HANDLER =================================

  private async handleText(phone: string, user: any, text: string, cachedSession?: any) {
    const t = text.trim();

    // Edge case: empty or whitespace-only message
    if (!t) return;

    // Safety: cap extremely long messages before processing
    if (t.length > 10_000) {
      await this.wa.sendText(phone, 'Mensaje demasiado largo. Máximo 10.000 caracteres.');
      return;
    }

    // ---- Check for active selection context (numbered text reply) ----
    // Reuse cached session if available and matches (no flowType, not expired)
    const selSession = (cachedSession && !cachedSession.flowType && cachedSession.expiresAt > new Date())
      ? cachedSession
      : await this.prisma.whatsAppSession.findFirst({
          where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
          orderBy: { updatedAt: 'desc' },
        });
    if (selSession) {
      const selState = (selSession.flowState as any) || {};
      if (selState.selectionContext) {
        const resolved = resolveSelectionReply(t, selState.selectionContext);
        if (resolved === 'next_page' || resolved === 'prev_page') {
          await this.handleSelectionPagination(phone, user, selSession, selState, resolved);
          return;
        }
        if (resolved && typeof resolved === 'object') {
          // Clear selection context + dispatch
          const { selectionContext, ...cleanState } = selState;
          await this.prisma.whatsAppSession.update({
            where: { id: selSession.id },
            data: { flowState: cleanState },
          });
          await this.dispatchSelectionResult(phone, user, resolved, selectionContext.purpose);
          return;
        }
        // Not a selection reply — clear stale context, fall through
        const { selectionContext, ...cleanState } = selState;
        await this.prisma.whatsAppSession.update({
          where: { id: selSession.id },
          data: { flowState: cleanState },
        });
      }
    }

    // Fast path: freight code lookup (no AI needed)
    if (/^(FLT-\d{4,}|F\d{2}-[A-Z]{3}\.\d{4})$/i.test(t)) {
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
      // Check for active AI session — reuse cached session if available
      const activeSession = selSession || cachedSession;
      const hasHistory = activeSession && !activeSession.flowType && ((activeSession.flowState as any)?.aiMessages?.length > 0);
      if (hasHistory && this.ai.isEnabled()) {
        const msg = emojiOnly ? `[El usuario envió solo emojis: ${t}]` : t;
        await this.handleAiChat(phone, user, msg, cachedSession);
      } else {
        await this.showMainMenu(phone, user);
      }
      return;
    }

    // AI-powered handler for all other text (actual requests/queries)
    if (this.ai.isEnabled()) {
      await this.handleAiChat(phone, user, t, cachedSession);
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

  private async handleAiChat(phone: string, user: any, text: string, cachedSession?: any) {
    try {
      // Reuse cached session if it's a valid AI session (no flowType, not expired)
      let session = (cachedSession && !cachedSession.flowType && cachedSession.expiresAt > new Date())
        ? cachedSession
        : await this.prisma.whatsAppSession.findFirst({
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

      // Check for pending selection (set by AI tools like switch_company)
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};
      if (latestState._pendingSelection) {
        const { _pendingSelection, ...cleanState } = latestState;
        const selResult = await this.wa.sendSelection(phone, _pendingSelection.items, _pendingSelection.config);

        // Store selection context for numeric reply resolution
        const selCtx: any = {
          items: _pendingSelection.items,
          shownItems: selResult.shownItems,
          page: selResult.page,
          totalPages: selResult.totalPages,
          pageSize: 20,
          purpose: _pendingSelection.purpose,
          config: _pendingSelection.config,
        };
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { flowState: { ...cleanState, selectionContext: selCtx } },
        });
        return;
      }

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
        'Se produjo un inconveniente técnico. Por favor, utilice las opciones del menú.',
      );
      await this.showMainMenu(phone, user);
    }
  }

  // ======================== LOCATION HANDLER ==============================

  private async handleLocation(phone: string, user: any, payload: any, cachedSession?: any) {
    const { latitude, longitude, name, address } = payload;

    // Validate coordinate bounds before processing
    if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
        !isFinite(latitude) || !isFinite(longitude)) {
      this.logger.warn(`Invalid coordinates from ${phone}: lat=${latitude}, lng=${longitude}`);
      return;
    }

    // Reuse cached session if it's a valid AI session (no flowType, not expired)
    let session = (cachedSession && !cachedSession.flowType && cachedSession.expiresAt > new Date())
      ? cachedSession
      : await this.prisma.whatsAppSession.findFirst({
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

    // GPS tracking: save position to FreightTracking for any active freight the user is involved in
    this.saveLocationToActiveFreights(user, latitude, longitude).catch(async (err) => {
      this.logger.error(`GPS tracking save failed: ${err.message}`);
      await this.wa.sendText(phone, 'No se pudo guardar su ubicación. Intente enviarla de nuevo.').catch(() => {});
    });

    // Forward as text to AI so Claude knows the user shared a location
    const locationDesc = name || address || `${latitude}, ${longitude}`;
    const textForAi = `[Ubicación compartida: ${locationDesc} (lat: ${latitude}, lng: ${longitude})]`;
    await this.handleAiChat(phone, user, textForAi);
  }

  // Save GPS to FreightTracking for all active freights the user is involved in
  private async saveLocationToActiveFreights(user: any, lat: number, lng: number): Promise<void> {
    // Rate limit: max 1 GPS save per user per 30 seconds
    const now = Date.now();
    const lastWrite = this.gpsWriteCooldowns.get(user.id) || 0;
    if (now - lastWrite < 30_000) {
      this.logger.debug(`GPS throttled for user ${user.id} (${Math.round((30_000 - (now - lastWrite)) / 1000)}s remaining)`);
      return;
    }
    this.gpsWriteCooldowns.set(user.id, now);

    // 1) Check if user is a driver with an active in_progress freight
    const driverAssignment = await this.prisma.freightAssignment.findFirst({
      where: { driverId: user.id, status: 'accepted', tripStatus: 'in_progress' },
      select: { freightId: true },
    });
    if (driverAssignment) {
      await this.prisma.freightTracking.create({
        data: { freightId: driverAssignment.freightId, userId: user.id, lat, lng },
      });
      this.logger.log(`GPS tracked for freight ${driverAssignment.freightId} from driver ${user.id}`);
      return;
    }

    // 2) Non-driver: find active freights where user's company is involved
    const userCompanyIds = [
      user.companyId,
      ...((user.memberships || []).filter((m: any) => m.active).map((m: any) => m.companyId)),
    ].filter(Boolean);
    if (userCompanyIds.length === 0) return;

    const activeFreights = await this.prisma.freight.findMany({
      where: {
        status: { in: ['in_progress', 'loaded'] },
        OR: [
          { originCompanyId: { in: userCompanyIds } },
          { destCompanyId: { in: userCompanyIds } },
          { assignments: { some: { transportCompanyId: { in: userCompanyIds }, status: { in: ['active', 'accepted'] } } } },
        ],
      },
      select: { id: true },
      take: 10,
    });

    if (activeFreights.length > 0) {
      await this.prisma.freightTracking.createMany({
        data: activeFreights.map(f => ({ freightId: f.id, userId: user.id, lat, lng })),
      }).catch((err) => this.logger.warn(`Batch GPS write failed for user ${user.id}: ${err.message}`));
      this.logger.log(`GPS tracked for ${activeFreights.length} freight(s) from user ${user.id}`);
    }
  }

  // ======================== LOCATION SAVED (auto-trigger from save-location endpoint) ===

  async onLocationSaved(sessionId: string): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session?.phone) {
      this.logger.warn(`onLocationSaved: session ${sessionId} not found or missing phone`);
      return;
    }

    const user = await this.findUserByPhone(session.phone);
    if (!user) {
      this.logger.warn(`onLocationSaved: user not found for phone ${session.phone}`);
      return;
    }

    const state = (session.flowState as any) || {};
    const loc = state.lastLocation;
    if (!loc) return;

    // If in active flow → location is already saved in flowState.lastLocation
    // Don't auto-advance; user presses "UBICACIÓN LISTA" button to continue
    if (session.flowType) {
      await this.wa.sendText(session.phone,
        '📍 Ubicación registrada. Presione el botón "UBICACIÓN LISTA" para continuar.',
      );
      return;
    }

    // AI path: existing behavior
    const desc = loc.address || loc.name || `${loc.lat}, ${loc.lng}`;
    const textForAi = `[Ubicación confirmada desde el mapa: ${desc} (lat: ${loc.lat}, lng: ${loc.lng})]`;
    await this.handleAiChat(session.phone, user, textForAi);
  }

  // ======================== AUDIO HANDLER =================================

  private async handleAudio(phone: string, user: any, payload: any) {
    if (!this.openai) {
      await this.wa.sendText(phone, 'El procesamiento de audio no se encuentra disponible. Por favor, envíe su mensaje como texto.');
      return;
    }

    try {
      await this.wa.sendText(phone, 'Procesando audio. Aguarde un momento.');

      // Download audio from Meta
      const { buffer, mimeType } = await this.wa.downloadMedia(payload.mediaId);

      // MIME type validation — only accept audio formats
      if (!mimeType.startsWith('audio/')) {
        this.logger.warn(`Non-audio MIME from ${phone}: ${mimeType}`);
        await this.wa.sendText(phone, 'El archivo no es un audio válido. Por favor, envíe un mensaje de voz.');
        return;
      }

      // Size check: Whisper API limit is 25MB, WhatsApp max ~16MB
      const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB safety margin
      if (buffer.length > MAX_AUDIO_BYTES) {
        this.logger.warn(`Audio too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB from ${phone}`);
        await this.wa.sendText(phone, 'El audio excede el límite permitido. Por favor, envíe un mensaje más breve (menos de 2 minutos) o escriba como texto.');
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
        await this.wa.sendText(phone, 'No fue posible procesar el audio. Por favor, intente nuevamente o envíe un mensaje de texto.');
        return;
      }

      this.logger.log(`Audio transcribed (${buffer.length} bytes): "${text.slice(0, 100)}"`);

      // Tag as audio-sourced so AI knows to handle filler words/noise
      const taggedText = `[Audio transcripto] ${text}`;

      // Pass transcription to AI chat (preprocessing in ai.service strips fillers)
      await this.handleAiChat(phone, user, taggedText);
    } catch (e) {
      this.logger.error(`Audio processing error: ${e.message}`, e.stack?.slice(0, 300));
      await this.wa.sendText(phone, 'No fue posible procesar el audio. Por favor, intente nuevamente o envíe un mensaje de texto.');
    }
  }

  // ======================== MEDIA HANDLER (IMAGE / DOCUMENT) =============

  private async handleMedia(phone: string, user: any, type: string, payload: any, cachedSession?: any) {
    try {
      const { mediaId, mimeType } = payload;
      const filename = payload.filename || '';
      const caption = payload.caption || '';

      // 1. Download from Meta API
      const { buffer } = await this.wa.downloadMedia(mediaId);
      this.logger.log(`Media downloaded: type=${type}, mime=${mimeType}, size=${buffer.length}`);

      // Size guard (16 MB WhatsApp limit)
      if (buffer.length > 16 * 1024 * 1024) {
        await this.wa.sendText(phone, 'El archivo es demasiado grande. El límite es 16 MB.');
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
        await this.wa.sendText(phone, 'Tipo de archivo no admitido. Se aceptan imágenes (JPG, PNG, WebP), PDF y documentos Office.');
        return;
      }
      const ext = extMap[mimeType];
      const storagePath = `whatsapp/${user.id}/${Date.now()}${ext}`;

      const publicUrl = await this.wa.uploadToStorage(buffer, storagePath, mimeType);
      this.logger.log(`Media uploaded to storage: ${publicUrl}`);

      // 3. Determine display name
      const displayName = filename || `${type === 'image' ? 'foto' : 'documento'}${ext}`;
      const docType = type === 'image' ? 'photo' : 'document';

      // 4. Store pendingDocument in AI session — reuse cached session if valid
      let session = (cachedSession && !cachedSession.flowType && cachedSession.expiresAt > new Date())
        ? cachedSession
        : await this.prisma.whatsAppSession.findFirst({
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
        ? `[El usuario envió ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName}] ${caption}`
        : `[El usuario envió ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName}]`;

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
      }).catch(e => { this.logger.warn(e.message); return null; });
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
          await this.wa.sendText(phone, '✅ Flete aceptado.');
          break;
        }
        case 'reject': {
          // Start reject flow (needs reason)
          await this.flow.startFlow('reject_freight', phone, user, { freightId: entityId });
          break;
        }
        case 'start': {
          await this.freights.start(entityId, synUser);
          await this.wa.sendText(phone, '🚛 Viaje iniciado.');
          break;
        }
        case 'confirm_loaded': {
          // Start loaded flow (needs tons)
          await this.flow.startFlow('confirm_loaded', phone, user, { freightId: entityId });
          break;
        }
        case 'confirm_finished': {
          await this.freights.confirmFinished(entityId, synUser);
          await this.wa.sendText(phone, '✅ Entrega confirmada.');
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
          await this.handleAiChat(phone, user, 'Ubicación confirmada.');
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
          await this.wa.sendText(phone, 'Acción no reconocida. Escriba "menu" para ver las opciones disponibles.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${e.message}`, e.stack);
      // H2: Sanitize error messages — only pass safe business errors
      const raw = String(e.message || '');
      const isSafe400 = (e.status === 400 || e.response?.statusCode === 400)
        && /no encontrad|no se puede|debe|requiere|invalido|ya.*asignad/i.test(raw);
      const userMessage = isSafe400
        ? raw.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ.,;:()!?¿¡\-]/g, '').trim().slice(0, 200)
        : 'Ocurrió un error procesando su solicitud. Intente nuevamente.';
      await this.wa.sendText(phone, userMessage || 'Ocurrió un error procesando su solicitud.');
    }
  }

  // ======================== LIST REPLY HANDLER ==========================

  private async handleListReply(phone: string, user: any, listId: string, title: string) {
    // Pagination: "Mostrar más" from any selection list
    if (listId === '__show_more__') {
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });
      const state = (session?.flowState as any) || {};
      if (state.selectionContext) {
        await this.handleSelectionPagination(phone, user, session, state, 'next_page');
        return;
      }
    }

    const parts = listId.split(':');
    const type = parts[0];
    const id = parts.slice(1).join(':');

    if (type === 'selco') {
      await this.handleCompanySelection(phone, user, id);
    } else if (type === 'freight') {
      await this.showFreightDetail(phone, user, id);
    } else if (['lot', 'field', 'truck', 'transporter', 'user', 'driver', 'plant'].includes(type)) {
      // Generic AI list selection — feed back to AI as synthetic message
      await this.handleAiChat(phone, user, `[Seleccionó: ${title} (id: ${id})]`);
    } else {
      await this.handleButtonReply(phone, user, listId, title);
    }
  }

  // ======================== COMPANY SELECTION (multi-company) ============

  private async sendCompanySelectionList(phone: string, user: any) {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const TYPE_LABELS: Record<string, string> = {
      producer: 'Productor', plant: 'Planta', transporter: 'Transportista',
    };
    const activeId = user.activeCompanyId || user.companyId;
    const items: SelectionItem[] = memberships.map((m: any) => ({
      id: `selco:${m.companyId}`,
      title: (m.company?.name || 'Empresa').slice(0, 24),
      description: ((TYPE_LABELS[m.company?.type] || m.company?.type || '') +
        (m.companyId === activeId ? ' (actual)' : '')).slice(0, 72),
    }));

    const selConfig = {
      headerText: 'Tiene acceso a varias empresas.\nSeleccione con cual desea operar:',
      listButtonLabel: 'Ver empresas',
      sectionTitle: 'Sus empresas',
    };
    const result = await this.wa.sendSelection(phone, items, selConfig);

    if (result.totalPages > 1) {
      // Store selection context in session for pagination
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });
      if (session) {
        const state = (session.flowState as any) || {};
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: {
            flowState: {
              ...state,
              selectionContext: {
                items, shownItems: result.shownItems,
                page: result.page, totalPages: result.totalPages, pageSize: 20,
                purpose: 'company_selection', config: selConfig,
              },
            },
          },
        });
      }
    }
  }

  private async handleCompanySelection(phone: string, user: any, companyId: string) {
    const membership = (user.memberships || []).find(
      (m: any) => m.companyId === companyId && m.active,
    );
    if (!membership) {
      await this.wa.sendText(phone, 'Empresa no válida. Intente de nuevo.');
      await this.sendCompanySelectionList(phone, user);
      return;
    }

    // Update DB (same as web switchCompany — but do NOT invalidate refresh tokens)
    await this.prisma.user.update({
      where: { id: user.id },
      data: { activeCompanyId: companyId, companyId: companyId },
    });

    // Audit log (fire-and-forget)
    this.prisma.auditLog.create({
      data: {
        entityType: 'user', entityId: user.id,
        action: 'switch_company',
        fromValue: user.activeCompanyId || user.companyId || undefined,
        toValue: companyId, userId: user.id,
        metadata: { source: 'whatsapp' },
      },
    }).catch(e => this.logger.warn(`Audit log failed: ${e.message}`));

    // Mark company as confirmed in session
    let session = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    // Invalidate cached freight counts for old & new company
    const oldCoId = user.activeCompanyId || user.companyId;
    if (oldCoId) this.freightCountsCache.delete(oldCoId);
    this.freightCountsCache.delete(companyId);

    const flowData = { companyConfirmed: true, selectedCompanyId: companyId };
    if (session) {
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: { ...((session.flowState as any) || {}), ...flowData } },
      });
    } else {
      await this.prisma.whatsAppSession.create({
        data: {
          userId: user.id, phone: this.wa.normalizePhone(phone),
          flowType: null, flowStep: '0', flowState: flowData,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });
    }

    // Re-load user with updated company
    const updatedUser = await this.findUserByPhone(phone);
    const companyName = membership.company?.name || 'Empresa';
    await this.wa.sendText(phone, `🏢 Operando como: ${companyName}.`);

    // Check for pending message/action saved before company selection
    const freshSess = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    const fs = (freshSess?.flowState as any) || {};
    const pendingAction = fs._pendingAction;
    const pendingMsg = fs._pendingMessage;
    this.logger.log(`[CompanySelection] sessionId=${freshSess?.id} pendingMsg=${pendingMsg || 'NONE'} pendingAction=${pendingAction?.id || 'NONE'} flowStateKeys=${Object.keys(fs).join(',')}`);
    if ((pendingAction || pendingMsg) && updatedUser && freshSess) {
      // Clear pending data
      const { _pendingMessage, _pendingAction, ...cleanFS } = fs;
      await this.prisma.whatsAppSession.update({
        where: { id: freshSess.id },
        data: { flowState: cleanFS },
      });
      // Replay button action or text message
      if (pendingAction) {
        await this.handleButtonReply(phone, updatedUser, pendingAction.id, pendingAction.title);
      } else {
        await this.handleAiChat(phone, updatedUser, pendingMsg, freshSess);
      }
    } else if (updatedUser) {
      await this.showMainMenu(phone, updatedUser);
    }
  }

  // ======================== SELECTION DISPATCH ========================

  private async dispatchSelectionResult(
    phone: string, user: any, item: SelectionItem, purpose: string,
  ) {
    const id = item.id.includes(':') ? item.id.split(':').slice(1).join(':') : item.id;

    switch (purpose) {
      case 'company_selection':
        await this.handleCompanySelection(phone, user, id);
        break;
      case 'freight_selection':
        await this.showFreightDetail(phone, user, id);
        break;
      default:
        // Generic: feed selection back to AI as synthetic user message
        await this.handleAiChat(phone, user, `[Seleccionó: ${item.title} (id: ${id})]`);
    }
  }

  private async handleSelectionPagination(
    phone: string, user: any, session: any, state: any, direction: 'next_page' | 'prev_page',
  ) {
    const ctx = state.selectionContext;
    const newPage = direction === 'next_page' ? ctx.page + 1 : ctx.page - 1;
    if (newPage < 1 || newPage > ctx.totalPages) {
      await this.wa.sendText(phone, 'No hay más páginas.');
      return;
    }
    const result = await this.wa.sendSelection(phone, ctx.items, { ...ctx.config, page: newPage });
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          selectionContext: { ...ctx, page: result.page, shownItems: result.shownItems },
        },
      },
    });
  }

  // ======================== FREIGHT COUNTS (cached) ====================

  private async getFreightCounts(companyId: string): Promise<Record<string, number>> {
    const cached = this.freightCountsCache.get(companyId);
    if (cached && Date.now() - cached.ts < this.COUNTS_TTL) return cached.data;

    const counts = await this.prisma.freight.groupBy({
      by: ['status'],
      where: {
        status: { notIn: ['finished', 'canceled'] },
        OR: [
          { originCompanyId: companyId },
          { destCompanyId: companyId },
          {
            assignments: {
              some: {
                transportCompanyId: companyId,
                status: { in: ['active', 'accepted'] },
              },
            },
          },
        ],
      },
      _count: true,
    });

    const data: Record<string, number> = {};
    for (const c of counts) data[c.status] = c._count;
    this.freightCountsCache.set(companyId, { data, ts: Date.now() });

    // Prune stale entries (>5min)
    for (const [k, v] of this.freightCountsCache) {
      if (Date.now() - v.ts > 300_000) this.freightCountsCache.delete(k);
    }

    return data;
  }

  // ======================== SHOW MAIN MENU ==============================

  async showMainMenu(phone: string, user: any) {
    const role = this.getUserRole(user);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = user.memberships?.find((m: any) => m.companyId === activeCoId);
    const companyName = activeMem?.company?.name || user.company?.name || '';
    const roleLabel = role === 'producer' ? 'Productor' : role === 'plant' ? 'Planta' : role === 'transporter' ? 'Transportista' : '';

    // Freight counts for active company (cached 60s)
    let statsBlock = '';
    if (activeCoId) {
      try {
        const byStatus = await this.getFreightCounts(activeCoId);
        let total = 0;
        for (const v of Object.values(byStatus)) total += v;

        const pendientes = (byStatus['pending_assignment'] || 0);
        const confirmados = (byStatus['assigned'] || 0) + (byStatus['accepted'] || 0);
        const enCurso = (byStatus['in_progress'] || 0) + (byStatus['loaded'] || 0);

        if (total > 0) {
          statsBlock =
            `\n📊 Estado actual de fletes:\n` +
            `🚛 Activos: ${total}\n` +
            (pendientes > 0 ? `⏳ Pendientes: ${pendientes}\n` : '') +
            (confirmados > 0 ? `✅ Confirmados: ${confirmados}\n` : '') +
            (enCurso > 0 ? `🔄 En curso: ${enCurso}\n` : '');
        }
      } catch {
        // Non-critical — show menu without stats
      }
    }

    const header =
      `*Tolvink*\n\n` +
      (companyName ? `🏢 Empresa activa: ${companyName}.\n` : '') +
      (roleLabel ? `👤 Rol: ${roleLabel}.\n` : '');

    const features = this.getRoleFeatureSummary(role);

    await this.wa.sendButtons(phone,
      header + statsBlock + features +
      `\nSiguiente paso: escriba la opcion o describa su pedido.`,
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const role = this.getUserRole(user);

    const header = `GUIA DE USO\n\n`;

    const body =
      `Enviando un mensaje de texto o audio puede realizar las gestiones que tenga habilitadas. ` +
      `Comience la conversacion y Tolvink lo ayudara.\n\n`;

    const roleSection = this.getRoleHelpSection(role);

    const footer = `Plataforma web:\n${APP_URL}`;

    await this.wa.sendText(phone, header + body + roleSection + footer);

    await this.wa.sendButtons(phone,
      'Seleccione una opcion:',
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== ROLE HELPERS ================================

  private getUserRole(user: any): string {
    // Prefer active company's type for multi-company users
    const activeCoId = user.activeCompanyId || user.companyId;
    if (activeCoId && user.memberships?.length > 0) {
      const am = user.memberships.find((m: any) => m.companyId === activeCoId && m.active);
      if (am?.company) {
        const types = Array.isArray(am.company.types) && am.company.types.length > 0
          ? am.company.types : [am.company.type];
        if (types[0]) return types[0];
      }
    }
    // Fallback
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
        `\n📌 Acciones principales:\n` +
        `🚛 Crear flete\n` +
        `📊 Ver fletes del día\n` +
        `🌾 Gestionar campos y lotes\n` +
        `👥 Equipo\n` +
        `📄 Informes\n`
      );
    }
    if (role === 'plant') {
      return (
        `\n📌 Acciones principales:\n` +
        `📋 Fletes pendientes de asignación\n` +
        `🚛 Asignar transportistas\n` +
        `📊 Ver fletes del día\n` +
        `👥 Equipo\n` +
        `📄 Informes\n`
      );
    }
    if (role === 'transporter') {
      return (
        `\n📌 Acciones principales:\n` +
        `📋 Mis asignaciones\n` +
        `🚛 Aceptar o rechazar viajes\n` +
        `📊 Ver fletes del día\n` +
        `👥 Choferes y camiones\n` +
        `📄 Informes\n`
      );
    }
    return (
      `\n📌 Acciones principales:\n` +
      `🚛 Crear y gestionar fletes\n` +
      `📊 Ver fletes del día\n` +
      `👥 Equipo\n` +
      `📄 Informes\n`
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
        `  ▸ Consultar fletes pendientes de asignación\n` +
        `  ▸ Asignar transportistas a fletes\n` +
        `  ▸ Confirmar recepción y entrega de cargas\n` +
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
      await this.wa.sendText(phone, 'No se encontró una empresa activa asociada a su cuenta.');
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
      take: 30,
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

    // Build selection items
    const items: SelectionItem[] = activeFreights.map((f: any) => {
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

    const selConfig = {
      headerText: `🚛 ${activeFreights.length} flete${activeFreights.length > 1 ? 's' : ''} activo${activeFreights.length > 1 ? 's' : ''}.\n\nSeleccione uno para ver el detalle.`,
      listButtonLabel: 'VER FLETES',
      sectionTitle: 'FLETES ACTIVOS',
    };
    const result = await this.wa.sendSelection(phone, items, selConfig);

    if (result.totalPages > 1) {
      // Store selection context in session for pagination
      const session = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });
      if (session) {
        const state = (session.flowState as any) || {};
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: {
            flowState: {
              ...state,
              selectionContext: {
                items, shownItems: result.shownItems,
                page: result.page, totalPages: result.totalPages, pageSize: 20,
                purpose: 'freight_selection', config: selConfig,
              },
            },
          },
        });
      }
    }
  }

  // ======================== SHOW FREIGHT BY CODE ========================

  private async showFreightByCode(phone: string, user: any, code: string) {
    const activeCoId = user.activeCompanyId || user.companyId;
    const freight = await this.prisma.freight.findFirst({
      where: {
        code,
        OR: [
          { originCompanyId: activeCoId },
          { destCompanyId: activeCoId },
          { assignments: { some: { transportCompanyId: activeCoId } } },
        ],
      },
      select: { id: true },
    });

    if (!freight) {
      await this.wa.sendText(phone, `No se encontró el flete ${code}.`);
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

    let text = `🚛 ${freight.code} — ${statusLabel}\n\n`;
    text += `📦 Carga: ${items}\n`;
    text += `📍 Origen: ${freight.originName || freight.originCompany?.name || '–'}\n`;
    text += `📍 Destino: ${freight.destName || freight.destCompany?.name || '–'}\n`;
    text += `👤 Transporte: ${transportLine}\n`;
    if (loadDate) text += `📅 Fecha: ${loadDate}${freight.loadTime ? ` ${freight.loadTime}` : ''}\n`;
    if (freight.notes) text += `📝 Obs: ${freight.notes}\n`;
    text += `\n🗺️ Seguimiento disponible.\n${APP_URL}/${freight.code}/ubicacion?s=${freight.shareToken}`;

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
          buttons.push({ id: `confirm_finished:${freight.id}`, title: 'CONFIRMAR RECEPCIÓN' });
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
    return buildSyntheticUserHelper(dbUser);
  }
}
