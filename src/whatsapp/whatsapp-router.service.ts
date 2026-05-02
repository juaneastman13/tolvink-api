// =====================================================================
// TOLVINK — WhatsApp Message Router
// Routes incoming WhatsApp messages to appropriate handlers
// =====================================================================

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsService } from '../freights/freights.service';
import { AgentService } from '../ai/agent.service';
import { AgentV2Service } from '../agent-v2/agent-v2.service';
import { AiProfile, resolveAiProfile } from '../ai/core/ai-profile';
import { buildSyntheticUser as buildSyntheticUserHelper } from '../common/build-synthetic-user';
import { SelectionItem, resolveSelectionReply } from '../common/selection-helpers';
import { getActiveMembership, getScopedCompany, getScopedRole, scopeUserToCompany, scopeUserToSessionCompany } from '../common/user-company-scope';
import OpenAI from 'openai';
import * as crypto from 'crypto';
import { acquirePgLockWithWait, releasePgLock } from '../common/distributed-lock';
import { classifyAiError, sanitizeErrorForLog } from '../common/error-utils';

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
const MECHANIC_APP_ONLY_MESSAGE =
  `El modulo mecanico por ahora esta disponible solo desde la app de Tolvink.\n\n` +
  `Ingresa a ${APP_URL} y abri Mecanica para gestionar maquinas, mantenimientos y alertas.`;

@Injectable()
export class WhatsAppRouterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppRouterService.name);
  private static readonly PENDING_DOCUMENT_TTL_MS = 30 * 60 * 1000;
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
    private ai: AgentService,
    private agentV2: AgentV2Service,
  ) {
    this.logger.log(`[Agent Router] Mode: ${this.agentV2.getMode()}`);

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
    const distLockKey = `wa_phone:${phone}`;
    // Single-instance: skip PG advisory lock, in-process phone lock (prev/unlock) is sufficient.
    const hasDistLock = false;
    try {
      return await this._handleMessage(phone, type, payload, waMessageId);
    } finally {
      if (hasDistLock) await releasePgLock(this.prisma as any, distLockKey);
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
            .catch((err) => this.logger.warn(`[rateLimit] feedback send failed: ${err.message}`));
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
    // Cross-instance guard: persistent count in whatsapp_message_logs.
    const dbCount = await this.prisma.whatsAppMessageLog.count({
      where: {
        phone,
        direction: 'inbound',
        createdAt: { gt: new Date(now - 60_000) },
      },
    });
    if (dbCount > 45) {
      this.wa.sendText(phone, 'Estas enviando muchos mensajes seguidos. Espera un minuto y seguimos.')
        .catch((err) => this.logger.warn(`[rateLimit-db] feedback send failed: ${sanitizeErrorForLog(err?.message)}`));
      this.logger.warn(`Persistent rate limit exceeded phone=${phone.slice(-4)} count=${dbCount}/60s`);
      return;
    }

    try {
      const maskedPhone = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
      const safePayload = type === 'text' ? `text(${(payload?.body?.length || 0)} chars)`
        : type === 'location' ? 'location(lat:***,lng:***)'
        : type === 'image' || type === 'document' || type === 'audio' ? `${type}(file)`
        : type === 'button_reply' || type === 'list_reply' ? `${type}(id:${(payload?.id || '').slice(0, 30)})`
        : type;
      this.logger.log(`handleMessage type=${type} phone=${maskedPhone} payload=${safePayload}`);

      // markRead moved to controller (before locks) for instant read receipts

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

      if (type === 'text') {
        const textBody = (payload.body || '').trim();
        if (this.isResetSessionIntent(textBody)) {
          await this.handleResetSessionCommand(phone, user);
          return;
        }
        if (this.isChangeCompanyIntent(textBody)) {
          await this.handleChangeCompanyCommand(phone, user, cachedSession);
          return;
        }
      }

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
        const GREETING_RE_IN_FLOW = /^(hola|hi|hey|buenas?|buen\s*d[ií]a|buenos?\s*d[ií]as?|buenas?\s*tardes?|buenas?\s*noches?|qu[eé]\s*tal|c[oó]mo\s*(est[aá]s?|and[aá]s?|va)|saludos?|menu|inicio)[\s?!.,]*$/i;
        if (/^(cancelar|salir|exit|cancel)$/.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.wa.sendText(phone, '❌ Operación cancelada.');
          await this.showMainMenu(phone, user, sessionCoId);
          return;
        }
        if (GREETING_RE_IN_FLOW.test(cmd)) {
          await this.prisma.whatsAppSession.delete({ where: { id: session.id } });
          await this.showMainMenu(phone, user, sessionCoId);
          return;
        }

        // Notification action buttons (accept, reject, confirm_loaded, etc.) override active flow
        if (type === 'button_reply' && payload.id && /^(accept|reject|start|confirm_loaded|confirm_finished|detail):/.test(payload.id)) {
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
      if (hasHistory && (this.agentV2.isEnabled() || this.ai.isEnabled())) {
        const msg = emojiOnly ? `[El usuario envió solo emojis: ${t}]` : t;
        await this.handleAiChat(phone, user, msg, cachedSession);
      } else {
        await this.showMainMenu(phone, user, sessionCoId);
      }
      return;
    }

    if (this.isMechanicAssistantIntent(t)) {
      await this.sendMechanicAppOnlyMessage(phone);
      return;
    }

    // AI-powered handler for all other text (actual requests/queries)
    if (this.agentV2.isEnabled() || this.ai.isEnabled()) {
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
      if (this.isMechanicAssistantIntent(text)) {
        await this.sendMechanicAppOnlyMessage(phone);
        return;
      }

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
        }).catch((err) => this.logger.warn(`[session] extend failed: ${err.message}`));
        session.expiresAt = newExpiry;
      }

      // Show "typing" indicator so user sees the bot is working
      this.wa.sendTypingIndicator(phone).catch((err) => this.logger.debug(`[typing] indicator failed: ${err.message}`));

      // Route to selected conversational agent.
      const result = this.agentV2.isEnabled()
        ? await this.agentV2.chat(phone, text, user, session)
        : await this.ai.chat(phone, text, user, session);
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
      const errCode = classifyAiError(e);
      this.logger.error(`AI chat error [code=${errCode}]: ${sanitizeErrorForLog((e as any)?.message)}`, (e as any)?.stack?.slice(0, 300));
      const userMsg = errCode === 'provider_suspended'
        ? 'El servicio de inteligencia esta temporalmente no disponible. Mientras tanto, usa el menu para seguir operando.'
        : errCode === 'provider_unavailable'
          ? 'El asistente esta con alta demanda. Intenta nuevamente en unos segundos o usa el menu.'
          : 'Se produjo un inconveniente tecnico. Por favor, utilice las opciones del menu.';
      await this.wa.sendText(phone, userMsg);
      const sessCoId = ((cachedSession?.flowState as any) || {}).selectedCompanyId;
      await this.showMainMenu(phone, user, sessCoId);
    }
  }

  private isMechanicAssistantIntent(text: string): boolean {
    const normalized = (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();

    return /\b(mecanica|mecanico|mantenimiento|maquinaria|maquina|maquinas|tractor|tractores|cosechadora|cosechadoras|sembradora|pulverizadora|horometro|service|aceite|filtro|filtros|repuesto|repuestos|taller)\b/.test(normalized);
  }

  private normalizeCommandText(text: string): string {
    return (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private isResetSessionIntent(text: string): boolean {
    const normalized = this.normalizeCommandText(text);
    return /^(reiniciar|reinicia|reset|resetear|resetea)$/i.test(normalized)
      || /^(reiniciar|reinicia|reset|resetear|resetea|limpiar|limpia|borrar|borra) (sesion|chat|conversacion)$/i.test(normalized)
      || /^(reiniciar sesion|reset sesion|resetear sesion|limpiar sesion|borrar sesion)$/i.test(normalized)
      || /^(empezar de nuevo|arrancar de nuevo|volver a empezar)$/i.test(normalized);
  }

  private isChangeCompanyIntent(text: string): boolean {
    const normalized = this.normalizeCommandText(text);
    return /^(cambiar|cambia|elegir|elegi|seleccionar|selecciona) (de )?(empresa|compania|compania activa)$/i.test(normalized)
      || /^(cambiar empresa|cambia empresa|otra empresa|empresa|empresas)$/i.test(normalized)
      || /^(operar con otra empresa|quiero cambiar de empresa)$/i.test(normalized);
  }

  private async handleResetSessionCommand(phone: string, user: any): Promise<void> {
    await this.prisma.whatsAppSession.deleteMany({ where: { userId: user.id } });
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    await this.wa.sendText(phone, 'Listo, reinicie la sesion de WhatsApp. Se limpiaron acciones, adjuntos y contexto pendiente.');
    if (memberships.length > 1) {
      await this.sendCompanySelectionList(phone, user);
      return;
    }
    await this.showMainMenu(phone, user, user.activeCompanyId || user.companyId);
  }

  private async handleChangeCompanyCommand(phone: string, user: any, cachedSession?: any): Promise<void> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    if (memberships.length <= 1) {
      await this.wa.sendText(phone, 'Tu usuario tiene una sola empresa activa para operar por WhatsApp.');
      await this.showMainMenu(phone, user, user.activeCompanyId || user.companyId);
      return;
    }

    let session = cachedSession;
    if (!session || session.expiresAt <= new Date()) {
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
    } else if (session.flowType) {
      session = await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowType: null, flowStep: '0' },
      });
    }

    await this.ai.cancelPendingAction(session.id).catch(() => false);
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...this.stripOperationalFlowState(state),
          companyConfirmed: false,
          selectedCompanyId: null,
        },
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
    await this.wa.sendText(phone, 'Elegí la empresa con la que querés operar.');
    await this.sendCompanySelectionList(phone, user);
  }

  private async sendMechanicAppOnlyMessage(phone: string): Promise<void> {
    await this.wa.sendText(phone, MECHANIC_APP_ONLY_MESSAGE);
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
    const locationPurpose = state.locationToken?.purpose || 'general';
    const isAgentV2FreightLocationCapture = this.agentV2.isEnabled()
      && state.agentV2?.currentFlow === 'create_freight'
      && state.agentV2?.currentStep === 'awaiting_location';
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          lastLocation: { lat: latitude, lng: longitude, name: name || '', address: address || '', purpose: locationPurpose },
          lastLocationPurpose: locationPurpose,
          locationToken: null,
        },
      },
    });

    if (isAgentV2FreightLocationCapture) {
      const result = await this.agentV2.handleLocation(phone, user, session, {
        lat: latitude,
        lng: longitude,
        label: name || address || undefined,
      });
      await this.wa.sendText(phone, result.text);
      return;
    }

    // GPS tracking: save position to FreightTracking for any active freight the user is involved in
    this.saveLocationToActiveFreights(user, latitude, longitude).catch(async (err) => {
      // P2002 = duplicate GPS write (race condition) — silently ignore
      if (err?.code === 'P2002') return;
      this.logger.error(`GPS tracking save failed for user ${user.id}: ${err.message}`);
      await this.wa.sendText(phone, 'No se pudo guardar su ubicación. Intente enviarla de nuevo.').catch((err2) => this.logger.warn(`[gps] error feedback send failed: ${err2.message}`));
    });

    if (this.agentV2.isEnabled()) {
      const result = await this.agentV2.handleLocation(phone, user, session, {
        lat: latitude,
        lng: longitude,
        label: name || address || undefined,
      });
      await this.wa.sendText(phone, result.text);
      return;
    }

    // Forward as text to AI so the agent knows the user shared a location (no raw coords — policy)
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
        prompt: 'Tolvink, flete, planta, camión, productor, cosechadora, tractor',
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

      await this.ai.cancelPendingAction(session.id).catch(() => false);
      const state = (session.flowState as any) || {};
      const companyId = this.getSessionCompanyId(session, user);
      const nextState = this.stripPendingInteractionState(state);
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...nextState,
            pendingDocument: {
              url: publicUrl,
              name: displayName,
              type: docType,
              companyId,
              createdAt: Date.now(),
            },
          },
        },
      });

      await this.showPendingDocumentDestinationOptions(phone, user, session, displayName);
      return;

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
          // "cancel:{freightId}" = cancel freight flow. Plain "cancel" = generic AI cancellation.
          if (entityId) {
            await this.flow.startFlow('cancel_freight', phone, user, { freightId: entityId });
          } else {
            await this.handleAiChat(phone, user, 'No, cancelar.');
          }
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
        case 'register_arrival': {
          const targetFreightId = entityId || await this.findActiveAutonomousFreightId(user);
          if (!targetFreightId) {
            await this.wa.sendText(phone, 'No tenes un flete activo para registrar llegada.');
            break;
          }
          const finished = await this.freights.finishAutonomousFreight(targetFreightId, this.buildSyntheticUser(user));
          await this.clearAiOperationalContext(user.id);
          await this.wa.sendText(phone, `Listo.\n📋 ${finished.code}\nFlete finalizado.`);
          break;
        }
        case 'finish_autonomous': {
          const targetFreightId = entityId || await this.findActiveAutonomousFreightId(user);
          if (!targetFreightId) {
            await this.wa.sendText(phone, 'No tenes un flete activo para finalizar.');
            break;
          }
          const finished = await this.freights.finishAutonomousFreight(targetFreightId, this.buildSyntheticUser(user));
          await this.clearAiOperationalContext(user.id);
          await this.wa.sendText(phone, `Listo.\n📋 ${finished.code}\nFlete finalizado.`);
          break;
        }
        case 'show_help': {
          await this.showHelp(phone, user);
          break;
        }
        case 'doc_attach_active': {
          await this.attachPendingDocumentToDefaultTarget(phone, user);
          break;
        }
        case 'doc_attach_other': {
          await this.showPendingDocumentFreightSelection(phone, user);
          break;
        }
        case 'doc_attach_cancel': {
          await this.clearPendingDocumentContext(user.id);
          await this.wa.sendText(phone, 'Listo, no adjunte el archivo.');
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
          const token = entityId ? ` [FREIGHT_ACTION_ID:${entityId}]` : '';
          await this.handleAiChat(phone, user, `Confirmar.${token}`);
          break;
        }
        case 'ai_cancel_freight': {
          // User pressed "CANCELAR" on freight summary → forward to AI
          const token = entityId ? ` [FREIGHT_ACTION_ID:${entityId}]` : '';
          await this.handleAiChat(phone, user, `No, cancelar.${token}`);
          break;
        }
        case 'ai_confirm':
        case 'confirm': { // backward compatibility
          // Confirm pending autonomous AI action directly, without another LLM turn.
          const session = await this.prisma.whatsAppSession.findFirst({
            where: { userId: user.id, expiresAt: { gt: new Date() } },
            orderBy: { updatedAt: 'desc' },
          });
          if (!session) {
            await this.wa.sendText(phone, 'No hay una accion pendiente para confirmar.');
            break;
          }
          const pendingActionId = await this.ai.getPendingActionId(session.id);
          if (!pendingActionId || (entityId && entityId !== pendingActionId)) {
            await this.wa.sendText(phone, 'Esa confirmacion ya vencio o ya fue procesada.');
            break;
          }
          const result = await this.ai.confirmPendingAction(session, user);
          const parsed = JSON.parse(result || '{}');
          if (parsed?.error) {
            await this.wa.sendText(phone, parsed.error);
          } else if (parsed?.status === 'pending_confirmation') {
            const summary = (await this.ai.getPendingSummary(session.id)) || parsed.summary || 'Confirma la siguiente accion.';
            const buttons = await this.ai.getPendingButtons(session.id);
            if (buttons?.length) {
              await this.wa.sendButtons(phone, summary, buttons);
            } else {
              await this.wa.sendText(phone, summary);
            }
          } else if (parsed?.status === 'created' && parsed?.code) {
            await this.wa.sendText(phone, `Listo.\n📋 ${parsed.code}\nFlete creado correctamente.`);
          } else if (parsed?.status === 'finished' && parsed?.code) {
            await this.wa.sendText(phone, `Listo.\n📋 ${parsed.code}\nFlete finalizado.`);
          } else if (parsed?.status === 'arrival_registered' && parsed?.code) {
            await this.wa.sendText(phone, `Listo.\n📋 ${parsed.code}\nLlegada a planta registrada.`);
          } else if (parsed?.status === 'attached' && parsed?.documentName) {
            await this.wa.sendText(phone, `Documento adjuntado: ${parsed.documentName}`);
          } else {
            await this.wa.sendText(phone, 'Accion confirmada.');
          }
          break;
        }
        case 'ai_cancel': {
          // Cancel pending autonomous AI action directly, without another LLM turn.
          const session = await this.prisma.whatsAppSession.findFirst({
            where: { userId: user.id, expiresAt: { gt: new Date() } },
            orderBy: { updatedAt: 'desc' },
          });
          if (!session) {
            await this.wa.sendText(phone, 'No hay una accion pendiente para cancelar.');
            break;
          }
          const canceled = await this.ai.cancelPendingAction(session.id, entityId || undefined);
          await this.wa.sendText(
            phone,
            canceled ? 'Listo, accion cancelada.' : 'Esa accion ya no estaba pendiente.',
          );
          break;
        }
        case 'ai_edit':
        case 'edit': { // backward compatibility
          await this.wa.sendText(phone, 'Perfecto. Decime que dato queres cambiar y lo actualizo.');
          break;
        }
        default: {
          await this.wa.sendText(phone, 'Acción no reconocida. Escriba "menu" para ver las opciones disponibles.');
        }
      }
    } catch (e) {
      this.logger.error(`Button action "${action}" failed: ${sanitizeErrorForLog((e as any)?.message)}`, (e as any)?.stack);
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
    } else if (type === 'attachdoc') {
      await this.attachPendingDocumentToFreight(phone, user, id);
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

    const currentState = ((session?.flowState as any) || {});
    const previousCompanyId = currentState.selectedCompanyId || undefined;
    const companyChanged = currentState.companyConfirmed === true
      && !!previousCompanyId
      && previousCompanyId !== companyId;
    const flowData = { companyConfirmed: true, selectedCompanyId: companyId };
    const nextFlowState = companyChanged
      ? { ...this.stripOperationalFlowState(currentState), ...flowData }
      : { ...currentState, ...flowData };
    if (session) {
      if (companyChanged) {
        await this.ai.cancelPendingAction(session.id).catch(() => false);
      }
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: nextFlowState },
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

    if (companyChanged) {
      await this.wa.sendText(phone, 'Se limpiaron acciones, adjuntos y selecciones pendientes de la empresa anterior.');
    }

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
    user = scopeUserToCompany(user, activeCoId);
    const role = this.getUserRole(user);
    const isAutonomousDriver = this.isAutonomousDriver(user, activeCoId);
    const profile = this.getAiProfile(user);
    const activeMem = getActiveMembership(user);
    const companyName = activeMem?.company?.name || getScopedCompany(user)?.name || '';
    const roleLabel = this.getProfileRoleLabel(profile, role, isAutonomousDriver);

    if (isAutonomousDriver) {
      const activeFreight = await this.findActiveAutonomousFreight(user);
      const header =
        `*Tolvink*\n\n` +
        (companyName ? `🏢 Empresa activa: ${companyName}.\n` : '') +
        (roleLabel ? `👤 Rol: ${roleLabel}.\n\n` : '\n');

      if (activeFreight) {
        const activeAction = activeFreight.arrivedAtPlantAt
          ? { id: `finish_autonomous:${activeFreight.id}`, title: 'FINALIZAR FLETE' }
          : { id: `register_arrival:${activeFreight.id}`, title: 'CONFIRMAR LLEGADA' };
        await this.wa.sendButtons(
          phone,
          header + `Tenes un flete activo`,
          [activeAction],
        );
      } else {
        await this.wa.sendButtons(
          phone,
          header + `No tenes fletes activos`,
          [{ id: 'create_freight', title: 'SOLICITAR FLETE' }],
        );
      }
      return;
    }

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

    // Resolve CompanyAccess to show per-company capabilities
    let features = '';
    try {
      const accesses = await this.prisma.companyAccess.findMany({
        where: { granteeCompanyId: activeCoId, isActive: true },
        select: { grantorCompanyId: true, accessLevel: true, grantorCompany: { select: { name: true } } },
        take: 50,
      });

      if (accesses.length > 0) {
        const operatorPlants: string[] = [];
        const readonlyPlants: string[] = [];
        for (const a of accesses) {
          const pName = a.grantorCompany?.name || 'Empresa';
          if (a.accessLevel === 'READONLY') readonlyPlants.push(pName);
          else operatorPlants.push(pName);
        }

        if (operatorPlants.length > 0 && readonlyPlants.length > 0) {
          // Mixed: show per-group
          features =
            `\n📌 Con *${operatorPlants.join(', ')}* podés:\n` +
            this.getOperatorFeaturesSafe(role) +
            `\n📌 Con *${readonlyPlants.join(', ')}* podés:\n` +
            this.getReadonlyFeaturesSafe();
        } else if (readonlyPlants.length > 0 && operatorPlants.length === 0) {
          // All READONLY
          features =
            `\n📌 Podés hacer estas cosas desde acá:\n` +
            this.getReadonlyFeaturesSafe();
        } else {
          // All OPERATOR — show normal role features
          features = this.getRoleFeatureSummarySafe(role, profile);
        }
      } else {
        features = this.getRoleFeatureSummarySafe(role, profile);
      }
    } catch {
      features = this.getRoleFeatureSummarySafe(role, profile);
    }

    await this.wa.sendButtons(phone,
      header + statsBlock + features +
      `\n¿Qué querés hacer?`,
      this.getRoleMenuButtonsClean(role, profile),
    );
  }

  private getOperatorFeatures(role: string): string {
    if (role === 'producer') {
      return (
        `🌾 Crear fletes de granos\n` +
        `📋 Ver el estado y detalle de tus fletes\n` +
        `🗺 Ver ubicación y seguimiento en mapa\n` +
        `📅 Modificar fecha u hora de un flete\n` +
        `❌ Cancelar fletes\n` +
        `📎 Adjuntar documentos (fotos, remitos)\n` +
        `📄 Duplicar un flete existente\n` +
        `🌾 Gestionar campos y lotes\n` +
        `🚛 Camiones y choferes\n` +
        `👤 Tu perfil\n`
      );
    }
    if (role === 'transporter') {
      return (
        `📋 Ver asignaciones\n` +
        `🚛 Aceptar o rechazar viajes\n` +
        `🚛 Asignar camión y chofer\n` +
        `📋 Ver estado de fletes\n` +
        `🗺 Seguimiento en mapa\n` +
        `📎 Adjuntar documentos\n` +
        `🚛 Gestionar camiones y choferes\n` +
        `👤 Tu perfil\n`
      );
    }
    return this.getRoleFeatureSummaryClean(role, 'plant_operator').replace('\nAcciones principales:\n', '');
  }

  private getReadonlyFeatures(): string {
    return (
      `📋 Ver el estado y detalle de fletes\n` +
      `🗺 Ver ubicación y seguimiento en mapa\n` +
      `📄 Solicitar informes PDF\n` +
      `👤 Tu perfil\n`
    );
  }

  private getOperatorFeaturesSafe(role: string): string {
    if (role === 'producer') {
      return (
        `- Solicitar fletes de granos\n` +
        `- Ver estado y detalle de fletes\n` +
        `- Buscar campos, lotes y plantas\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (role === 'transporter') {
      return (
        `- Ver asignaciones\n` +
        `- Aceptar o rechazar viajes\n` +
        `- Asignar camion y chofer\n` +
        `- Adjuntar documentos\n`
      );
    }
    return this.getRoleFeatureSummarySafe(role, 'plant_operator').replace('\nAcciones principales:\n', '');
  }

  private getReadonlyFeaturesSafe(): string {
    return `- Ver el estado y detalle de fletes\n`;
  }

  // ======================== SHOW HELP ==================================

  private async showHelp(phone: string, user: any) {
    const role = this.getUserRole(user);
    const profile = this.getAiProfile(user);

    const header = `GUIA DE USO\n\n`;

    const body =
      `Enviando un mensaje de texto o audio puede realizar las gestiones que tenga habilitadas. ` +
      `Comience la conversacion y Tolvink lo ayudara.\n\n`;

    const roleSection = this.getRoleHelpSectionSafe(role, profile);
    const statusGuide = this.getRoleStateGuideClean(role, profile);

    const footer = `Plataforma web:\n${APP_URL}`;

    await this.wa.sendText(phone, header + body + roleSection + statusGuide + footer);

    await this.wa.sendButtons(phone,
      'Seleccione una opcion:',
      this.getRoleMenuButtonsClean(role, profile),
    );
  }

  // ======================== ROLE HELPERS ================================

  private getUserRole(user: any): string {
    // Prefer active company's type for multi-company users
    const am = getActiveMembership(user);
    if (am?.company) {
      const types = Array.isArray(am.company.types) && am.company.types.length > 0
        ? am.company.types : [am.company.type];
      if (types[0]) return types[0];
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

  private isAutonomousDriver(user: any, activeCoId?: string): boolean {
    const scopedUser = scopeUserToCompany(user, activeCoId || user.activeCompanyId || user.companyId);
    const activeMem = getActiveMembership(scopedUser);
    const isChofer = getScopedRole(scopedUser) === 'chofer';
    const autoEnabled = !!(activeMem?.company?.autonomousDriverEnabled || getScopedCompany(scopedUser)?.autonomousDriverEnabled);
    return isChofer && autoEnabled;
  }

  private async findActiveAutonomousFreight(user: any): Promise<{ id: string; arrivedAtPlantAt: Date | null } | null> {
    const userId = user.sub || user.id;
    if (!userId) return null;
    return this.prisma.freight.findFirst({
      where: {
        requestedById: userId,
        isAutonomous: true,
        status: { notIn: ['finished', 'canceled'] },
        transporterFinishedConfirmedAt: null,
      },
      select: { id: true, arrivedAtPlantAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async findActiveAutonomousFreightId(user: any): Promise<string | null> {
    const freight = await this.findActiveAutonomousFreight(user);
    return freight?.id || null;
  }

  private async showPendingDocumentDestinationOptions(phone: string, user: any, session: any, displayName: string) {
    const defaultTarget = await this.findDefaultPendingDocumentTarget(user, session);
    const buttons: Array<{ id: string; title: string }> = [];
    if (defaultTarget) buttons.push({ id: 'doc_attach_active', title: 'AL FLETE ACTIVO' });
    buttons.push({ id: 'doc_attach_other', title: 'A OTRO FLETE' });
    buttons.push({ id: 'doc_attach_cancel', title: 'CANCELAR' });

    await this.wa.sendButtons(
      phone,
      `Recibi "${displayName}".\n\nDonde queres adjuntarlo?`,
      buttons,
    );
  }

  private async attachPendingDocumentToDefaultTarget(phone: string, user: any) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    const pendingDocument = session ? await this.getValidPendingDocument(session, user) : null;
    if (!session || !pendingDocument) {
      await this.wa.sendText(phone, 'No hay ningun archivo pendiente para adjuntar.');
      return;
    }

    const target = await this.findDefaultPendingDocumentTarget(user, session);
    if (!target?.code) {
      await this.wa.sendText(phone, 'No encontre un flete activo para adjuntar el archivo.');
      return;
    }

    await this.clearSelectionContext(session.id);
    await this.handleAiChat(phone, user, `Adjuntar el archivo pendiente al flete ${target.code}`, session);
  }

  private async showPendingDocumentFreightSelection(phone: string, user: any) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    const state = (session?.flowState as any) || {};
    const pendingDocument = session ? await this.getValidPendingDocument(session, user) : null;
    if (!session || !pendingDocument) {
      await this.wa.sendText(phone, 'No hay ningun archivo pendiente para adjuntar.');
      return;
    }

    const defaultTarget = await this.findDefaultPendingDocumentTarget(user, session);
    const items = await this.buildPendingDocumentSelectionItems(user, session, defaultTarget?.id || null);
    if (items.length === 0) {
      await this.wa.sendText(phone, 'No encontre fletes recientes para elegir.');
      return;
    }

    const config = {
      headerText: 'Seleccione el flete al que quiere adjuntar el archivo.',
      listButtonLabel: 'VER FLETES',
      sectionTitle: 'FLETES RECIENTES',
    };
    const result = await this.wa.sendSelection(phone, items, config);
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          selectionContext: {
            items,
            shownItems: result.shownItems,
            page: result.page,
            totalPages: result.totalPages,
            pageSize: 20,
            purpose: 'attach_document_freight',
            config,
          },
        },
      },
    });
  }

  private async attachPendingDocumentToFreight(phone: string, user: any, freightId: string) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { userId: user.id, flowType: null, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    const pendingDocument = session ? await this.getValidPendingDocument(session, user) : null;
    if (!session || !pendingDocument) {
      await this.wa.sendText(phone, 'No hay ningun archivo pendiente para adjuntar.');
      return;
    }

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: { id: true, code: true },
    });
    if (!freight?.code) {
      await this.wa.sendText(phone, 'Flete no encontrado.');
      return;
    }

    await this.clearSelectionContext(session.id);
    await this.handleAiChat(phone, user, `Adjuntar el archivo pendiente al flete ${freight.code}`, session);
  }

  private async buildPendingDocumentSelectionItems(user: any, session: any, excludeFreightId?: string | null): Promise<SelectionItem[]> {
    const freights = await this.findRecentFreightsForPendingDocument(user, session, excludeFreightId);
    return freights.map((f: any) => ({
      id: `attachdoc:${f.id}`,
      title: f.code,
      description: this.buildPendingDocumentFreightDescription(f),
    }));
  }

  private buildPendingDocumentFreightDescription(freight: any): string {
    const origin = freight.originName || freight.originFreeText || 'Origen';
    const destination = freight.destName || freight.destinationFreeText || 'Destino';
    const grain = freight.items?.[0]?.grain || 'Carga';
    const tons = freight.items?.[0]?.tons != null ? ` ${freight.items[0].tons}tn` : '';
    return `${origin} > ${destination} / ${grain}${tons}`.slice(0, 72);
  }

  private async findRecentFreightsForPendingDocument(user: any, session: any, excludeFreightId?: string | null): Promise<any[]> {
    const scopedUser = this.scopeUserToSessionCompany(user, session);
    const profile = this.getAiProfile(scopedUser);
    const userId = scopedUser.sub || scopedUser.id;

    if (profile === 'autonomous_driver') {
      const autonomousFreights = await this.prisma.freight.findMany({
        where: {
          requestedById: userId,
          isAutonomous: true,
          status: { in: ['finished', 'canceled'] },
        },
        select: {
          id: true,
          code: true,
          status: true,
          originName: true,
          originFreeText: true,
          destName: true,
          destinationFreeText: true,
          updatedAt: true,
          items: { select: { grain: true, tons: true }, take: 1 },
        },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      });
      return autonomousFreights
        .filter((f: any) => !excludeFreightId || f.id !== excludeFreightId)
        .sort((a: any, b: any) => {
          const pa = a.status === 'finished' ? 0 : 1;
          const pb = b.status === 'finished' ? 0 : 1;
          if (pa !== pb) return pa - pb;
          return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
        });
    }

    const activeCompanyId = scopedUser.activeCompanyId || scopedUser.companyId;
    const where: any = {
      ...(excludeFreightId ? { id: { not: excludeFreightId } } : {}),
    };

    if (scopedUser.role !== 'platform_admin') {
      const companyIds = activeCompanyId ? [activeCompanyId] : [];
      where.OR = [
        ...(companyIds.length > 0 ? [{ participantCompanyIds: { hasSome: companyIds } }] : []),
        { assignments: { some: { driverId: userId } } },
        { requestedById: userId, isAutonomous: true },
      ];
    }

    const freights = await this.prisma.freight.findMany({
      where,
      select: {
        id: true,
        code: true,
        status: true,
        originName: true,
        originFreeText: true,
        destName: true,
        destinationFreeText: true,
        updatedAt: true,
        items: { select: { grain: true, tons: true }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
      take: 25,
    });

    const priority: Record<string, number> = {
      pending_assignment: 0,
      assigned: 1,
      accepted: 2,
      in_progress: 3,
      loaded: 4,
      draft: 5,
      finished: 10,
      canceled: 11,
    };

    return freights
      .sort((a: any, b: any) => {
        const pa = priority[a.status] ?? 99;
        const pb = priority[b.status] ?? 99;
        if (pa !== pb) return pa - pb;
        return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      })
      .slice(0, 10);
  }

  private async findDefaultPendingDocumentTarget(user: any, session?: any): Promise<{ id: string; code: string } | null> {
    const scopedUser = this.scopeUserToSessionCompany(user, session);
    const profile = this.getAiProfile(scopedUser);
    const userId = scopedUser.sub || scopedUser.id;

    if (profile === 'autonomous_driver') {
      const activeFreight = await this.prisma.freight.findFirst({
        where: {
          requestedById: userId,
          isAutonomous: true,
          status: { notIn: ['finished', 'canceled'] },
          transporterFinishedConfirmedAt: null,
        },
        select: { id: true, code: true },
        orderBy: { createdAt: 'desc' },
      });
      return activeFreight || null;
    }

    const assignments = await this.prisma.freightAssignment.findMany({
      where: {
        driverId: userId,
        status: { in: ['active', 'accepted'] },
        freight: { status: { notIn: ['finished', 'canceled'] } },
      },
      select: {
        freight: {
          select: { id: true, code: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2,
    });

    if (assignments.length !== 1) return null;
    return assignments[0].freight || null;
  }

  private scopeUserToSessionCompany(user: any, session?: any): any {
    return scopeUserToSessionCompany(user, session);
  }

  private async clearPendingDocumentContext(userId: string) {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { userId, flowType: null, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!session) return;

    const state = (session.flowState as any) || {};
    const nextState = { ...state };
    delete nextState.pendingDocument;
    if (nextState.selectionContext?.purpose === 'attach_document_freight') {
      delete nextState.selectionContext;
    }

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: { flowState: nextState },
    });
  }

  private async clearSelectionContext(sessionId: string) {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session) return;
    const state = (session.flowState as any) || {};
    if (!state.selectionContext) return;
    const { selectionContext, ...nextState } = state;
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: { flowState: nextState },
    });
  }

  private stripPendingInteractionState(state: Record<string, any>): Record<string, any> {
    const nextState = { ...(state || {}) };
    delete nextState.selectionContext;
    delete nextState._pendingSelection;
    delete nextState._pendingMessage;
    delete nextState._pendingAction;
    delete nextState.pendingDocument;
    delete nextState.pendingAiAction;
    return nextState;
  }

  private stripOperationalFlowState(state: Record<string, any>): Record<string, any> {
    const nextState = this.stripPendingInteractionState(state);
    delete nextState.aiMessages;
    delete nextState.activeContext;
    return nextState;
  }

  private getSessionCompanyId(session: any, user?: any): string | undefined {
    const state = (session?.flowState as any) || {};
    return state.selectedCompanyId || user?.activeCompanyId || user?.companyId || undefined;
  }

  private async getValidPendingDocument(session: any, user: any): Promise<any | null> {
    const state = (session?.flowState as any) || {};
    const pendingDocument = state.pendingDocument;
    if (!pendingDocument?.url) return null;

    const selectedCompanyId = this.getSessionCompanyId(session, user);
    const isExpired = pendingDocument.createdAt
      && Date.now() - Number(pendingDocument.createdAt) > WhatsAppRouterService.PENDING_DOCUMENT_TTL_MS;
    const hasCompanyMismatch = pendingDocument.companyId
      && selectedCompanyId
      && pendingDocument.companyId !== selectedCompanyId;

    if (!isExpired && !hasCompanyMismatch) return pendingDocument;

    await this.clearPendingDocumentContext(user.id);
    return null;
  }

  private async clearAiOperationalContext(userId: string): Promise<void> {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!session) return;

    await this.ai.cancelPendingAction(session.id).catch(() => false);
    const cleanState = this.stripOperationalFlowState((session.flowState as any) || {});

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: { flowState: cleanState },
    });
  }

  private getAiProfile(user: any): AiProfile {
    return resolveAiProfile(user);
  }

  private getProfileRoleLabel(profile: AiProfile, role: string, isAutonomousDriver: boolean): string {
    if (isAutonomousDriver) return 'Chofer';
    if (profile.endsWith('_manager')) return 'Gerente';
    if (profile.endsWith('_operator')) return 'Operario';
    if (profile.endsWith('_driver')) return 'Chofer';
    return role === 'producer' ? 'Productor' : role === 'plant' ? 'Planta' : role === 'transporter' ? 'Transportista' : '';
  }

  private getRoleFeatureSummary(role: string, profile: AiProfile): string {
    if (
      profile === 'producer_driver'
      || profile === 'transporter_driver'
      || profile === 'plant_driver'
      || profile === 'autonomous_driver'
    ) {
      return (
        `\n📌 Acciones principales:\n` +
        `📋 Ver mi viaje activo\n` +
        `🚛 Iniciar viaje\n` +
        `🌾 Confirmar carga\n` +
        `🏁 Finalizar flete\n` +
        `📎 Adjuntar evidencia\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `\n📌 Acciones principales:\n` +
        `🚛 Solicitar flete\n` +
        `📋 Ver estado de fletes\n` +
        `🌾 Buscar campos y lotes\n` +
        `🏭 Buscar plantas\n` +
        `📎 Adjuntar documentos\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `\n📌 Acciones principales:\n` +
        `📋 Ver asignaciones\n` +
        `🚛 Asignar camión y chofer\n` +
        `❌ Rechazar asignaciones\n` +
        `📎 Adjuntar documentos\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `\n📌 Acciones principales:\n` +
        `📋 Ver pendientes\n` +
        `✅ Aprobar fletes\n` +
        `🚛 Asignar transportista\n` +
        `📎 Adjuntar documentos\n`
      );
    }
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

  private getRoleMenuButtons(role: string, profile: AiProfile): Array<{ id: string; title: string }> {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return [
        { id: 'active_freights', title: 'MI VIAJE' },
        { id: 'show_help', title: 'GUÃA DE USO' },
      ];
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'SOLICITAR FLETE' },
        { id: 'show_help', title: 'GUÃA DE USO' },
      ];
    }
    if (profile === 'transporter_manager') {
      return [
        { id: 'active_freights', title: 'ASIGNACIONES' },
        { id: 'show_help', title: 'GUÃA DE USO' },
      ];
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return [
        { id: 'active_freights', title: 'PENDIENTES' },
        { id: 'show_help', title: 'GUÃA DE USO' },
      ];
    }
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

  private getRoleHelpSection(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `Chofer operativo\n\n` +
        `  â–¸ Consultar el viaje activo\n` +
        `  â–¸ Iniciar viaje\n` +
        `  â–¸ Confirmar carga\n` +
        `  â–¸ Finalizar viaje\n` +
        `  â–¸ Adjuntar fotos o documentos\n\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `Productor\n\n` +
        `  â–¸ Solicitar fletes nuevos\n` +
        `  â–¸ Consultar estado y detalle\n` +
        `  â–¸ Cancelar si el flujo lo permite\n` +
        `  â–¸ Buscar campos, lotes y plantas\n\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `Transportista gerente\n\n` +
        `  â–¸ Ver asignaciones pendientes\n` +
        `  â–¸ Asignar camiÃ³n y chofer\n` +
        `  â–¸ Rechazar con motivo\n` +
        `  â–¸ Consultar detalle operativo\n\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `Planta\n\n` +
        `  â–¸ Ver fletes pendientes\n` +
        `  â–¸ Aprobar fletes de productor\n` +
        `  â–¸ Asignar empresa transportista\n` +
        `  â–¸ Consultar estado de ejecuciÃ³n\n\n`
      );
    }
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

  private getRoleFeatureSummaryClean(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `\nAcciones principales:\n` +
        `- Ver mi viaje activo\n` +
        `- Iniciar viaje\n` +
        `- Confirmar carga\n` +
        `- Finalizar flete\n` +
        `- Adjuntar evidencia\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `\nAcciones principales:\n` +
        `- Solicitar flete\n` +
        `- Ver estado de fletes\n` +
        `- Buscar campos y lotes\n` +
        `- Buscar plantas\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `\nAcciones principales:\n` +
        `- Ver asignaciones\n` +
        `- Asignar camion y chofer\n` +
        `- Rechazar asignaciones\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `\nAcciones principales:\n` +
        `- Ver pendientes\n` +
        `- Aprobar fletes\n` +
        `- Asignar transportista\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (role === 'producer') {
      return (
        `\nAcciones principales:\n` +
        `- Crear flete\n` +
        `- Ver fletes del dia\n` +
        `- Gestionar campos y lotes\n` +
        `- Equipo\n` +
        `- Informes\n`
      );
    }
    if (role === 'plant') {
      return (
        `\nAcciones principales:\n` +
        `- Fletes pendientes de asignacion\n` +
        `- Asignar transportistas\n` +
        `- Ver fletes del dia\n` +
        `- Equipo\n` +
        `- Informes\n`
      );
    }
    if (role === 'transporter') {
      return (
        `\nAcciones principales:\n` +
        `- Mis asignaciones\n` +
        `- Aceptar o rechazar viajes\n` +
        `- Ver fletes del dia\n` +
        `- Choferes y camiones\n` +
        `- Informes\n`
      );
    }
    return (
      `\nAcciones principales:\n` +
      `- Crear y gestionar fletes\n` +
      `- Ver fletes del dia\n` +
      `- Equipo\n` +
      `- Informes\n`
    );
  }

  private getRoleMenuButtonsClean(role: string, profile: AiProfile): Array<{ id: string; title: string }> {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return [
        { id: 'active_freights', title: 'MI VIAJE' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return [
        { id: 'active_freights', title: 'MIS FLETES' },
        { id: 'create_freight', title: 'SOLICITAR FLETE' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    if (profile === 'transporter_manager') {
      return [
        { id: 'active_freights', title: 'ASIGNACIONES' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return [
        { id: 'active_freights', title: 'PENDIENTES' },
        { id: 'show_help', title: 'GUIA DE USO' },
      ];
    }
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

  private getRoleHelpSectionClean(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `Chofer operativo\n\n` +
        `  - Consultar el viaje activo\n` +
        `  - Iniciar viaje\n` +
        `  - Confirmar carga\n` +
        `  - Finalizar viaje\n` +
        `  - Adjuntar fotos o documentos\n\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `Productor\n\n` +
        `  - Solicitar fletes nuevos\n` +
        `  - Consultar estado y detalle\n` +
        `  - Cancelar si el flujo lo permite\n` +
        `  - Buscar campos, lotes y plantas\n\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `Transportista gerente\n\n` +
        `  - Ver asignaciones pendientes\n` +
        `  - Asignar camion y chofer\n` +
        `  - Rechazar con motivo\n` +
        `  - Consultar detalle operativo\n\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `Planta\n\n` +
        `  - Ver fletes pendientes\n` +
        `  - Aprobar fletes de productor\n` +
        `  - Asignar empresa transportista\n` +
        `  - Consultar estado de ejecucion\n\n`
      );
    }
    if (role === 'producer') {
      return (
        `Productor\n\n` +
        `  - Crear fletes indicando grano, toneladas, planta y fecha\n` +
        `  - Administrar campos y lotes\n` +
        `  - Gestionar flota propia y asignar camiones\n` +
        `  - Confirmar cargas de flota propia\n` +
        `  - Solicitar informes PDF\n` +
        `  - Seguimiento en vivo de unidades\n` +
        `  - Gestionar equipo y choferes\n\n`
      );
    }
    if (role === 'plant') {
      return (
        `Planta\n\n` +
        `  - Consultar fletes pendientes de asignacion\n` +
        `  - Asignar transportistas a fletes\n` +
        `  - Confirmar recepcion y entrega de cargas\n` +
        `  - Solicitar informes PDF\n` +
        `  - Seguimiento en vivo de unidades\n` +
        `  - Gestionar equipo\n\n`
      );
    }
    if (role === 'transporter') {
      return (
        `Transportista\n\n` +
        `  - Consultar asignaciones y fletes\n` +
        `  - Aceptar o rechazar asignaciones\n` +
        `  - Iniciar viajes\n` +
        `  - Confirmar carga con toneladas reales\n` +
        `  - Confirmar entrega en destino\n` +
        `  - Solicitar informes PDF\n` +
        `  - Gestionar choferes y camiones\n\n`
      );
    }
    return (
      `Funciones habilitadas\n\n` +
      `  - Crear y gestionar fletes\n` +
      `  - Consultar estado de fletes\n` +
      `  - Confirmar cargas y entregas\n` +
      `  - Informes PDF\n` +
      `  - Seguimiento en vivo\n\n`
    );
  }

  private getRoleFeatureSummarySafe(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `\nAcciones principales:\n` +
        `- Ver mi viaje activo\n` +
        `- Iniciar viaje\n` +
        `- Confirmar carga\n` +
        `- Confirmar entrega\n` +
        `- Adjuntar evidencia\n`
      );
    }
    if (profile === 'autonomous_driver') {
      return (
        `\nAcciones principales:\n` +
        `- Ver mi flete activo\n` +
        `- Solicitar un nuevo flete\n` +
        `- Buscar plantas, campos y lotes\n` +
        `- Finalizar el viaje\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `\nAcciones principales:\n` +
        `- Solicitar flete\n` +
        `- Ver estado y detalle de fletes\n` +
        `- Buscar campos, lotes y plantas\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `\nAcciones principales:\n` +
        `- Ver asignaciones\n` +
        `- Aceptar o rechazar viajes\n` +
        `- Asignar camion y chofer\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `\nAcciones principales:\n` +
        `- Ver fletes pendientes\n` +
        `- Aprobar solicitudes\n` +
        `- Asignar empresa transportista\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (role === 'producer') {
      return (
        `\nAcciones principales:\n` +
        `- Solicitar flete\n` +
        `- Ver estado y detalle de fletes\n` +
        `- Buscar campos, lotes y plantas\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (role === 'plant') {
      return (
        `\nAcciones principales:\n` +
        `- Ver fletes pendientes\n` +
        `- Aprobar solicitudes\n` +
        `- Asignar transportista\n` +
        `- Adjuntar documentos\n`
      );
    }
    if (role === 'transporter') {
      return (
        `\nAcciones principales:\n` +
        `- Ver asignaciones\n` +
        `- Aceptar o rechazar viajes\n` +
        `- Asignar camion y chofer\n` +
        `- Adjuntar documentos\n`
      );
    }
    return (
      `\nAcciones principales:\n` +
      `- Ver estado de fletes\n` +
      `- Consultar detalle operativo\n`
    );
  }

  private getRoleHelpSectionSafe(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `Chofer operativo\n\n` +
        `  - Consultar el viaje activo\n` +
        `  - Iniciar viaje cuando este aceptado\n` +
        `  - Confirmar carga y entrega\n` +
        `  - Adjuntar fotos o documentos\n\n`
      );
    }
    if (profile === 'autonomous_driver') {
      return (
        `Chofer autonomo\n\n` +
        `  - Solicitar un nuevo flete propio\n` +
        `  - Buscar plantas, campos y lotes\n` +
        `  - Registrar llegada y finalizar el viaje\n` +
        `  - Adjuntar fotos o documentos\n\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator') {
      return (
        `Productor\n\n` +
        `  - Solicitar fletes nuevos\n` +
        `  - Consultar estado y detalle\n` +
        `  - Buscar campos, lotes y plantas\n` +
        `  - Adjuntar documentos al flete\n\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `Transportista gerente\n\n` +
        `  - Ver asignaciones pendientes o activas\n` +
        `  - Aceptar o rechazar viajes\n` +
        `  - Asignar camion y chofer\n` +
        `  - Adjuntar documentos al flete\n\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `Planta\n\n` +
        `  - Ver fletes pendientes\n` +
        `  - Aprobar solicitudes de productor\n` +
        `  - Asignar empresa transportista\n` +
        `  - Adjuntar documentos al flete\n\n`
      );
    }
    return (
      `${role || 'Usuario'}\n\n` +
      `  - Consultar estado y detalle de fletes\n` +
      `  - Ejecutar las acciones habilitadas para su empresa activa\n\n`
    );
  }

  private getRoleStateGuideClean(role: string, profile: AiProfile): string {
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      return (
        `Estados del viaje:\n` +
        `  - ASIGNADO: aceptar o rechazar\n` +
        `  - ACEPTADO: iniciar viaje\n` +
        `  - A CAMPO: confirmar carga\n` +
        `  - A PLANTA: confirmar entrega\n\n`
      );
    }
    if (profile === 'autonomous_driver') {
      return (
        `Estados del viaje:\n` +
        `  - A CAMPO: seguir el viaje activo\n` +
        `  - A PLANTA: registrar llegada o finalizar\n\n`
      );
    }
    if (profile === 'transporter_manager') {
      return (
        `Estados clave:\n` +
        `  - ASIGNADO: aceptar o rechazar\n` +
        `  - ACEPTADO: completar camion y chofer si falta\n\n`
      );
    }
    if (profile === 'plant_manager' || profile === 'plant_operator') {
      return (
        `Estados clave:\n` +
        `  - SIN ASIGNAR: aprobar y asignar transportista\n` +
        `  - A PLANTA: confirmar recepcion si corresponde\n\n`
      );
    }
    if (profile === 'producer_manager' || profile === 'producer_operator' || role === 'producer') {
      return (
        `Estados clave:\n` +
        `  - SIN ASIGNAR: seguimiento de solicitud\n` +
        `  - ASIGNADO / ACEPTADO: seguimiento operativo\n` +
        `  - A PLANTA: controlar cierre del flete\n\n`
      );
    }
    return '';
  }

  // ======================== SHOW ACTIVE FREIGHTS ========================

  async showActiveFreights(phone: string, user: any) {
    // Resolve the user's active company — only show freights for that company
    const activeCompanyId = user.activeCompanyId || user.companyId;
    const profile = this.getAiProfile(user);

    if (!activeCompanyId) {
      await this.wa.sendText(phone, 'No se encontró una empresa activa asociada a su cuenta.');
      return;
    }

    const where: any = { status: { notIn: ['finished', 'canceled'] } };
    if (profile === 'producer_driver' || profile === 'transporter_driver' || profile === 'plant_driver') {
      where.OR = [
        {
          assignments: {
            some: {
              driverId: user.id,
              status: { in: ['active', 'accepted'] },
            },
          },
        },
        { requestedById: user.id, isAutonomous: true },
      ];
    } else {
      where.OR = [
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
      ];
    }
    const activeFreights = await this.prisma.freight.findMany({
      where,
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
      await this.wa.sendText(phone, profile.endsWith('_driver') ? 'No tenes viajes activos en este momento.' : 'No se registran fletes activos en este momento.');
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

    const noun = profile.endsWith('_driver') ? 'viaje' : 'flete';
    const selConfig = {
      headerText: `🚛 ${activeFreights.length} ${noun}${activeFreights.length > 1 ? 's' : ''} activo${activeFreights.length > 1 ? 's' : ''}.\n\nSeleccione uno para ver el detalle.`,
      listButtonLabel: profile.endsWith('_driver') ? 'VER VIAJES' : 'VER FLETES',
      sectionTitle: profile.endsWith('_driver') ? 'VIAJES ACTIVOS' : 'FLETES ACTIVOS',
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

    const userInclude = {
      company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true, autonomousDriverEnabled: true } },
      memberships: {
        where: { active: true },
        include: { company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true, autonomousDriverEnabled: true } } },
      },
    };

    // 1) Direct lookup by user phone
    const user = await this.prisma.user.findFirst({
      where: {
        active: true,
        OR: variants.map(p => ({ phone: p })),
      },
      include: userInclude,
    });

    if (user) { (user as any).sub = user.id; return user; }

    // 2) Fallback: lookup by company phone → find first active user of that company
    const company = await this.prisma.company.findFirst({
      where: { OR: variants.map(p => ({ phone: p })) },
      select: { id: true },
    });

    if (company) {
      const companyUser = await this.prisma.user.findFirst({
        where: { active: true, companyId: company.id },
        include: userInclude,
        orderBy: { createdAt: 'asc' },
      });
      if (companyUser) { (companyUser as any).sub = companyUser.id; return companyUser; }
    }

    return null;
  }

  // ======================== BUILD SYNTHETIC USER ========================

  buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUserHelper(dbUser);
  }
}
