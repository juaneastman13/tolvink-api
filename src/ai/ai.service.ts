// =====================================================================
// TOLVINK — AI Service (Claude / Anthropic)
// Conversational assistant for WhatsApp with tool use
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from '../freights/freights.service';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { OcrService } from '../ocr/ocr.service';
import { AssignmentSuggestionsService } from '../freights/assignment-suggestions.service';
import Anthropic from '@anthropic-ai/sdk';
import { buildSyntheticUser } from '../common/build-synthetic-user';
import {
  resolveCompanyTypes as _resolveCompanyTypes,
  resolveActiveRole as _resolveActiveRole,
  isProducerMembership as _isProducerMembership,
  hasType as _hasType,
  sanitizeForPrompt as _sanitizeForPrompt,
  aiBuildSyntheticUser,
} from './ai.utils';
import { ResponseFormatterService } from './response/response-formatter.service';
import { SessionManagerService } from './session/session-manager.service';
import { PromptBuilderService } from './prompt/prompt-builder.service';
import { IntentRouterService } from './routing/intent-router.service';
import { AiContextService } from './tools/ai-context.service';
import { LocationToolsService } from './tools/location-tools.service';
import { AdminToolsService } from './tools/admin-tools.service';
import { TransportToolsService } from './tools/transport-tools.service';
import { FreightQueryToolsService } from './tools/freight-query-tools.service';
import { FreightActionToolsService } from './tools/freight-action-tools.service';
import { createSignedToken } from '../common/signed-token';
import { fuzzySearch, classifyFuzzyResult, ENTITY_ALIASES } from '../common/fuzzy-match';
import * as crypto from 'crypto';
import * as bcryptAi from 'bcryptjs';
import {
  MAX_HISTORY, MAX_TOOL_LOOPS, AI_SESSION_TIMEOUT_MIN, APP_URL, OWN_FLEET_SHORTCUT,
  MODEL_ID, MODEL_ID_FAST, MODEL_TEMPERATURE, MODEL_MAX_TOKENS, MAX_RESPONSE_CHARS, STALE_SESSION_MIN,
  URUGUAY_UTC_OFFSET_MS, FREIGHT_STATUS_LABELS, FREIGHT_STATUS_SHORT, AUDIO_FILLERS,
  AI_RATE_LIMIT_WINDOW_MS, AI_RATE_LIMIT_MAX,
} from './ai.constants';
import { AI_TOOL_DEFINITIONS } from './ai-tool-definitions';

const aiRateMap = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class AiService implements OnModuleDestroy {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;
  // Access side-effects map via public API on SessionManagerService
  get _chatSideEffects(): Map<string, Record<string, any>> {
    return this.sessionManager.getChatSideEffectsMap();
  }
  // Per-session lock to prevent concurrent chat() calls from racing on side-effects
  private _chatLocks = new Set<string>();
  private rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of aiRateMap) { if (now > v.resetAt) aiRateMap.delete(k); }
    // Hard cap on rate map — evict oldest entries if too large
    if (aiRateMap.size > 10_000) {
      const iter = aiRateMap.keys();
      while (aiRateMap.size > 8_000) {
        const k = iter.next().value;
        if (k) aiRateMap.delete(k); else break;
      }
    }
    // Clean stale request_location cooldowns via public API
    this.locationTools.cleanupCooldowns();
    // Clean stale side effects — delegated to SessionManagerService
    this.sessionManager.cleanStaleSideEffects();
  }, 5 * 60 * 1000);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
    @Inject(forwardRef(() => WhatsAppService)) private wa: WhatsAppService,
    private fieldsService: FieldsService,
    private trucksService: TrucksService,
    private adminService: AdminService,
    private ocrService: OcrService,
    private assignmentSuggestions: AssignmentSuggestionsService,
    private responseFormatter: ResponseFormatterService,
    private sessionManager: SessionManagerService,
    private promptBuilder: PromptBuilderService,
    private intentRouter: IntentRouterService,
    private aiContext: AiContextService,
    private locationTools: LocationToolsService,
    private adminTools: AdminToolsService,
    private transportTools: TransportToolsService,
    private freightQueryTools: FreightQueryToolsService,
    private freightActionTools: FreightActionToolsService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log(`Claude AI assistant enabled (${MODEL_ID})`);
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI assistant disabled');
    }
  }

  onModuleDestroy() { clearInterval(this.rateCleanupTimer); }

  isEnabled(): boolean {
    return !!this.client;
  }

  // ======================== MODEL SELECTION ==============================

  /** @deprecated Use IntentRouterService.selectModel() */
  private selectModel(message: string, hasHistory: boolean): string {
    return this.intentRouter.selectModel(message, hasHistory);
  }

  // ======================== MAIN CHAT METHOD =============================

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } }> {
    if (!this.client) {
      return { text: 'El asistente IA no está disponible en este momento.' };
    }

    // Per-user rate limiting — check BEFORE acquiring session lock to avoid lock leak
    const now = Date.now();
    const userId = user.id || phone;
    const rateEntry = aiRateMap.get(userId);
    if (rateEntry && now < rateEntry.resetAt) {
      if (rateEntry.count >= AI_RATE_LIMIT_MAX) {
        return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
      }
      rateEntry.count++;
    } else {
      aiRateMap.set(userId, { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW_MS });
    }

    // Per-session lock: prevent concurrent chat() calls from racing on side-effects
    if (this._chatLocks.has(session.id)) {
      return { text: 'Estoy procesando su mensaje anterior, aguarde un momento.' };
    }
    this._chatLocks.add(session.id);
    // NOTE: rate map cleanup runs in rateCleanupTimer (setInterval) — not here, to avoid
    // mutations between lock acquisition and try/finally, and to prevent concurrent iteration.

    // WhatsApp session may have a selectedCompanyId different from user.activeCompanyId
    // (WhatsApp company selection is session-scoped to avoid desyncing the web app).
    const sessionState = (session?.flowState as any) || {};
    const sessionCompanyId = sessionState.selectedCompanyId;
    if (sessionCompanyId && sessionCompanyId !== user.activeCompanyId) {
      // Validate that sessionCompanyId is a company the user actually belongs to
      const isMember = (user.memberships || []).some((m: any) => m.companyId === sessionCompanyId && m.active !== false);
      if (isMember) {
        user.activeCompanyId = sessionCompanyId;
      } else {
        this.logger.warn(`Session selectedCompanyId ${sessionCompanyId} not in user ${user.id} memberships — ignoring`);
      }
    }

    const synUser = this.aiContext.buildSyntheticUser(user);
    const companyType = this.aiContext.resolveCompanyType(user);
    const isWeb = phone === 'web';

    // Resolve plant access levels for CONSULTA blocking (Strategy A + B)
    // NOTE: This is freshly queried on every chat() call, so session recovery
    // (lines below) does NOT carry over a stale plantAccessMap.
    const plantAccessMap = await this.resolveUserPlantAccess(user);

    const systemPrompt = await this.promptBuilder.build(user, companyType, isWeb, plantAccessMap);

    // Cap message length to prevent context window abuse (5000 chars max)
    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    // Preprocess: clean audio fillers, normalize whitespace
    const cleanedMessage = this.responseFormatter.preprocessMessage(cappedMessage);

    // Load conversation history from session
    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Stale session detection: inject context note if conversation paused
    let messageToSend = cleanedMessage;
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessages.length > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el último mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Pending document: inject context so AI knows to use attach_document
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()áéíóúñÁÉÍÓÚÑ]/g, '').slice(0, 60);
      const activeCode = state.activeContext?.lastFreightCode;
      if (activeCode) {
        messageToSend = `[Sistema: ARCHIVO PENDIENTE "${safeName}" (${doc.type}). ADJUNTAR DIRECTAMENTE al flete activo ${this.sanitizeForPrompt(activeCode)}. Usar attach_document(code="${this.sanitizeForPrompt(activeCode)}") y mostrar confirmación con botones. NO preguntar a qué flete.]\n\n${messageToSend}`;
      } else {
        messageToSend = `[Sistema: ARCHIVO PENDIENTE "${safeName}" (${doc.type}). No hay flete activo. Preguntar a qué flete adjuntarlo o buscar fletes recientes.]\n\n${messageToSend}`;
      }
    }

    // Inject active context — directive format so Claude acts on active freight directly
    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      if (ac.lastFreightCode) {
        messageToSend = `[FLETE ACTIVO: ${this.sanitizeForPrompt(ac.lastFreightCode)}. REGLA: Toda acción del usuario sobre "el flete", "este", "ese", o sin especificar código, se ejecuta sobre ${this.sanitizeForPrompt(ac.lastFreightCode)}. NO preguntar cuál flete. Resumen: ${this.sanitizeForPrompt(ac.lastFreightSummary || '')}. Última acción: ${this.sanitizeForPrompt(ac.lastAction || 'ninguna')}.${ac.lastSearchFilter ? ` Último filtro: ${this.sanitizeForPrompt(ac.lastSearchFilter)}.` : ''}]\n\n${messageToSend}`;
      } else if (ac.lastSearchFilter) {
        messageToSend = `[Contexto activo: último filtro: ${this.sanitizeForPrompt(ac.lastSearchFilter)}]\n\n${messageToSend}`;
      }
    }

    // P1 fix: inject recovered context from expired session
    if (state._sessionExpiredNote && state._recoveredContext) {
      const rc = state._recoveredContext;
      const parts: string[] = [];
      if (rc.lastFreightCode) parts.push(`último flete: ${this.sanitizeForPrompt(rc.lastFreightCode)}`);
      if (rc.lastAction) parts.push(`última acción: ${this.sanitizeForPrompt(rc.lastAction)}`);
      if (rc.lastSearchFilter) parts.push(`último filtro: ${this.sanitizeForPrompt(rc.lastSearchFilter)}`);
      if (parts.length > 0) {
        messageToSend = `[Sistema: la sesión anterior expiró. Contexto recuperado: ${parts.join('. ')}. Informar brevemente al usuario que su sesión anterior expiró y ofrecerse a retomar.]\n\n${messageToSend}`;
      }
    }

    // Inject pending action context so AI knows there's an unconfirmed operation
    if (state.pendingAction) {
      const pa = state.pendingAction;
      messageToSend = `[Sistema: hay una acción pendiente de confirmación: ${this.sanitizeForPrompt(pa.summary || pa.tool || '')}. Si el usuario confirma → confirm_action. Si cancela o cambia de tema → ignorar la acción pendiente.]\n\n${messageToSend}`;
    }

    // Add user message
    aiMessages.push({ role: 'user', content: messageToSend });

    // Smart trim: keep recent messages + preserve tool results from older ones
    const trimmed = this.sessionManager.smartTrimHistory(aiMessages);

    let response: any;
    let loopCount = 0;
    const currentMessages = [...trimmed];

    // Initialize per-call side-effects accumulator (tools write here, merged at end)
    this._chatSideEffects.delete(session.id);

    // Filter tools by role — don't expose admin/mutation tools to unauthorized roles
    const filteredTools = this.getFilteredTools(user, companyType, isWeb);

    // Select model based on message complexity (Haiku for simple, Sonnet for complex)
    const selectedModel = this.selectModel(cleanedMessage, aiMessages.length > 0);
    if (selectedModel !== MODEL_ID) {
      this.logger.log(`Using fast model (${selectedModel}) for simple query`);
    }

    // Global timeout for entire tool execution loop (H1: prevent hanging)
    const loopDeadline = Date.now() + 90_000; // 90s max for all loops

    try {
      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline exceeded after ${loopCount} iterations`);
          break;
        }

        // Use fast model only on first loop; tool-result loops need full reasoning
        const modelForLoop = loopCount === 1 ? selectedModel : MODEL_ID;
        this.logger.log(`Sending to Claude (loop ${loopCount}, model=${modelForLoop}), messages: ${currentMessages.length}`);
        const createParams = {
          model: modelForLoop,
          max_tokens: isWeb ? 2400 : MODEL_MAX_TOKENS,
          temperature: MODEL_TEMPERATURE,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: filteredTools.map((t, i, arr) =>
            i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
          ) as any,
          messages: currentMessages,
        };

        // P2-7: Claude API call with 1 retry on transient errors (timeout, 529, 500)
        const callClaude = async (): Promise<any> => {
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeout = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Claude API timeout')), 45_000);
          });
          try {
            if (onDelta) {
              let isFirst = true;
              const stream = this.client.messages.stream(createParams as any);
              stream.on('text', (text) => { try { onDelta(text, isFirst); isFirst = false; } catch {} });
              const streamResult = Promise.resolve(stream.finalMessage());
              return await Promise.race([streamResult, timeout]);
            } else {
              const apiCall = this.client.messages.create(createParams as any);
              return await Promise.race([apiCall, timeout]);
            }
          } finally {
            clearTimeout(timeoutHandle!);
          }
        };
        try {
          response = await callClaude();
        } catch (retryErr: any) {
          const status = retryErr?.status || retryErr?.statusCode;
          const isTransient = !status || status === 529 || status >= 500 || retryErr.message?.includes('timeout');
          if (isTransient && Date.now() + 50_000 < loopDeadline) {
            this.logger.warn(`Claude API transient error (${retryErr.message}), retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            response = await callClaude();
          } else {
            throw retryErr;
          }
        }
        this.logger.log(`Claude response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

        if (response.stop_reason === 'tool_use') {
          // Add assistant response to messages
          currentMessages.push({ role: 'assistant', content: response.content });

          // Execute tool calls — parallel for read-only tools, sequential otherwise
          const READ_ONLY_TOOLS = new Set([
            'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
            'search_fields', 'search_lots', 'get_user_profile',
            'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
            'list_documents', 'freight_history', 'get_dashboard',
            'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
            'navigate_app',
          ]);

          const toolBlocks = response.content.filter((b: any) => b.type === 'tool_use');
          const allReadOnly = toolBlocks.every((b: any) => READ_ONLY_TOOLS.has(b.name));

          let toolResults: any[];
          if (allReadOnly && toolBlocks.length > 1) {
            // Execute all read-only tools in parallel
            this.logger.log(`Executing ${toolBlocks.length} read-only tools in parallel`);
            const settled = await Promise.allSettled(toolBlocks.map(async (block: any) => {
              this.logger.log(`AI tool call (parallel): ${block.name}`);
              const result = await this.executeTool(block.name, block.input, user, synUser, session, plantAccessMap);
              return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
            }));
            toolResults = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : { type: 'tool_result' as const, tool_use_id: toolBlocks[i].id, content: 'Error: ' + (s.reason?.message || 'Unknown error'), is_error: true },
            );
          } else {
            // Sequential execution for mutating tools or single tool
            toolResults = [];
            for (const block of toolBlocks) {
              this.logger.log(`AI tool call: ${(block as any).name}`);
              const result = await this.executeTool((block as any).name, (block as any).input, user, synUser, session, plantAccessMap);
              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: (block as any).id,
                content: result,
              });
            }
          }

          currentMessages.push({ role: 'user', content: toolResults });
        } else {
          break;
        }
      }

      // If loop exhausted while AI still wanted to call tools, provide graceful fallback
      if (response.stop_reason === 'tool_use' && loopCount >= MAX_TOOL_LOOPS) {
        this.logger.warn(`Tool loop exhausted at ${MAX_TOOL_LOOPS} iterations — AI wanted more tool calls`);
        // Extract any partial text the AI produced alongside the tool_use
        const partialText = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim();
        if (partialText) {
          // Use the partial text as the response
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: partialText }] };
        } else {
          // No text at all — the AI was mid-operation, provide a helpful message
          const activeCtx = state.activeContext?.lastFreightCode
            ? ` sobre el flete ${state.activeContext.lastFreightCode}`
            : '';
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: `La operación${activeCtx} requiere más pasos de los que puedo completar en una sola interacción. Por favor, intente con un pedido más específico o utilice la plataforma web: ${APP_URL}` }] };
        }
      }

      // Extract text response
      const textBlocks = response.content.filter((b: any) => b.type === 'text');
      let finalText = textBlocks.map((b: any) => b.text).join('\n') || 'No se pudo procesar el mensaje.';

      // Post-process: validate quality, strip UUIDs, enforce length
      finalText = this.responseFormatter.validateResponse(finalText, isWeb);

      // Save updated history — reload session first to preserve tool-written state (e.g. pendingFreight)
      currentMessages.push({ role: 'assistant', content: response.content });

      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};
      const latestFlowStep = freshSession?.flowStep ?? session.flowStep;
      const latestFlowType = freshSession?.flowType ?? session.flowType;

      // Merge tool side-effects (accumulated by storePendingSelection, stageAction, updateActiveContext)
      const sideEffects = this._chatSideEffects.get(session.id) || {};
      this._chatSideEffects.delete(session.id);

      // Extract pending buttons: side-effects take priority over DB state
      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, _sessionExpiredNote: _expNote, _recoveredContext: _recCtx, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, _navigate, ...otherSideEffects } = sideEffects;

      // Merge activeContext: DB state + side-effects
      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      // Trim old tool_result content to prevent flowState bloat (cap: 800 chars each)
      const trimmedMessages = currentMessages.slice(-MAX_HISTORY).map((msg, idx, arr) => {
        // Only trim tool_result messages that are not in the last 8 messages
        if (idx < arr.length - 8 && msg.role === 'user' && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(block =>
            block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 800
              ? { ...block, content: block.content.slice(0, 800) + '...[trimmed]' }
              : block
          )};
        }
        return msg;
      });
      const updateData: any = {
        flowState: {
          ...cleanState,
          ...otherSideEffects,
          ...(mergedActiveContext ? { activeContext: mergedActiveContext } : {}),
          aiMessages: _clearAiMessages ? [] : trimmedMessages,
          lastMessageAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
      };
      if (latestFlowStep !== session.flowStep) updateData.flowStep = latestFlowStep;
      if (latestFlowType !== session.flowType) updateData.flowType = latestFlowType;

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: updateData,
      });

      return { text: finalText, buttons: pendingButtons, navigate: _navigate };
    } catch (e) {
      this._chatSideEffects.delete(session.id);
      this.logger.error(`Chat error [session=${session.id} user=${user.id} company=${user.activeCompanyId}]: ${e.message}`, e.stack?.slice(0, 500));
      return { text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente o utilice las opciones del menú.' };
    } finally {
      this._chatLocks.delete(session.id);
    }
  }

  // ======================== SYSTEM PROMPT ================================

  /** @deprecated Use sanitizeForPrompt from ai.utils.ts */
  private sanitizeForPrompt(s: string): string {
    return _sanitizeForPrompt(s);
  }

  /** @deprecated Use PromptBuilderService.build() */
  private async buildSystemPrompt(user: any, companyType: string, isWeb = false): Promise<string> {
    return this.promptBuilder.build(user, companyType, isWeb);
  }

  // Tool sets moved to IntentRouterService

  /** @deprecated Use IntentRouterService.getFilteredTools() */
  private getFilteredTools(user: any, companyType: string, isWeb = false): any[] {
    return this.intentRouter.getFilteredTools(user, companyType, isWeb);
  }


  // ======================== TOOL DEFINITIONS =============================

  private readonly tools = AI_TOOL_DEFINITIONS;


  // ======================== TOOL EXECUTION ===============================

  // Tools that represent completed actions — track in activeContext.lastAction
  private static readonly ACTION_TOOLS = new Set([
    'confirm_action', 'confirm_create_freight', 'accept_freight', 'reject_freight',
    'start_freight', 'confirm_loaded', 'confirm_finished', 'cancel_freight',
    'assign_transporter', 'authorize_freight', 'create_field', 'create_lot',
    'create_truck', 'create_user', 'update_freight', 'duplicate_freight',
  ]);

  // Tools blocked for CONSULTA (READONLY) users — Strategy A pre-check
  private static readonly CONSULTA_BLOCKED_TOOLS = new Set([
    'prepare_freight', 'confirm_create_freight', 'confirm_action',
    'accept_freight', 'reject_freight',
    'start_freight', 'confirm_loaded', 'confirm_finished',
    'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished', 'respond_trip',
    'cancel_freight', 'assign_transporter', 'assign_truck_to_freight', 'assign_truck_to_trip',
    'assign_multi_trucks', 'update_assignment', 'cancel_assignment',
    'update_freight', 'duplicate_freight', 'authorize_freight',
    'approve_pending_change', 'reject_pending_change',
    'attach_document', 'delete_document', 'save_ocr_data',
    'create_field', 'create_lot', 'update_field', 'update_lot', 'delete_field', 'delete_lot',
    'create_truck', 'create_driver', 'update_truck', 'update_driver', 'delete_truck', 'delete_driver',
    'generate_location_link',
  ]);

  /**
   * Resolve the user's access level with ALL plants they interact with.
   * Returns a map of plantCompanyId → accessLevel.
   * If the user IS the plant, they get full access (null = no restriction).
   */
  private async resolveUserPlantAccess(user: any): Promise<Map<string, string>> {
    const activeCoId = user.activeCompanyId || user.companyId;
    if (!activeCoId) return new Map();

    // Query all CompanyAccess records where user's company is the grantee
    const accesses = await this.prisma.companyAccess.findMany({
      where: {
        granteeCompanyId: activeCoId,
        isActive: true,
      },
      select: {
        grantorCompanyId: true,
        accessLevel: true,
        grantorCompany: { select: { name: true } },
      },
      take: 100,
    });

    const map = new Map<string, string>();
    for (const a of accesses) {
      map.set(a.grantorCompanyId, a.accessLevel);
    }
    return map;
  }

  /**
   * Check if user is CONSULTA (READONLY) with ANY plant.
   * Returns true if ALL plant relationships are READONLY (i.e., user cannot operate with any plant).
   */
  private isGlobalConsulta(plantAccessMap: Map<string, string>): boolean {
    if (plantAccessMap.size === 0) return false; // No relationships = not restricted
    for (const level of plantAccessMap.values()) {
      if (level !== 'READONLY') return false; // Has at least one OPERATOR relationship
    }
    return true;
  }

  // Tools that search/filter — track in activeContext.lastSearchFilter
  private static readonly SEARCH_TOOLS = new Set([
    'list_freights', 'summarize_freights',
  ]);

  private async executeTool(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
    plantAccessMap?: Map<string, string>,
  ): Promise<string> {
    try {
      // Strategy A: Pre-check — block action tools for CONSULTA users
      if (plantAccessMap && AiService.CONSULTA_BLOCKED_TOOLS.has(toolName)) {
        const isConsulta = this.isGlobalConsulta(plantAccessMap);
        if (isConsulta) {
          // Find any plant name for the redirect message
          let plantName = 'la planta';
          for (const [plantId, level] of plantAccessMap) {
            if (level === 'READONLY') {
              const co = await this.prisma.company.findUnique({ where: { id: plantId }, select: { name: true } });
              if (co?.name) { plantName = co.name; break; }
            }
          }
          return JSON.stringify({
            blocked: true,
            message: `Esta acción la gestiona ${plantName}. Contactalos directamente para coordinar. ¿Querés que te pase el estado de algún flete?`,
          });
        }
      }

      // Track search filters in active context
      if (AiService.SEARCH_TOOLS.has(toolName) && session?.id) {
        const filterParts: string[] = [];
        if (input.status) filterParts.push(`estado=${input.status}`);
        if (input.grain) filterParts.push(`grano=${input.grain}`);
        if (input.dateFrom) filterParts.push(`desde=${input.dateFrom}`);
        if (input.dateTo) filterParts.push(`hasta=${input.dateTo}`);
        if (filterParts.length > 0) {
          this.sessionManager.updateActiveContext(session.id, { lastSearchFilter: filterParts.join(', ') });
        }
      }

      const result = await this._executeToolInner(toolName, input, user, synUser, session);

      // Strategy B: Strip action buttons/selection from read-only results for CONSULTA users
      if ((toolName === 'get_freight_detail' || toolName === 'list_freights' || toolName === 'list_my_freights') && plantAccessMap && this.isGlobalConsulta(plantAccessMap) && session?.id) {
        const effects = this.sessionManager.getSideEffects(session.id);
        if (effects?._pendingSelection) delete effects._pendingSelection;
        if (effects?._pendingButtons) delete effects._pendingButtons;
        this.sessionManager.setSideEffects(session.id, effects);
      }

      // Track completed actions in active context
      if (AiService.ACTION_TOOLS.has(toolName) && session?.id) {
        const code = input.code || '';
        this.sessionManager.updateActiveContext(session.id, { lastAction: `${toolName}${code ? ` (${code})` : ''}` });
      }

      return result;
    } catch (e) {
      this.logger.error(`Tool ${toolName} error: ${e.message}`);
      const SAFE_PATTERNS = [
        /no (se )?encontr/i, /no tiene acceso/i, /no se puede/i, /solo.*pueden/i,
        /no.*permiso/i, /ya existe/i, /no pertenec/i, /flete.*no/i, /campo.*no/i,
        /lote.*no/i, /camión.*no/i, /código.*requerido/i, /inválid/i,
      ];
      const isSafe = SAFE_PATTERNS.some(p => p.test(e.message || ''));
      const safeMsg = isSafe ? e.message : 'Error al procesar la solicitud.';
      return JSON.stringify({ error: safeMsg });
    }
  }

  private async _executeToolInner(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
      // ---- Freight Queries (read-only) ----
      switch (toolName) {
        case 'list_freights': return await this.freightQueryTools.toolListFreights(synUser, input, session);
        case 'get_freight_detail': return await this.freightQueryTools.toolGetFreightDetail(input, user, session);
        case 'summarize_freights': return await this.freightQueryTools.toolSummarizeFreights(synUser, input);
        case 'get_dashboard': return await this.freightQueryTools.toolGetDashboard(user);
        case 'freight_history': return await this.freightQueryTools.toolFreightHistory(input, user);
        case 'list_documents': return await this.freightQueryTools.toolListDocuments(input, user);
        case 'search_plants': return await this.freightQueryTools.toolSearchPlants(input, user, session);
        case 'list_lots': return await this.freightQueryTools.toolListLots(user, session, input);
        case 'list_fields': return await this.freightQueryTools.toolListFields(user, session);
        case 'search_fields': return await this.freightQueryTools.toolSearchFields(input, user);
        case 'search_lots': return await this.freightQueryTools.toolSearchLots(input, user);
        // ---- Freight Actions (mutations) ----
        case 'prepare_freight': return await this.freightActionTools.toolPrepareFreight(input, user, session);
        case 'confirm_create_freight': return await this.freightActionTools.toolConfirmCreateFreight(user, synUser, session);
        case 'confirm_action': return await this.freightActionTools.toolConfirmAction(user, synUser, session);
        case 'accept_freight': return await this.freightActionTools.toolAcceptFreight(input, user, synUser, session);
        case 'reject_freight': return await this.freightActionTools.toolRejectFreight(input, user, synUser, session);
        case 'start_freight': return await this.freightActionTools.toolStartFreight(input, user, synUser, session);
        case 'confirm_loaded': return await this.freightActionTools.toolConfirmLoaded(input, user, synUser, session);
        case 'confirm_finished': return await this.freightActionTools.toolConfirmFinished(input, user, synUser, session);
        case 'cancel_freight': return await this.freightActionTools.toolCancelFreight(input, user, synUser, session);
        case 'update_freight': return await this.freightActionTools.toolUpdateFreight(input, user, session);
        case 'duplicate_freight': return await this.freightActionTools.toolDuplicateFreight(input, user, synUser, session);
        case 'authorize_freight': return await this.freightActionTools.toolAuthorizeFreight(input, user, session);
        case 'approve_pending_change': return await this.freightActionTools.toolApprovePendingChange(input, user, session);
        case 'reject_pending_change': return await this.freightActionTools.toolRejectPendingChange(input, user, session);
        case 'respond_trip': return await this.freightActionTools.toolRespondTrip(input, user, session);
        case 'start_trip': return await this.freightActionTools.toolStartTrip(input, user, session);
        case 'confirm_trip_loaded': return await this.freightActionTools.toolConfirmTripLoaded(input, user, session);
        case 'confirm_trip_finished': return await this.freightActionTools.toolConfirmTripFinished(input, user, session);
        case 'create_field': return await this.freightActionTools.toolCreateField(input, user, session);
        case 'create_lot': return await this.freightActionTools.toolCreateLot(input, user, session);
        case 'update_field': return await this.freightActionTools.toolUpdateField(input, user, session);
        case 'update_lot': return await this.freightActionTools.toolUpdateLot(input, user, session);
        case 'attach_document': return await this.freightActionTools.toolAttachDocument(input, user, synUser, session);
        case 'delete_document': return await this.freightActionTools.toolDeleteDocument(input, user, session);
        case 'save_ocr_data': return await this.freightActionTools.toolSaveOcrData(input, user, session);
        case 'ocr_analyze': return await this.freightActionTools.toolOcrAnalyze(input, user, session);
        case 'reactivate_user': return await this.freightActionTools.toolReactivateUser(input, user, session);
        // ---- Transport & Assignment ----
        case 'list_trucks': return await this.transportTools.toolListTrucks(user, session);
        case 'create_truck': return await this.transportTools.toolCreateTruck(input, user, session);
        case 'list_transporters': return await this.transportTools.toolListTransporters(input, user, session);
        case 'assign_transporter': return await this.transportTools.toolAssignTransporter(input, user, synUser, session);
        case 'assign_truck_to_trip': return await this.transportTools.toolAssignTruckToTrip(input, user, synUser, session);
        case 'assign_truck_to_freight': return await this.transportTools.toolAssignTruckToFreight(input, user, synUser, session);
        case 'list_drivers': return await this.transportTools.toolListDrivers(user, session);
        case 'cancel_assignment': return await this.transportTools.toolCancelAssignment(input, user, session);
        case 'update_assignment': return await this.transportTools.toolUpdateAssignment(input, user, session);
        case 'create_driver': return await this.transportTools.toolCreateDriver(input, user, session);
        case 'deactivate_truck': return await this.transportTools.toolDeactivateTruck(input, user, session);
        case 'update_truck': return await this.transportTools.toolUpdateTruck(input, user, session);
        case 'deactivate_driver': return await this.transportTools.toolDeactivateDriver(input, user, session);
        case 'assign_multi_trucks': return await this.transportTools.toolAssignMultiTrucks(input, user, session);
        case 'view_driver_queue': return await this.transportTools.toolViewDriverQueue(input, user);
        case 'reorder_driver_queue': return await this.transportTools.toolReorderDriverQueue(input, user, session);
        // ---- Admin & User Management ----
        case 'get_user_profile': return this.adminTools.toolGetUserProfile(user);
        case 'create_user': return await this.adminTools.toolCreateUser(input, user, session);
        case 'list_company_users': return await this.adminTools.toolListCompanyUsers(user, session);
        case 'update_user_role': return await this.adminTools.toolUpdateUserRole(input, user, session);
        case 'deactivate_user': return await this.adminTools.toolDeactivateUser(input, user, session);
        case 'switch_company': return await this.adminTools.toolSwitchCompany(input, user, session);
        case 'update_profile': return await this.adminTools.toolUpdateProfile(input, user, session);
        case 'update_user_admin': return await this.adminTools.toolUpdateUserAdmin(input, user, session);
        case 'update_company': return await this.adminTools.toolUpdateCompany(input, user, session);
        case 'list_enabled_plants': return await this.adminTools.toolListEnabledPlants(user);
        case 'list_enabled_producers': return await this.adminTools.toolListEnabledProducers(user);
        case 'grant_producer_access': return await this.adminTools.toolGrantProducerAccess(input, user, session);
        case 'revoke_producer_access': return await this.adminTools.toolRevokeProducerAccess(input, user, session);
        case 'list_branches': return await this.adminTools.toolListBranches(user);
        case 'create_branch': return await this.adminTools.toolCreateBranch(input, user, session);
        case 'update_branch': return await this.adminTools.toolUpdateBranch(input, user, session);
        case 'delete_branch': return await this.adminTools.toolDeleteBranch(input, user, session);
        case 'get_assignment_suggestions': return await this.adminTools.toolGetAssignmentSuggestions(input, user);
        // ---- Location & Maps ----
        case 'generate_location_link': return this.locationTools.toolGenerateLocationLink(input, session);
        case 'generate_tracking_link': return await this.locationTools.toolGenerateTrackingLink(input, user);
        case 'generate_map_link': return await this.locationTools.toolGenerateMapLink(input);
        case 'generate_report_link': return await this.locationTools.toolGenerateReportLink(input, user);
        case 'generate_shared_link': return await this.locationTools.toolGenerateSharedLink(input, user);
        case 'generate_daily_map_link': return await this.locationTools.toolGenerateDailyMapLink(user);
        case 'generate_batch_report_link': return await this.locationTools.toolGenerateBatchReportLink(input, user);
        case 'share_live_location': return await this.locationTools.toolShareLiveLocation(input, user);
        case 'view_live_locations': return await this.locationTools.toolViewLiveLocations(input, user);
        case 'request_location': return await this.locationTools.toolRequestLocation(input, user);
        case 'navigate_app': return this.locationTools.toolNavigateApp(input, session);
        default: return JSON.stringify({ error: 'Herramienta no reconocida' });
    }
  }

}
