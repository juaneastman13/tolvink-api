// =====================================================================
// TOLVINK — Main AI Agent Service (Gemini 2.5 Flash)
// Replaces the old AiService — same chat() contract
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { GeminiClient, GeminiMessage } from './gemini.client';
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
  MAX_TOOL_ITERATIONS, TOOL_TIMEOUT_MS, SESSION_TIMEOUT_MS,
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
    'generate_location_link', 'generate_tracking_link', 'generate_report_link',
  ]);
  private readonly FREIGHT_ACTION_TOOLS = new Set<string>([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded', 'confirm_finished',
    'cancel_freight', 'authorize_freight', 'duplicate_freight', 'update_freight',
    'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
    'assign_transporter', 'assign_truck_to_trip', 'assign_truck_to_freight',
    'assign_multi_trucks', 'cancel_assignment', 'update_assignment',
    'assign_external_truck', 'assign_mixed_trucks', 'edit_external_assignment',
  ]);
  private readonly TRUCK_TOOLS = new Set<string>([
    'list_trucks', 'create_truck', 'update_truck', 'deactivate_truck',
    'list_drivers', 'create_driver', 'deactivate_driver',
    'get_truck_detail', 'get_truck_documents', 'get_expiring_documents',
    'attach_truck_document', 'register_truck_expense', 'list_truck_expenses',
    'register_truck_income', 'list_truck_incomes', 'register_truck_movement',
    'list_truck_movements', 'register_trip_data', 'get_truck_economic_summary',
    'get_fleet_summary', 'get_fleet_alerts',
  ]);
  private readonly ADMIN_TOOLS = new Set<string>([
    'get_user_profile', 'list_company_users', 'create_user', 'update_user_role',
    'deactivate_user', 'reactivate_user', 'update_user_admin', 'update_profile',
    'switch_company', 'update_company', 'list_branches', 'create_branch', 'update_branch', 'delete_branch',
    'list_enabled_plants', 'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
  ]);
  private readonly DOC_TOOLS = new Set<string>([
    'attach_document', 'list_documents', 'delete_document', 'ocr_analyze', 'save_ocr_data', 'rename_document',
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

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiClient,
    private promptBuilder: PromptBuilderService,
    private sessionManager: SessionManagerService,
    private historyManager: HistoryManagerService,
    private contextBuilder: ContextBuilderService,
    private toolExecutor: ToolExecutorService,
    private toolRegistry: ToolRegistryService,
  ) {}

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  isEnabled(): boolean {
    return this.gemini.isEnabled();
  }

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } }> {
    if (!this.gemini.isEnabled()) {
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
    let functionDeclarations = this.gemini.convertToolDeclarations(selectedToolDefs);
    const hasToolPrefilter = selectedToolDefs.length < filteredToolDefs.length;

    // Select thinking level
    const hasActiveFlow = !!state.pendingFreight;
    const thinking = selectThinkingLevel(cleanedMessage, hasActiveFlow);

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

        this.logger.log(`Sending to Gemini (loop ${loopCount}), messages: ${geminiMessages.length}, tools: ${functionDeclarations.length}`);

        const result = await this.gemini.generateContent(
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
              return { name: fc.name, response: { result: res } };
            }));
            toolResponses = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? { functionResponse: s.value }
                : { functionResponse: { name: result.functionCalls![i].name, response: { result: 'Error: ' + (s.reason?.message || 'Unknown') } } },
            );
          } else {
            // Sequential execution
            toolResponses = [];
            for (const fc of result.functionCalls) {
              this.logger.log(`AI tool call: ${fc.name}`);
              const res = await this.toolExecutor.executeTool(fc.name, fc.args, user, synUser, session, plantAccessMap);
              toolResponses.push({
                functionResponse: { name: fc.name, response: { result: res } },
              });
            }
          }

          // Add tool responses to messages
          geminiMessages.push({ role: 'user', parts: toolResponses });
        } else {
          // Fallback safety: if filtered tool set was too narrow for this turn, retry once with full role-allowed tools.
          if (loopCount === 1 && hasToolPrefilter && this.shouldExpandTools(cleanedMessage, result.text)) {
            this.logger.warn(`Tool prefilter fallback: expanding ${functionDeclarations.length} -> ${filteredToolDefs.length} tools`);
            functionDeclarations = this.gemini.convertToolDeclarations(filteredToolDefs);
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

  private _selectToolsForTurn_DISABLED(toolDefs: any[], cleanedMessage: string, state: any, isAutonomousDriver = false): any[] {
    const msg = (cleanedMessage || '').toLowerCase();
    const include = new Set<string>([...this.CORE_TOOLS]);

    // Autonomous driver: always include their 3 core tools (chofer may say "salí con soja" without warning)
    if (isAutonomousDriver) {
      for (const t of this.AUTONOMOUS_TOOLS) include.add(t);
    }

    const hasPendingFlow = !!state?.pendingFreight || !!state?.pendingAction;
    if (hasPendingFlow) {
      include.add('confirm_create_freight');
      include.add('confirm_action');
    }

    const isFreightIntent = /\b(manda|mandá|mandar|crear?\s+flete|nuevo\s+flete|flete|tonelad|carga|entrega|inicia|confirma)\b/i.test(msg);
    const isAssignmentIntent = /\b(asign|transportista|flota|camion|externo|chofer)\b/i.test(msg);
    const isTruckIntent = /\b(camion|camiones|chofer|patente|matricula|gasto|ingreso|movimiento|documento|itv|seguro)\b/i.test(msg);
    const isAdminIntent = /\b(usuario|usuarios|rol|empresa|sucursal|acceso|perfil)\b/i.test(msg);
    const isDocIntent = /\b(documento|foto|imagen|ocr|adjunt|archivo)\b/i.test(msg);

    if (isFreightIntent) for (const t of this.FREIGHT_ACTION_TOOLS) include.add(t);
    if (isAssignmentIntent) {
      include.add('assign_transporter');
      include.add('assign_truck_to_freight');
      include.add('assign_external_truck');
      include.add('assign_mixed_trucks');
      include.add('list_transporters');
      include.add('list_trucks');
      include.add('list_drivers');
    }
    if (isTruckIntent) for (const t of this.TRUCK_TOOLS) include.add(t);
    if (isAdminIntent) for (const t of this.ADMIN_TOOLS) include.add(t);
    if (isDocIntent) for (const t of this.DOC_TOOLS) include.add(t);

    // Keep set bounded but safe. If nothing matches beyond core, use role-filtered tools.
    const selected = toolDefs.filter((t: any) => include.has(t.name));
    if (selected.length < 8) return toolDefs;
    return selected;
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
   * Keep only textual history for persisted turns.
   * Tool parts from previous sessions can create invalid Gemini turn ordering
   * (or missing thought signatures). Runtime tool turns in the current request
   * are still preserved in-memory by the main loop.
   */
  private sanitizeHistoryForToolParts(messages: GeminiMessage[]): GeminiMessage[] {
    const cleaned: GeminiMessage[] = [];
    for (const msg of messages) {
      const filteredParts = (msg.parts || []).filter((p: any) => {
        // Persisted history: keep text only, drop functionCall/functionResponse.
        return !!p?.text;
      });
      if (filteredParts.length > 0) {
        cleaned.push({ ...msg, parts: filteredParts });
      }
    }
    return cleaned;
  }
}
