// =====================================================================
// TOLVINK — Main AI Agent Service
// Supports OpenAI and Gemini via AI_PROVIDER env var
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { GeminiClient, GeminiMessage, GeminiCallResult } from './gemini.client';
import { OpenAIClient } from './openai.client';
import { PromptBuilderService } from '../prompt/prompt-builder';
import { SessionManagerService } from '../conversation/session-manager';
import { HistoryManagerService } from '../conversation/history-manager';
import { ContextBuilderService } from '../conversation/context-builder';
import { ToolExecutorService } from '../tools/tool-executor';
import { ToolRegistryService } from '../tools/tool-registry';
import { filterToolsByRole, READ_ONLY_TOOLS } from '../tools/tool-permissions';
import { resolveActiveRole } from '../utils/ai-utils';
import { selectThinkingLevel } from './thinking-router';
import { checkRateLimit, cleanupRateLimits } from '../utils/rate-limiter';
import { preprocessMessage, validateResponse, normalizeSpokenNumbers, ensureConfirmationButtons } from '../utils/message-formatter';
import { classifyAiError, sanitizeErrorForLog } from '../utils/error-handler';
import { RunTree } from 'langsmith/run_trees';
import { acquirePgLockWithWait, releasePgLock } from '../../common/distributed-lock';
import {
  AI_PROVIDER, MAX_TOOL_ITERATIONS, TOOL_TIMEOUT_MS, SESSION_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES, PROMPT_CACHE_TTL_MS, APP_URL,
} from './constants';

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private _chatLocks = new Set<string>();
  private _promptCache = new Map<string, { prompt: string; ts: number }>();
  private readonly LOCK_WAIT_MS = 3_000;
  private readonly LOCK_WAIT_STEP_MS = 300;
  private readonly langsmithEnabled = String(process.env.LANGSMITH_TRACING || '').toLowerCase() === 'true' && !!process.env.LANGSMITH_API_KEY;
  private readonly CORE_TOOLS = new Set<string>([
    'list_freights', 'get_freight_detail', 'summarize_freights', 'get_dashboard',
    'prepare_freight', 'confirm_create_freight', 'confirm_action',
    'search_plants', 'search_fields', 'search_lots', 'list_fields', 'list_lots',
    'generate_tracking_link', 'generate_report_link',
  ]);
  private readonly FREIGHT_ACTION_TOOLS = new Set<string>([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded', 'confirm_finished',
    'cancel_freight', 'authorize_freight', 'duplicate_freight', 'update_freight',
    'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
    'assign_transporter', 'assign_truck_to_trip', 'assign_truck_to_freight',
    'cancel_assignment', 'update_assignment',
    'assign_external_truck', 'edit_external_assignment',
  ]);
  private readonly AUTONOMOUS_TOOLS = new Set<string>([
    'prepare_autonomous_freight', 'finish_autonomous_freight', 'register_plant_arrival',
  ]);

  private cleanupTimer = setInterval(() => {
    cleanupRateLimits();
    this.sessionManager.cleanStaleSideEffects();
    this.toolExecutor.cleanupCooldowns();
    // Clean prompt cache
    const now = Date.now();
    for (const [k, v] of this._promptCache) {
      if (now - v.ts > PROMPT_CACHE_TTL_MS) this._promptCache.delete(k);
    }
  }, 5 * 60 * 1000);

  /** Active AI provider interface — both GeminiClient and OpenAIClient expose the same methods. */
  private activeClient: { generateContent: (...args: any[]) => Promise<GeminiCallResult>; convertToolDeclarations: (tools: any[]) => any[]; isEnabled: () => boolean };

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiClient,
    private openai: OpenAIClient,
    private promptBuilder: PromptBuilderService,
    private sessionManager: SessionManagerService,
    private historyManager: HistoryManagerService,
    private contextBuilder: ContextBuilderService,
    private toolExecutor: ToolExecutorService,
    private toolRegistry: ToolRegistryService,
  ) {
    this.activeClient = AI_PROVIDER === 'gemini' ? this.gemini : this.openai;
    this.logger.log(`AI provider: ${AI_PROVIDER}`);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  isEnabled(): boolean {
    return this.activeClient.isEnabled();
  }

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } }> {
    if (!this.activeClient.isEnabled()) {
      return { text: 'El asistente IA no esta disponible en este momento.' };
    }

    // Rate limiting
    const userId = user.id || phone;
    if (checkRateLimit(userId)) {
      return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
    }

    const lockKey = session?.id || `phone:${phone}`;

    // Per-session in-memory lock (single instance — no PG advisory lock needed)
    if (this._chatLocks.has(lockKey)) {
      // Short wait for near-simultaneous duplicates only
      const deadline = Date.now() + 2000;
      while (this._chatLocks.has(lockKey) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      if (this._chatLocks.has(lockKey)) {
        return { text: 'Estoy procesando tu mensaje anterior, aguardá un momento.' };
      }
    }
    this._chatLocks.add(lockKey);
    const distLockKey = `ai_chat:${lockKey}`; // kept for release calls downstream
    let chatTrace: RunTree | null = null;
    if (this.langsmithEnabled) {
      try {
        chatTrace = new RunTree({
          name: 'agent.chat',
          run_type: 'chain',
          inputs: {
            sessionId: session?.id,
            userId: user?.id || null,
            companyId: user?.activeCompanyId || user?.companyId || null,
            phoneChannel: phone === 'web' ? 'web' : 'whatsapp',
            messageChars: (userMessage || '').length,
          },
          tags: ['tolvink', 'ai', 'chat'],
          metadata: {
            component: 'AgentService',
          },
        });
        await chatTrace.postRun();
      } catch (e: any) {
        this.logger.warn(`LangSmith chat trace init failed: ${sanitizeErrorForLog(e?.message)}`);
        chatTrace = null;
      }
    }

    // Session company override (WhatsApp company selection is session-scoped)
    const sessionState = (session?.flowState as any) || {};
    const sessionCompanyId = sessionState.selectedCompanyId;
    if (sessionCompanyId && sessionCompanyId !== user.activeCompanyId) {
      const isMember = (user.memberships || []).some((m: any) => m.companyId === sessionCompanyId && m.active !== false);
      if (isMember) user.activeCompanyId = sessionCompanyId;
    }

    const synUser = this.toolExecutor.buildSyntheticUser(user);
    const companyType = this.toolExecutor.resolveCompanyType(user);
    const isWeb = phone === 'web';

    // Resolve plant access for CONSULTA blocking
    const plantAccessMap = await this.resolveUserPlantAccess(user);

    // Cap + preprocess message
    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    const cleanedMessage = normalizeSpokenNumbers(preprocessMessage(cappedMessage));

    // Load conversation history
    const rawState = (session?.flowState as any) || {};
    const state = await this.validateActiveContext(rawState, user, session?.id);
    const storedMessages: any[] = state.aiMessages || [];

    // Fast-path for button confirmations/cancellations to avoid LLM loops.
    const quickResolved = await this.tryResolvePendingByIntent(cleanedMessage, state, user, synUser, session, plantAccessMap);
    if (quickResolved) {
      if (chatTrace) {
        try {
          await chatTrace.end({ status: 'ok', quickResolved: true, responseChars: (quickResolved.text || '').length });
          await chatTrace.patchRun();
        } catch {}
      }
      await releasePgLock(this.prisma as any, distLockKey);
      this._chatLocks.delete(lockKey);
      return quickResolved;
    }

    // Build system prompt (cached)
    const promptCacheKey = `${session.id}:${companyType}:${isWeb}`;
    const cachedPrompt = this._promptCache.get(promptCacheKey);
    let systemPrompt: string;
    if (cachedPrompt && Date.now() - cachedPrompt.ts < PROMPT_CACHE_TTL_MS) {
      systemPrompt = cachedPrompt.prompt;
    } else {
      systemPrompt = await this.promptBuilder.build(user, companyType, isWeb, plantAccessMap);
      this._promptCache.set(promptCacheKey, { prompt: systemPrompt, ts: Date.now() });
    }

    // Inject context (active freight, pending docs, locations, stale session)
    const messageToSend = this.contextBuilder.buildContextualMessage(
      cleanedMessage, state, storedMessages.length,
    );

    // Build Gemini-format history
    let geminiMessages: GeminiMessage[] = this.historyManager.buildGeminiHistory(storedMessages);
    // Defensive cleanup: old persisted messages may have functionCall parts without thought signature.
    geminiMessages = this.sanitizeHistoryForToolParts(geminiMessages);

    // Add user message
    geminiMessages.push({ role: 'user', parts: [{ text: messageToSend }] });

    // Trim history
    geminiMessages = this.historyManager.smartTrimHistory(geminiMessages);

    // Filter tools by role
    const allTools = this.toolRegistry.getAllDefinitions();
    const filteredToolDefs = filterToolsByRole(allTools, user, companyType, isWeb);
    // Detect autonomous driver for tool selection
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = (user.memberships || []).find((m: any) => m.companyId === activeCoId);
    const { isChofer: _isChofer } = resolveActiveRole(user);
    const isAutonomousDriver = _isChofer && !!(activeMem?.company?.autonomousDriverEnabled || user.company?.autonomousDriverEnabled);
    const selectedToolDefs = this.selectToolsForTurn(filteredToolDefs, cleanedMessage, state, isAutonomousDriver);
    this.logger.debug(`[tools] filtered=${filteredToolDefs.length} selected=${selectedToolDefs.length} autonomous=${isAutonomousDriver}`);
    let functionDeclarations = this.activeClient.convertToolDeclarations(selectedToolDefs);
    const hasToolPrefilter = selectedToolDefs.length < filteredToolDefs.length;

    // Select thinking level
    const hasActiveFlow = !!state.pendingFreight || !!state.pendingAction || !!state.activeContext?.lastFreightCode;
    const thinking = selectThinkingLevel(
      cleanedMessage,
      hasActiveFlow,
      storedMessages.length,
      !!state.activeContext,
    );

    // Initialize per-call side-effects
    this.sessionManager.deleteSideEffects(session.id);

    const loopDeadline = Date.now() + TOOL_TIMEOUT_MS;
    let loopCount = 0;
    let lastResult: any = null;

    try {
      while (loopCount < MAX_TOOL_ITERATIONS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline exceeded after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Sending to ${AI_PROVIDER} (loop ${loopCount}), messages: ${geminiMessages.length}, tools: ${functionDeclarations.length}`);

        const result = await this.activeClient.generateContent(
          systemPrompt,
          geminiMessages,
          functionDeclarations,
          thinking.budget,
        );

        lastResult = result;

        // Log usage
        if (result.usageMetadata) {
          this.logger.log(`[cost] input=${result.usageMetadata.promptTokenCount || 0} output=${result.usageMetadata.candidatesTokenCount || 0} loops=${loopCount}`);
        }

        // If model wants to call functions
        if (result.functionCalls && result.functionCalls.length > 0) {
          // Add model response to messages
          const modelParts: any[] = [];
          if (result.text) modelParts.push({ text: result.text });
          for (const fc of result.functionCalls) {
            // Keep Gemini part intact (includes thought signature when present).
            modelParts.push(fc.rawPart || { functionCall: fc.raw || { name: fc.name, args: fc.args } });
          }
          geminiMessages.push({ role: 'model', parts: modelParts });

          // Execute tools
          const allReadOnly = result.functionCalls.every(fc => READ_ONLY_TOOLS.has(fc.name));
          let toolResponses: any[];

          if (allReadOnly && result.functionCalls.length > 1) {
            // Parallel execution for read-only tools
            const settled = await Promise.allSettled(result.functionCalls.map(async (fc) => {
              this.logger.log(`AI tool call (parallel): ${fc.name}`);
              const res = await this.toolExecutor.executeTool(fc.name, fc.args, user, synUser, session, plantAccessMap);
              return { name: fc.name, response: { result: res }, _toolCallId: fc.raw?.id || fc.name };
            }));
            toolResponses = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? { functionResponse: s.value }
                : { functionResponse: { name: result.functionCalls![i].name, response: { result: 'Error: ' + (s.reason?.message || 'Unknown') }, _toolCallId: result.functionCalls![i].raw?.id || result.functionCalls![i].name } },
            );
          } else {
            // Sequential execution
            toolResponses = [];
            for (const fc of result.functionCalls) {
              this.logger.log(`AI tool call: ${fc.name}`);
              const res = await this.toolExecutor.executeTool(fc.name, fc.args, user, synUser, session, plantAccessMap);
              toolResponses.push({
                functionResponse: { name: fc.name, response: { result: res }, _toolCallId: fc.raw?.id || fc.name },
              });
            }
          }

          // Add tool responses to messages
          geminiMessages.push({ role: 'user', parts: toolResponses });
        } else {
          // Fallback safety: if filtered tool set was too narrow for this turn, retry once with full role-allowed tools.
          if (loopCount === 1 && hasToolPrefilter && this.shouldExpandTools(cleanedMessage, result.text)) {
            this.logger.warn(`Tool prefilter fallback: expanding ${functionDeclarations.length} -> ${filteredToolDefs.length} tools`);
            functionDeclarations = this.activeClient.convertToolDeclarations(filteredToolDefs);
            continue;
          }
          // No function calls — model is done
          break;
        }
      }

      // Extract final text
      let finalText = lastResult?.text || 'No se pudo procesar el mensaje.';

      // If loop exhausted
      if (loopCount >= MAX_TOOL_ITERATIONS && lastResult?.functionCalls?.length > 0) {
        this.logger.warn(`Tool loop exhausted at ${MAX_TOOL_ITERATIONS}`);
        if (!lastResult.text) {
          finalText = `La operacion requiere mas pasos. Por favor, intente con un pedido mas especifico o utilice la web: ${APP_URL}`;
        }
      }

      // Post-process response
      finalText = validateResponse(finalText, isWeb);

      // Detect if the model is asking a question — persist for next turn continuity
      const detectedQuestion = this.detectAwaitingAnswer(finalText);

      // Save updated history
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};

      // Merge side-effects
      const sideEffects = this.sessionManager.getSideEffects(session.id);
      this.sessionManager.deleteSideEffects(session.id);

      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, _sessionExpiredNote: _expNote, _recoveredContext: _recCtx, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, _navigate, ...otherSideEffects } = sideEffects;

      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      // Trim old responses to prevent bloat
      const trimmedMessages = this.historyManager.trimResponseContent(
        geminiMessages.slice(-MAX_HISTORY_MESSAGES),
      );

      const updateData: any = {
        flowState: {
          ...cleanState,
          ...otherSideEffects,
          ...(mergedActiveContext ? { activeContext: mergedActiveContext } : {}),
          aiMessages: _clearAiMessages ? [] : trimmedMessages,
          lastMessageAt: new Date().toISOString(),
          ...(_navigate ? { _lastNavigate: _navigate } : { _lastNavigate: null }),
          awaitingAnswer: detectedQuestion || null,
        },
        expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
      };

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: updateData,
      });

      const resolvedButtons = ensureConfirmationButtons(finalText, pendingButtons);
      if (chatTrace) {
        try {
          await chatTrace.end({
            status: 'ok',
            quickResolved: false,
            loopCount,
            responseChars: finalText.length,
            buttonsCount: resolvedButtons.length,
          });
          await chatTrace.patchRun();
        } catch {}
      }
      return { text: finalText, buttons: resolvedButtons.length > 0 ? resolvedButtons : undefined, navigate: _navigate };
    } catch (e: any) {
      this.sessionManager.deleteSideEffects(session.id);
      const errCode = classifyAiError(e);
      this.logger.error(`Chat error [code=${errCode} session=${session.id} user=${user.id}]: ${sanitizeErrorForLog(e?.message)}`, e.stack?.slice(0, 500));
      if (chatTrace) {
        try {
          await chatTrace.end({ status: 'error', errorCode: errCode }, sanitizeErrorForLog(String(e?.message || 'chat_error')));
          await chatTrace.patchRun();
        } catch {}
      }
      if (errCode === 'provider_suspended') {
        return { text: 'El servicio de inteligencia esta temporalmente no disponible. Usa el menu y volvemos a intentar en unos minutos.' };
      }
      if (errCode === 'provider_unavailable' || errCode === 'rate_limited') {
        return { text: 'El asistente esta con alta demanda. Intenta nuevamente en unos segundos.' };
      }
      return { text: 'Se produjo un inconveniente tecnico. Por favor, intente nuevamente.' };
    } finally {
      await releasePgLock(this.prisma as any, distLockKey);
      this._chatLocks.delete(lockKey);
    }
  }

  /** Pass through all role-filtered tools. Previously filtered by intent, removed to avoid context-switch bugs. */
  private selectToolsForTurn(toolDefs: any[], _cleanedMessage: string, _state: any, _isAutonomousDriver = false): any[] {
    return toolDefs;
  }

  private shouldExpandTools(cleanedMessage: string, modelText: string | null): boolean {
    const msg = (cleanedMessage || '').toLowerCase();
    const txt = (modelText || '').toLowerCase();
    const actionLike = /\b(manda|mandar|crear|asign|cancel|confirm|camion|chofer|flete|planta|lote|campo)\b/i.test(msg);
    const weakResponse = !txt || /no se pudo|requiere mas pasos|intente nuevamente|no tengo|no encontro|error/i.test(txt);
    return actionLike || weakResponse;
  }

  /** Resolve user's plant access levels (for CONSULTA blocking). */
  private async resolveUserPlantAccess(user: any): Promise<Map<string, string>> {
    const activeCoId = user.activeCompanyId || user.companyId;
    if (!activeCoId) return new Map();
    const accesses = await this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: activeCoId, isActive: true },
      select: { grantorCompanyId: true, accessLevel: true },
      take: 100,
    });
    const map = new Map<string, string>();
    for (const a of accesses) map.set(a.grantorCompanyId, a.accessLevel);
    return map;
  }

  private isConfirmIntent(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    return /^(confirmar|si|sí|dale|ok|va|metele|confirmo)\b/.test(t);
  }

  private isCancelIntent(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    return /^(cancelar|cancelo|no|deja|olvidate|par[aá])\b/.test(t);
  }

  private parseToolResultText(raw: string, fallbackOk: string): { text: string } {
    try {
      const obj = JSON.parse(raw);
      if (obj?.error) return { text: String(obj.error) };
      if (obj?.status === 'created' && obj?.code) {
        const pendingSlots = Number(obj?.assignment?.pendingSlots || 0);
        const assignedNow = Number(obj?.assignment?.assignedNow || 0);
        const totalAssigned = Number(obj?.assignment?.totalAssigned || 0);
        const requested = Number(obj?.assignment?.requestedTruckCount || 0);
        if (pendingSlots > 0) {
          return {
            text: `Listo. El flete *${obj.code}* fue creado, pero faltan *${pendingSlots}* asignacion(es) de camion (${totalAssigned}/${requested} completadas).`,
          };
        }
        if (requested > 0) {
          return {
            text: `Listo. El flete *${obj.code}* fue creado y quedaron *${totalAssigned}/${requested}* camiones asignados.`,
          };
        }
        return { text: `Listo. El flete *${obj.code}* fue creado correctamente.` };
      }
      if (obj?.status && obj?.code) return { text: `Listo. Accion aplicada sobre *${obj.code}*.` };
      return { text: fallbackOk };
    } catch {
      return { text: fallbackOk };
    }
  }

  private extractActionIdToken(text: string): string | null {
    const m = /\[ACTION_ID:([a-z0-9-]{4,40})\]/i.exec(text || '');
    return m?.[1] || null;
  }

  private extractFreightActionIdToken(text: string): string | null {
    const m = /\[FREIGHT_ACTION_ID:([a-z0-9-]{4,40})\]/i.exec(text || '');
    return m?.[1] || null;
  }

  /** Terminal actions that should clear conversation history after completion. */
  private static TERMINAL_ACTIONS = new Set([
    'create_autonomous_freight', 'finish_autonomous_freight',
    'cancel_freight', 'confirm_create_freight', 'confirm_finished',
  ]);

  private async clearPendingState(sessionId: string): Promise<void> {
    const s = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    const fs: any = (s?.flowState as any) || {};
    const {
      pendingFreight: _pf,
      pendingAction: _pa,
      _pendingButtons: _pb,
      pendingDocument: _pd,
      _pendingAction: _routerPendingAction,
      _pendingMessage: _routerPendingMessage,
      ...rest
    } = fs;
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowState: rest },
    });
  }

  private async validateActiveContext(state: any, user: any, sessionId?: string): Promise<any> {
    const fs: any = { ...(state || {}) };
    const ctx = fs.activeContext;
    const code = String(ctx?.lastFreightCode || '').trim();
    if (!code) return fs;
    const access = await this.toolExecutor.resolveFreightWithAccess(code, user).catch(() => ({ error: 'resolve_failed' } as any));
    if (access?.error || !access?.freight || ['finished', 'canceled'].includes(String(access.freight.status || '').toLowerCase())) {
      delete fs.activeContext;
      if (sessionId) {
        await this.prisma.whatsAppSession.update({ where: { id: sessionId }, data: { flowState: fs } }).catch(() => {});
      }
    }
    return fs;
  }

  /** Clear history after a terminal action so next message starts fresh. */
  private async clearHistoryAfterTerminalAction(sessionId: string, actionName: string): Promise<void> {
    if (!AgentService.TERMINAL_ACTIONS.has(actionName)) return;
    this.logger.log(`History cleared after terminal action: ${actionName}`);
    // Single raw update — no findUnique needed, just set aiMessages to empty array
    await this.prisma.$executeRaw`
      UPDATE "whatsapp_sessions"
      SET "flow_state" = COALESCE("flow_state", '{}'::jsonb) || '{"aiMessages":[]}'::jsonb
      WHERE "id" = ${sessionId}
    `.catch(() => {});
  }

  private async tryResolvePendingByIntent(
    cleanedMessage: string,
    state: any,
    user: any,
    synUser: any,
    session: any,
    plantAccessMap: Map<string, string>,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } } | null> {
    const actionIdFromText = this.extractActionIdToken(cleanedMessage);
    const freightActionIdFromText = this.extractFreightActionIdToken(cleanedMessage);
    const wantsConfirm = this.isConfirmIntent(cleanedMessage);
    const wantsCancel = this.isCancelIntent(cleanedMessage);
    const hasPendingFreight = !!state?.pendingFreight;
    const hasPendingAction = !!state?.pendingAction;
    if (!wantsConfirm && !wantsCancel) return null;
    if (!hasPendingFreight && !hasPendingAction) return null;

    if (wantsCancel) {
      await this.clearPendingState(session.id);
      return { text: 'Perfecto, cancelado. No se realizaron cambios.' };
    }

    // Confirm intent: prioritize freight creation when both are present.
    if (hasPendingFreight) {
      if (freightActionIdFromText && state.pendingFreight?.actionId && freightActionIdFromText !== state.pendingFreight.actionId) {
        return { text: 'La confirmacion no coincide con el flete pendiente. Reintentá con el botón más reciente.' };
      }
      const res = await this.toolExecutor.executeTool('confirm_create_freight', { actionId: freightActionIdFromText || state.pendingFreight?.actionId }, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, creamos el flete.');
      await this.clearHistoryAfterTerminalAction(session.id, 'confirm_create_freight');
      return { text: parsed.text };
    }
    if (hasPendingAction) {
      const actionName = state.pendingAction?.tool || '';
      if (actionIdFromText && state.pendingAction?.actionId && actionIdFromText !== state.pendingAction.actionId) {
        return { text: 'La confirmacion no coincide con la accion pendiente. Reintentá con el botón más reciente.' };
      }
      const res = await this.toolExecutor.executeTool('confirm_action', { actionId: actionIdFromText || state.pendingAction?.actionId }, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, accion confirmada.');
      await this.clearHistoryAfterTerminalAction(session.id, actionName);
      return { text: parsed.text };
    }
    return null;
  }

  /**
   * Sanitize persisted history: convert raw functionCall/functionResponse parts
   * into text summaries so the model retains conversational context about what
   * tools were used, while avoiding Gemini turn-ordering issues with raw
   * function parts from prior sessions.
   */
  private sanitizeHistoryForToolParts(messages: GeminiMessage[]): GeminiMessage[] {
    const cleaned: GeminiMessage[] = [];

    for (const msg of messages) {
      const textParts = (msg.parts || []).filter((p: any) => !!p?.text);
      const funcCallParts = (msg.parts || []).filter((p: any) => !!p?.functionCall);
      const funcResponseParts = (msg.parts || []).filter((p: any) => !!p?.functionResponse);

      if (msg.role === 'model' && funcCallParts.length > 0) {
        // Model turn with function calls → convert to text summary
        const callSummaries = funcCallParts.map((p: any) => {
          const name = p.functionCall?.name || 'unknown';
          const args = p.functionCall?.args || {};
          const relevantArgs = this.summarizeToolArgs(name, args);
          return `[tool:${name}${relevantArgs ? ` ${relevantArgs}` : ''}]`;
        });
        const parts: any[] = [...textParts, { text: callSummaries.join(' ') }];
        cleaned.push({ role: 'model', parts });

      } else if (msg.role === 'user' && funcResponseParts.length > 0) {
        // User turn with function responses → convert to text summary
        const responseSummaries = funcResponseParts.map((p: any) => {
          const name = p.functionResponse?.name || 'unknown';
          const result = p.functionResponse?.response?.result || '';
          const summary = this.summarizeToolResult(name, result);
          return `[result:${name} → ${summary}]`;
        });
        const parts: any[] = [...textParts, { text: responseSummaries.join(' ') }];
        cleaned.push({ role: 'user', parts });

      } else if (textParts.length > 0) {
        // Normal text message — keep as is
        cleaned.push({ ...msg, parts: textParts });
      }
    }

    return cleaned;
  }

  /** Extract only relevant args for the tool call summary (no UUIDs). */
  private summarizeToolArgs(_toolName: string, args: any): string {
    const parts: string[] = [];
    if (args.code) parts.push(`code=${args.code}`);
    if (args.status) parts.push(`status=${args.status}`);
    if (args.plate) parts.push(`plate=${args.plate}`);
    if (args.grain) parts.push(`grain=${args.grain}`);
    if (args.query) parts.push(`query=${args.query}`);
    return parts.join(', ');
  }

  /** Summarize a tool result to a short text for history context. */
  private summarizeToolResult(_toolName: string, result: string): string {
    if (!result || result.length === 0) return 'ok';
    try {
      const obj = JSON.parse(result);
      if (obj.error) return `error: ${String(obj.error).slice(0, 80)}`;
      if (obj._selectionSent) return `lista de ${obj.total || '?'} items enviada`;
      if (obj.status === 'pending_confirmation') return `pendiente confirmación`;
      if (obj.status === 'created' && obj.code) return `creado: ${obj.code}`;
      if (obj.code && obj.status) return `${obj.code} → ${obj.status}`;
      if (typeof obj.total === 'number') return `${obj.total} resultados`;
      if (obj.activeFreights !== undefined) return `${obj.activeFreights} fletes activos`;
      if (obj.code && obj.origin && obj.dest) return `${obj.code}: ${obj.origin} → ${obj.dest} (${obj.status})`;
      return String(result).slice(0, 100);
    } catch {
      return String(result).slice(0, 100);
    }
  }

  /** Detect if the model's response ends with a question — used for next-turn continuity. */
  private detectAwaitingAnswer(text: string): { question: string; expectedIntent: string | null; setAt: number } | null {
    if (!text) return null;

    const lines = text.split('\n').filter(l => l.trim());
    const lastLine = lines[lines.length - 1]?.trim() || '';

    if (!lastLine.endsWith('?')) return null;

    let expectedIntent: string | null = null;

    if (/confirm[aá]s?\??|lo (marcamos|hacemos|creamos)|est[aá] bien|dale\??/i.test(lastLine)) {
      expectedIntent = 'confirmation';
    } else if (/cu[aá]l|qu[eé] flete|a cu[aá]l/i.test(lastLine)) {
      expectedIntent = 'selection';
    } else if (/ya (descarg|termin|lleg)|descargaste|terminaste|llegaste/i.test(lastLine)) {
      expectedIntent = 'status_confirmation';
    } else if (/cu[aá]nto|qu[eé] (cantidad|peso|tipo)/i.test(lastLine)) {
      expectedIntent = 'data_input';
    }

    return { question: lastLine.slice(0, 200), expectedIntent, setAt: Date.now() };
  }
}
