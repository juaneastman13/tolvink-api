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
import { selectThinkingLevel } from './thinking-router';
import { checkRateLimit, cleanupRateLimits } from '../utils/rate-limiter';
import { preprocessMessage, validateResponse, normalizeSpokenNumbers, ensureConfirmationButtons } from '../utils/message-formatter';
import {
  MAX_TOOL_ITERATIONS, TOOL_TIMEOUT_MS, SESSION_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES, PROMPT_CACHE_TTL_MS, APP_URL,
} from './constants';

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private _chatLocks = new Set<string>();
  private _promptCache = new Map<string, { prompt: string; ts: number }>();

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

    // Per-session lock
    if (this._chatLocks.has(session.id)) {
      return { text: 'Estoy procesando su mensaje anterior, aguarde un momento.' };
    }
    this._chatLocks.add(session.id);

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
    const state = (session?.flowState as any) || {};
    const storedMessages: any[] = state.aiMessages || [];

    // Fast-path for button confirmations/cancellations to avoid LLM loops.
    const quickResolved = await this.tryResolvePendingByIntent(cleanedMessage, state, user, synUser, session, plantAccessMap);
    if (quickResolved) {
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
    const functionDeclarations = this.gemini.convertToolDeclarations(filteredToolDefs);

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
      return { text: finalText, buttons: resolvedButtons.length > 0 ? resolvedButtons : undefined, navigate: _navigate };
    } catch (e: any) {
      this.sessionManager.deleteSideEffects(session.id);
      this.logger.error(`Chat error [session=${session.id} user=${user.id}]: ${e.message}`, e.stack?.slice(0, 500));
      return { text: 'Se produjo un inconveniente tecnico. Por favor, intente nuevamente.' };
    } finally {
      this._chatLocks.delete(session.id);
    }
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
      if (obj?.status === 'created' && obj?.code) return { text: `Listo. El flete *${obj.code}* fue creado correctamente.` };
      if (obj?.status && obj?.code) return { text: `Listo. Accion aplicada sobre *${obj.code}*.` };
      return { text: fallbackOk };
    } catch {
      return { text: fallbackOk };
    }
  }

  private async clearPendingState(sessionId: string): Promise<void> {
    const s = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    const fs: any = (s?.flowState as any) || {};
    const { pendingFreight: _pf, pendingAction: _pa, _pendingButtons: _pb, ...rest } = fs;
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowState: rest },
    });
  }

  private async tryResolvePendingByIntent(
    cleanedMessage: string,
    state: any,
    user: any,
    synUser: any,
    session: any,
    plantAccessMap: Map<string, string>,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } } | null> {
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
      const res = await this.toolExecutor.executeTool('confirm_create_freight', {}, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, creamos el flete.');
      return { text: parsed.text };
    }
    if (hasPendingAction) {
      const res = await this.toolExecutor.executeTool('confirm_action', {}, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, accion confirmada.');
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
