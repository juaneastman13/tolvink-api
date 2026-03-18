// =====================================================================
// TOLVINK — WhatsApp Message Router
// Routes incoming WhatsApp messages to appropriate handlers
// =====================================================================

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsService } from '../freights/freights.service';
import { AiService } from '../ai/ai.service';
import { buildSyntheticUser as buildSyntheticUserHelper } from '../common/build-synthetic-user';
import { SelectionItem, resolveSelectionReply } from '../common/selection-helpers';
import OpenAI from 'openai';
import * as crypto from 'crypto';

const STATUS_LABELS: Record<string, string> = {
  draft: 'Borrador',
  pending_assignment: 'Sin asignar',
  assigned: 'Asignado',
  accepted: 'Aceptado',
  in_progress: 'A campo',
  loaded: 'A planta',
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
export class WhatsAppRouterService implements OnModuleInit, OnModuleDestroy {
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
  /** Early per-phone message rate limit — prevents DB query flood before AI rate limit kicks in */
  private messageRate = new Map<string, { count: number; resetAt: number }>();
  /** Periodic cleanup timer for unbounded maps */
  private mapCleanupTimer: ReturnType<typeof setInterval>;

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

  onModuleInit() {
    this.mapCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.gpsWriteCooldowns) {
        if (v < now) this.gpsWriteCooldowns.delete(k);
      }
      for (const [k, v] of this.freightCountsCache) {
        if (now - v.ts > 60_000) this.freightCountsCache.delete(k);
      }
      for (const [k, v] of this.unregisteredCooldown) {
        if (v < now) this.unregisteredCooldown.delete(k);
      }
      for (const [k, v] of this.messageRate) {
        if (now > v.resetAt) this.messageRate.delete(k);
      }
      // phoneLocks: resolved promises are cleaned by their .finally() handlers
    }, 300_000);
  }

  onModuleDestroy() {
    clearInterval(this.mapCleanupTimer);
    this.gpsWriteCooldowns.clear();
    this.freightCountsCache.clear();
    this.phoneLocks.clear();
    this.unregisteredCooldown.clear();
    this.messageRate.clear();
  }

  // ======================== MAIN ENTRY POINT ============================

  async handleMessage(phone: string, type: string, payload: any, waMessageId: string) {
    // Serialize per phone — prevents concurrent AI/session races for same user
    // Safety: reject if pool full (don't evict — could corrupt active sessions)
    if (this.phoneLocks.size >= this.MAX_PHONE_LOCKS) {
      this.logger.warn(`Phone lock pool full (${this.MAX_PHONE_LOCKS}), rejecting message from ${phone.slice(-4)}`);
      return;
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
    // Early per-phone rate limit — 30 msgs/min — prevents DB query flood
    const now = Date.now();
    const rate = this.messageRate.get(phone);
    if (rate && now < rate.resetAt) {
      if (rate.count >= 30) {
        // P2-6: Send feedback instead of silent drop (once per window)
        if (rate.count === 30) {
          this.wa.sendText(phone, 'Estás enviando muchos mensajes. Esperá un momento antes de continuar.')
            .catch(() => {});
        }
        return;
      }
      rate.count++;
    } else {
      this.messageRate.set(phone, { count: 1, resetAt: now + 60_000 });
    }
    // Hard cap on messageRate map
    if (this.messageRate.size > 5000) {
      const first = this.messageRate.keys().next().value;
      if (first) this.messageRate.delete(first);
    }

    try {
      const maskedPhone = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
      const safePayload = type === 'text' ? `text(${(payload?.body?.length || 0)} chars)`
        : type === 'location' ? 'location(lat:***,lng:***)'
        : type === 'image' || type === 'document' || type === 'audio' ? `${type}(file)`
        : type === 'button_reply' || type === 'list_reply' ? `${type}(id:${(payload?.id || '').slice(0, 30)})`
        : type;
      this.logger.log(`handleMessage type=${type} phone=${maskedPhone} payload=${safePayload}`);

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
          // Prune stale cooldown entries + hard cap
          const ucNow = Date.now();
          for (const [k, v] of this.unregisteredCooldown) {
            if (ucNow - v > 10 * 60 * 1000) this.unregisteredCooldown.delete(k);
          }
          if (this.unregisteredCooldown.size > 500) {
            const iter = this.unregisteredCooldown.keys();
            while (this.unregisteredCooldown.size > 400) {
              const k = iter.next().value;
              if (k) this.unregisteredCooldown.delete(k); else break;
            }
          }
        }
        return;
      }

      // Load session ONCE at the top — reused by multi-company check, flow check, and sub-handlers
      // NOTE: Session is cached in `cachedSession` to avoid redundant DB queries within this message lifecycle
      let cachedSession = await this.prisma.whatsAppSession.findFirst({
        where: { userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });

      // Multi-company: prompt company selection if not confirmed in session
      const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
      if (activeMemberships.length > 1) {
        const sState = (cachedSession?.flowState as any) || {};
        // WhatsApp session tracks its own selectedCompanyId independently from the app.
        // Only require re-confirmation if the session has no company selected yet.
        const isConfirmed = sState.companyConfirmed === true
          && sState.selectedCompanyId
          && activeMemberships.some((m: any) => m.companyId === sState.selectedCompanyId);

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
          // Concatenate pending messages instead of overwriting (user may send multiple before selecting company)
          if (isOperational) pendingData._pendingMessage = sState._pendingMessage ? sState._pendingMessage + '\n' + textBody : textBody;
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

      // Extract session-scoped company for use in menus and role resolution
      const sessionCoId = ((cachedSession?.flowState as any) || {}).selectedCompanyId || undefined;

      // Check for active flow (reuse cached session)
      const session = cachedSession;

      if (session?.flowType) {
        // Handle cancel/menu command inside any flow
        const cmd = type === 'text' ? payload.body?.trim().toLowerCase() : '';
        if (/^(cancelar|salir|exit|cancel)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.wa.sendText(phone, '❌ Operación cancelada.');
          await this.showMainMenu(phone, user, sessionCoId);
          return;
        }
        if (/^(menu|inicio|hola)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.showMainMenu(phone, user, sessionCoId);
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
        await this.wa.sendText(phone, 'Actualmente se procesan mensajes de texto, audio, ubicaciones e imágenes/documentos. Escriba "menu" para ver las opciones disponibles.');
      }
    } catch (e) {
      const mp = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
      this.logger.error(`handleMessage error for ${mp}: ${e.message}`, e.stack);
      await this.wa.sendText(phone, 'Se produjo un error al procesar su mensaje. Por favor, intente nuevamente.');
    }
  }

  // ======================== TEXT HANDLER =================================

  private async handleText(phone: string, user: any, text: string, cachedSession?: any) {
    const t = text.trim();
    const sessionCoId = ((cachedSession?.flowState as any) || {}).selectedCompanyId || undefined;

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
      await this.showMainMenu(phone, user, sessionCoId);
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
        await this.showMainMenu(phone, user, sessionCoId);
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
      // Redirect to AI agent for conversational freight creation
      await this.handleAiChat(phone, user, 'Quiero crear un flete');
      return;
    }

    if (/^(ayuda|help)$/i.test(t)) {
      await this.showHelp(phone, user);
      return;
    }

    // Default: show menu
    await this.showMainMenu(phone, user, sessionCoId);
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
        // P1 fix: recover activeContext from the most recently expired session
        let recoveredState: Record<string, any> = {};
        const expiredSession = await this.prisma.whatsAppSession.findFirst({
          where: { userId: user.id, flowType: null, expiresAt: { lte: new Date() } },
          orderBy: { updatedAt: 'desc' },
        });
        if (expiredSession?.flowState) {
          const oldState = expiredSession.flowState as any;
          if (oldState.activeContext) {
            recoveredState._recoveredContext = oldState.activeContext;
            recoveredState._sessionExpiredNote = true;
          }
          // Recover company selection so user doesn't have to re-select after session timeout
          if (oldState.selectedCompanyId && oldState.companyConfirmed) {
            recoveredState.selectedCompanyId = oldState.selectedCompanyId;
            recoveredState.companyConfirmed = true;
          }
        }

        session = await this.prisma.whatsAppSession.create({
          data: {
            userId: user.id,
            phone: this.wa.normalizePhone(phone),
            flowType: null,
            flowStep: '0',
            flowState: recoveredState,
            expiresAt: new Date(Date.now() + 30 * 60 * 1000), // 30 min
          },
        });
      }

      // P2-10: Renew session expiry on every message (sliding window) + warn if was close
      const msLeft = session.expiresAt ? new Date(session.expiresAt).getTime() - Date.now() : Infinity;
      const newExpiry = new Date(Date.now() + 30 * 60 * 1000);
      if (msLeft < 5 * 60 * 1000) {
        // Session was about to expire — renew and log
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { expiresAt: newExpiry },
        });
        session.expiresAt = newExpiry;
      } else if (msLeft < 25 * 60 * 1000) {
        // Silently extend on every interaction
        this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { expiresAt: newExpiry },
        }).catch(() => {});
        session.expiresAt = newExpiry;
      }

      // Show "typing" indicator so user sees the bot is working
      this.wa.sendTypingIndicator(phone).catch(() => {});

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
        // Split on whitespace boundaries to avoid breaking words/emojis
        const chunks: string[] = [];
        let remaining = reply;
        while (remaining.length > 0) {
          if (remaining.length <= 4000) { chunks.push(remaining); break; }
          let splitAt = remaining.lastIndexOf('\n', 4000);
          if (splitAt < 2000) splitAt = remaining.lastIndexOf(' ', 4000);
          if (splitAt < 2000) splitAt = 4000;
          chunks.push(remaining.slice(0, splitAt));
          remaining = remaining.slice(splitAt).trimStart();
        }
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
      const sessCoId = ((cachedSession?.flowState as any) || {}).selectedCompanyId;
      await this.showMainMenu(phone, user, sessCoId);
    }
  }

  // ======================== LOCATION HANDLER ==============================

  private async handleLocation(phone: string, user: any, payload: any, cachedSession?: any) {
    const { latitude, longitude, name, address } = payload;

    // Validate coordinate bounds before processing
    if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 ||
        !isFinite(latitude) || !isFinite(longitude)) {
      const mp = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
      this.logger.warn(`Invalid coordinates from ${mp}`);
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
      // P2002 = duplicate GPS write (race condition) — silently ignore
      if (err?.code === 'P2002') return;
      this.logger.error(`GPS tracking save failed for user ${user.id}: ${err.message}`);
      await this.wa.sendText(phone, 'No se pudo guardar su ubicación. Intente enviarla de nuevo.').catch(() => {});
    });

    // Forward as text to AI so Claude knows the user shared a location (no raw coords — policy)
    const locationDesc = (name || address || 'ubicación').replace(/[\[\]]/g, '').slice(0, 100);
    const textForAi = `[Ubicación compartida: ${locationDesc}]`;
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
    // 1) Check if user is a driver with an active in_progress freight
    const driverAssignment = await this.prisma.freightAssignment.findFirst({
      where: { driverId: user.id, status: 'accepted', tripStatus: 'in_progress' },
      select: { freightId: true },
    });
    if (driverAssignment) {
      await this.prisma.freightTracking.create({
        data: { freightId: driverAssignment.freightId, userId: user.id, lat, lng },
      });
      this.gpsWriteCooldowns.set(user.id, now); // Set after successful write
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
      try {
        await this.prisma.freightTracking.createMany({
          data: activeFreights.map(f => ({ freightId: f.id, userId: user.id, lat, lng })),
        });
        this.gpsWriteCooldowns.set(user.id, now); // Set only after successful write
        this.logger.log(`GPS tracked for ${activeFreights.length} freight(s) from user ${user.id}`);
      } catch (err) {
        this.logger.warn(`Batch GPS write failed for user ${user.id}: ${err.message}`);
      }
    }

    // Periodic cleanup of stale cooldown entries (always prune) + hard cap
    for (const [k, v] of this.gpsWriteCooldowns) {
      if (now - v > 30_000) this.gpsWriteCooldowns.delete(k);
    }
    if (this.gpsWriteCooldowns.size > 5000) {
      const iter = this.gpsWriteCooldowns.keys();
      while (this.gpsWriteCooldowns.size > 4000) {
        const k = iter.next().value;
        if (k) this.gpsWriteCooldowns.delete(k); else break;
      }
    }
  }

  // ======================== LOCATION SAVED (auto-trigger from save-location endpoint) ===

  async onLocationSaved(sessionId: string): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session?.phone) {
      this.logger.warn(`onLocationSaved: session ${sessionId} not found or missing phone`);
      return;
    }
    // Check session expiry
    if (session.expiresAt && session.expiresAt < new Date()) return;

    const user = await this.findUserByPhone(session.phone);
    if (!user) {
      const mp = session.phone?.length > 4 ? '*'.repeat(session.phone.length - 4) + session.phone.slice(-4) : session.phone;
      this.logger.warn(`onLocationSaved: user not found for phone ${mp}`);
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

    // AI path: route through phone lock to prevent race conditions
    const phone = session.phone;
    const prev = this.phoneLocks.get(phone) || Promise.resolve();
    let unlock: () => void;
    const lock = new Promise<void>(r => unlock = r);
    this.phoneLocks.set(phone, lock);
    await prev;
    try {
      const desc = (loc.address || loc.name || 'ubicación').replace(/[\[\]]/g, '').slice(0, 100);
      const textForAi = `[Ubicación confirmada desde el mapa: ${desc}]`;
      await this.handleAiChat(phone, user, textForAi);
    } finally {
      unlock!();
      if (this.phoneLocks.get(phone) === lock) this.phoneLocks.delete(phone);
    }
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
        const mp = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
        this.logger.warn(`Non-audio MIME from ${mp}: ${mimeType}`);
        await this.wa.sendText(phone, 'El archivo no es un audio válido. Por favor, envíe un mensaje de voz.');
        return;
      }

      // Size check: Whisper API limit is 25MB, WhatsApp max ~16MB
      const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB safety margin
      if (buffer.length > MAX_AUDIO_BYTES) {
        const mp2 = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
        this.logger.warn(`Audio too large: ${(buffer.length / 1024 / 1024).toFixed(1)}MB from ${mp2}`);
        await this.wa.sendText(phone, 'El audio excede el límite permitido. Por favor, envíe un mensaje más breve (menos de 2 minutos) o escriba como texto.');
        return;
      }
      if (buffer.length > 10 * 1024 * 1024) {
        const mp3 = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
        this.logger.warn(`Large audio (${(buffer.length / 1024 / 1024).toFixed(1)}MB) from ${mp3}`);
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

      this.logger.log(`Audio transcribed (${buffer.length} bytes, ${text.length} chars)`);

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

      // 3. Determine display name (sanitize to prevent prompt injection via filename)
      const rawName = filename || `${type === 'image' ? 'foto' : 'documento'}${ext}`;
      const displayName = rawName.replace(/[\[\]\x00-\x1f]/g, '').slice(0, 60);
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

      // 5. Forward to AI with context (sanitize caption to prevent prompt injection)
      const safeCaption = caption.replace(/[\[\]\x00-\x1f]/g, '').slice(0, 500);
      const ocrHint = type === 'image' ? ' Podés usar la herramienta ocr_analyze con esta URL para extraer datos del documento si el usuario lo pide.' : '';
      const contextMsg = safeCaption
        ? `[El usuario envió ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName} — URL: ${publicUrl}]${ocrHint} ${safeCaption}`
        : `[El usuario envió ${type === 'image' ? 'una imagen' : 'un documento'}: ${displayName} — URL: ${publicUrl}]${ocrHint}`;

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
    const freightActions = ['accept', 'assign_truck', 'reject', 'start', 'confirm_loaded', 'confirm_finished', 'cancel', 'reassign', 'add_truck', 'remove_truck'];
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
      const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
      const allUserCompanies = [activeCoId, ...memberCompanyIds].filter(Boolean);
      const canAccess = allUserCompanies.some(c => c === freight.originCompanyId || c === freight.destCompanyId)
        || freight.assignments.some(a => allUserCompanies.includes(a.transportCompanyId) || a.driverId === user.id);
      if (!canAccess) {
        await this.wa.sendText(phone, 'No tiene acceso a este flete.');
        return;
      }
    }

    try {
      switch (action) {
        case 'accept':
        case 'assign_truck': {
          // Redirect to AI chat — transporter assigns truck+driver through conversation
          const code = await this.prisma.freight.findUnique({ where: { id: entityId }, select: { code: true } }).then(f => f?.code || entityId);
          await this.handleAiChat(phone, user, `Quiero asignar camión y chofer al flete ${code}`);
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
        case 'reassign': {
          // Fetch freight code to send a synthetic AI message for reassignment
          const reassignFreight = await this.prisma.freight.findUnique({
            where: { id: entityId },
            select: { code: true },
          });
          if (reassignFreight) {
            await this.handleAiChat(phone, user, `Quiero asignar un transportista al flete ${reassignFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
          break;
        }
        case 'detail': {
          await this.showFreightDetail(phone, user, entityId);
          break;
        }
        case 'menu': {
          const menuSess = await this.prisma.whatsAppSession.findFirst({ where: { userId: user.id, expiresAt: { gt: new Date() } }, orderBy: { updatedAt: 'desc' } });
          await this.showMainMenu(phone, user, ((menuSess?.flowState as any) || {}).selectedCompanyId);
          break;
        }
        case 'active_freights': {
          await this.showActiveFreights(phone, user);
          break;
        }
        case 'create_freight': {
          // Redirect to AI agent for conversational freight creation
          await this.handleAiChat(phone, user, 'Quiero crear un flete');
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
        case 'add_truck': {
          const addFreight = await this.prisma.freight.findUnique({ where: { id: entityId }, select: { code: true } });
          if (addFreight) {
            await this.handleAiChat(phone, user, `Quiero agregar un camión al flete ${addFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
          break;
        }
        case 'remove_truck': {
          const rmFreight = await this.prisma.freight.findUnique({ where: { id: entityId }, select: { code: true } });
          if (rmFreight) {
            await this.handleAiChat(phone, user, `Quiero quitar un camión del flete ${rmFreight.code}`);
          } else {
            await this.wa.sendText(phone, 'Flete no encontrado.');
          }
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
    } else if (type === 'action') {
      // Freight action selected from get_freight_detail actions list
      const ACTION_MESSAGES: Record<string, string> = {
        assign: 'Quiero asignar un transportista a este flete',
        accept: 'Acepto este flete',
        reject: 'Quiero rechazar este flete',
        authorize: 'Quiero autorizar este flete',
        start: 'Quiero iniciar el viaje',
        confirm_loaded: 'Confirmo la carga',
        confirm_finished: 'Confirmo la entrega',
        cancel: 'Quiero cancelar este flete',
        edit: 'Quiero editar este flete',
        tracking: 'Quiero ver la ubicación',
        duplicate: 'Quiero duplicar este flete',
        add_truck: 'Quiero agregar un camión a este flete',
        remove_truck: 'Quiero quitar un camión de este flete',
      };
      const msg = ACTION_MESSAGES[id] || `Acción: ${title || id}`;
      await this.handleAiChat(phone, user, msg);
    } else if (['lot', 'field', 'truck', 'transporter', 'user', 'driver', 'plant', 'branch', 'ownfleet_truck', 'ownfleet_driver', 'plant_resolve', 'lot_resolve', 'field_resolve', 'branch_selection', 'assignment'].includes(type)) {
      // Generic AI list selection — feed back to AI as synthetic message (sanitize to prevent injection)
      const safeTitle = (title || '').replace(/[\[\]\x00-\x1f]/g, '').slice(0, 50);
      const safeId = (id || '').replace(/[^\w\-.:]/g, '').slice(0, 80);
      await this.handleAiChat(phone, user, `[Seleccionó: ${safeTitle} (id: ${safeId})]`);
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
      headerText: 'Tiene acceso a varias empresas.\nSeleccione con cuál desea operar:',
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

    // NOTE: Do NOT update activeCompanyId in DB here. WhatsApp company selection
    // is session-scoped (stored in flowState.selectedCompanyId). Updating the DB
    // would desync the web app, which reads activeCompanyId from the JWT/DB.
    // The AI service reads selectedCompanyId from the session when creating freights.

    // Audit log (fire-and-forget)
    this.prisma.auditLog.create({
      data: {
        entityType: 'user', entityId: user.id,
        action: 'whatsapp_company_selected',
        fromValue: user.activeCompanyId || user.companyId || undefined,
        toValue: companyId, userId: user.id,
        metadata: { source: 'whatsapp', sessionScoped: true },
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
      // Re-load session after cleanup so handleAiChat gets fresh flowState
      const cleanedSess = await this.prisma.whatsAppSession.findUnique({ where: { id: freshSess.id } });
      // Replay button action or text message
      try {
        if (pendingAction) {
          await this.handleButtonReply(phone, updatedUser, pendingAction.id, pendingAction.title);
        } else {
          await this.handleAiChat(phone, updatedUser, pendingMsg, cleanedSess || undefined);
        }
      } catch (replayErr: any) {
        this.logger.error(`[CompanySelection] Replay failed: ${replayErr.message}`, replayErr.stack?.slice(0, 300));
        await this.wa.sendText(phone, 'Hubo un problema al procesar su mensaje. Por favor, intente nuevamente.');
      }
    } else if (updatedUser) {
      await this.showMainMenu(phone, updatedUser, companyId);
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
      case 'freight_actions': {
        // User selected an action from the freight detail actions list
        const ACTION_MESSAGES: Record<string, string> = {
          assign: 'Quiero asignar un transportista a este flete',
          accept: 'Acepto este flete',
          reject: 'Quiero rechazar este flete',
          authorize: 'Quiero autorizar este flete',
          start: 'Quiero iniciar el viaje',
          confirm_loaded: 'Confirmo la carga',
          confirm_finished: 'Confirmo la entrega',
          cancel: 'Quiero cancelar este flete',
          edit: 'Quiero editar este flete',
          tracking: 'Quiero ver la ubicación',
          duplicate: 'Quiero duplicar este flete',
        };
        const msg = ACTION_MESSAGES[id] || `Acción: ${item.title || id}`;
        await this.handleAiChat(phone, user, msg);
        break;
      }
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

    // Prune stale entries (>5min) + hard cap
    if (this.freightCountsCache.size > 500) {
      const now = Date.now();
      for (const [k, v] of this.freightCountsCache) {
        if (now - v.ts > 300_000) this.freightCountsCache.delete(k);
      }
      if (this.freightCountsCache.size > 400) {
        const iter = this.freightCountsCache.keys();
        while (this.freightCountsCache.size > 400) {
          const k = iter.next().value;
          if (k) this.freightCountsCache.delete(k); else break;
        }
      }
    }

    return data;
  }

  // ======================== SHOW MAIN MENU ==============================

  async showMainMenu(phone: string, user: any, sessionCompanyId?: string) {
    // Use session-scoped company (WhatsApp selection) over DB activeCompanyId
    const activeCoId = sessionCompanyId || user.activeCompanyId || user.companyId;
    // Temporarily override user for role resolution
    if (sessionCompanyId) user = { ...user, activeCompanyId: sessionCompanyId };
    const role = this.getUserRole(user);
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
            (enCurso > 0 ? `🔄 A campo/planta: ${enCurso}\n` : '');
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
      `\nSiguiente paso: escriba la opción o describa su pedido.`,
      this.getRoleMenuButtons(role),
    );
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const role = this.getUserRole(user);

    const header = `GUÍA DE USO\n\n`;

    const body =
      `Enviando un mensaje de texto o audio puede realizar las gestiones que tenga habilitadas. ` +
      `Comience la conversación y Tolvink lo ayudará.\n\n`;

    const roleSection = this.getRoleHelpSection(role);

    const footer = `Plataforma web:\n${APP_URL}`;

    await this.wa.sendText(phone, header + body + roleSection + footer);

    await this.wa.sendButtons(phone,
      'Seleccione una opción:',
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
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    if (role === 'plant') {
      return [
        { id: 'active_freights', title: 'FLETES PENDIENTES' },
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    if (role === 'transporter') {
      return [
        { id: 'active_freights', title: 'MIS ASIGNACIONES' },
        { id: 'show_help', title: 'GUÍA DE USO' },
      ];
    }
    return [
      { id: 'active_freights', title: 'MIS FLETES' },
      { id: 'create_freight', title: 'SOLICITAR FLETE' },
      { id: 'show_help', title: 'GUÍA DE USO' },
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
          { assignments: { some: { driverId: user.id } } },
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

    // shareToken is only generated when explicitly requested via tracking/report link tools

    // Save activeContext so AI retains freight context after message trimming
    try {
      const normalizedPhone = this.wa.normalizePhone(phone);
      const sess = await this.prisma.whatsAppSession.findFirst({
        where: { phone: normalizedPhone, userId: user.id, expiresAt: { gt: new Date() } },
        orderBy: { updatedAt: 'desc' },
      });
      if (sess) {
        const st = (sess.flowState as any) || {};
        const grain = freight.items[0]?.grain || '';
        const tons = freight.items[0]?.tons || '';
        const originName = freight.originName || freight.originCompany?.name || '';
        const destName = freight.destName || freight.destCompany?.name || '';
        await this.prisma.whatsAppSession.update({
          where: { id: sess.id },
          data: {
            flowState: {
              ...st,
              activeContext: {
                ...(st.activeContext || {}),
                lastFreightId: freight.id,
                lastFreightCode: freight.code,
                lastFreightSummary: `${grain} ${tons}tn, ${originName} → ${destName}, ${freight.status}`,
                updatedAt: new Date().toISOString(),
              },
            },
          },
        });
      }
    } catch (e) {
      this.logger.warn(`activeContext save failed: ${(e as any).message}`);
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
    if (freight.shareToken) {
      text += `\n🗺️ Seguimiento disponible.\n${APP_URL}/${freight.code}/ubicacion?s=${freight.shareToken}`;
    }

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
