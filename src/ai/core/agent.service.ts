// =====================================================================
// TOLVINK — Main AI Agent Service (Claude Sonnet rewrite)
// Direct Anthropic API — no format conversions, native tool use
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../../database/prisma.service';
import { ClaudeClient } from './claude.client';
import { PromptBuilderService } from '../prompt/prompt-builder';
import { SessionManagerService } from '../conversation/session-manager';
import { ToolExecutorService } from '../tools/tool-executor';
import { ToolRegistryService } from '../tools/tool-registry';
import { filterToolsByRole, READ_ONLY_TOOLS } from '../tools/tool-permissions';
import { checkRateLimit, cleanupRateLimits } from '../utils/rate-limiter';
import { preprocessMessage, validateResponse, normalizeSpokenNumbers } from '../utils/message-formatter';
import { classifyAiError, sanitizeErrorForLog } from '../utils/error-handler';
import { releasePgLock } from '../../common/distributed-lock';
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
    const now = Date.now();
    for (const [k, v] of this._promptCache) {
      if (now - v.ts > PROMPT_CACHE_TTL_MS) this._promptCache.delete(k);
    }
  }, 5 * 60 * 1000);

  constructor(
    private prisma: PrismaService,
    private claude: ClaudeClient,
    private promptBuilder: PromptBuilderService,
    private sessionManager: SessionManagerService,
    private toolExecutor: ToolExecutorService,
    private toolRegistry: ToolRegistryService,
  ) {}

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  isEnabled(): boolean {
    return this.claude.isEnabled();
  }

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    _onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: { screen: string; freightId?: string } }> {
    if (!this.claude.isEnabled()) {
      return { text: 'El asistente IA no esta disponible en este momento.' };
    }

    // Rate limiting
    const userId = user.id || phone;
    if (checkRateLimit(userId)) {
      return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
    }

    const lockKey = session?.id || `phone:${phone}`;

    // Per-session concurrency lock
    if (this._chatLocks.has(lockKey)) {
      const deadline = Date.now() + 2000;
      while (this._chatLocks.has(lockKey) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (this._chatLocks.has(lockKey)) {
        return { text: 'Estoy procesando tu mensaje anterior, aguarda un momento.' };
      }
    }
    this._chatLocks.add(lockKey);
    const distLockKey = `ai_chat:${lockKey}`;

    // Session company override
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

    // Preprocess message
    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    const cleanedMessage = normalizeSpokenNumbers(preprocessMessage(cappedMessage));

    // Load conversation state
    const state = (session?.flowState as any) || {};

    // Fast-path for button confirmations/cancellations
    const quickResolved = await this.tryResolvePendingByIntent(cleanedMessage, state, user, synUser, session, plantAccessMap);
    if (quickResolved) {
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

    // Load history (Anthropic native format — no conversion needed)
    const storedMessages: Anthropic.MessageParam[] = state.aiMessages || [];

    // Build messages: history + new user message
    let messages: Anthropic.MessageParam[] = [
      ...this.trimHistory(storedMessages),
      { role: 'user' as const, content: cleanedMessage },
    ];

    // Filter tools by role and convert to Anthropic format
    const allTools = this.toolRegistry.getAllDefinitions();
    const filteredToolDefs = filterToolsByRole(allTools, user, companyType, isWeb);
    const tools: Anthropic.Tool[] = filteredToolDefs.map(t => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    this.logger.debug(`[tools] filtered=${tools.length}`);

    // Initialize per-call side-effects
    this.sessionManager.deleteSideEffects(session.id);

    const loopDeadline = Date.now() + TOOL_TIMEOUT_MS;
    let loopCount = 0;
    let lastResponse: Anthropic.Message | null = null;

    try {
      while (loopCount < MAX_TOOL_ITERATIONS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline exceeded after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Sending to Claude (loop ${loopCount}), messages: ${messages.length}, tools: ${tools.length}`);

        const response = await this.claude.sendMessage({
          system: systemPrompt,
          messages,
          tools,
        });

        lastResponse = response;

        // Add assistant response to messages
        messages.push({ role: 'assistant' as const, content: response.content });

        // Check for tool use
        const toolUseBlocks = response.content.filter(
          (b): b is Anthropic.ContentBlock & { type: 'tool_use' } => b.type === 'tool_use',
        );

        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          break;
        }

        // Execute tools
        const allReadOnly = toolUseBlocks.every(b => READ_ONLY_TOOLS.has(b.name));
        let toolResults: Anthropic.ToolResultBlockParam[];

        if (allReadOnly && toolUseBlocks.length > 1) {
          // Parallel execution for read-only tools
          const settled = await Promise.allSettled(toolUseBlocks.map(async (block) => {
            this.logger.log(`AI tool call (parallel): ${block.name}`);
            const result = await this.toolExecutor.executeTool(
              block.name, block.input as any, user, synUser, session, plantAccessMap,
            );
            return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
          }));
          toolResults = settled.map((s, i) =>
            s.status === 'fulfilled'
              ? s.value
              : { type: 'tool_result' as const, tool_use_id: toolUseBlocks[i].id, content: `Error: ${(s as any).reason?.message || 'Unknown'}`, is_error: true },
          );
        } else {
          // Sequential execution
          toolResults = [];
          for (const block of toolUseBlocks) {
            this.logger.log(`AI tool call: ${block.name}`);
            const result = await this.toolExecutor.executeTool(
              block.name, block.input as any, user, synUser, session, plantAccessMap,
            );
            toolResults.push({ type: 'tool_result' as const, tool_use_id: block.id, content: result });
          }
        }

        // Add tool results to messages
        messages.push({ role: 'user' as const, content: toolResults });
      }

      // Extract final text
      let finalText = '';
      if (lastResponse) {
        finalText = lastResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('\n');
      }

      if (!finalText) {
        if (loopCount >= MAX_TOOL_ITERATIONS) {
          finalText = `La operacion requiere mas pasos. Por favor, intente con un pedido mas especifico o utilice la web: ${APP_URL}`;
        } else {
          finalText = 'No se pudo procesar el mensaje.';
        }
      }

      // Post-process response
      finalText = validateResponse(finalText, isWeb);

      // Save updated history
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};

      // Merge side-effects from tool executor
      const sideEffects = this.sessionManager.getSideEffects(session.id);
      this.sessionManager.deleteSideEffects(session.id);

      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, _sessionExpiredNote: _expNote, _recoveredContext: _recCtx, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, _navigate, ...otherSideEffects } = sideEffects;

      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      // Trim messages for storage
      const messagesToStore = messages.slice(-MAX_HISTORY_MESSAGES);

      const updateData: any = {
        flowState: {
          ...cleanState,
          ...otherSideEffects,
          ...(mergedActiveContext ? { activeContext: mergedActiveContext } : {}),
          aiMessages: _clearAiMessages ? [] : messagesToStore,
          lastMessageAt: new Date().toISOString(),
          ...(_navigate ? { _lastNavigate: _navigate } : { _lastNavigate: null }),
        },
        expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
      };

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: updateData,
      });

      const resolvedButtons = pendingButtons || [];
      return {
        text: finalText,
        buttons: resolvedButtons.length > 0 ? resolvedButtons : undefined,
        navigate: _navigate,
      };
    } catch (e: any) {
      this.sessionManager.deleteSideEffects(session.id);
      const errCode = classifyAiError(e);
      this.logger.error(`Chat error [code=${errCode} session=${session.id} user=${user.id}]: ${sanitizeErrorForLog(e?.message)}`, e.stack?.slice(0, 500));
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

  // ======================== HISTORY TRIMMING ========================

  private trimHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    if (messages.length <= MAX_HISTORY_MESSAGES) return messages;

    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);

    // Ensure we don't start with an orphaned tool_result
    if (trimmed.length > 0 && trimmed[0].role === 'user') {
      const content = trimmed[0].content;
      if (Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result') {
        trimmed.shift();
      }
    }

    // Ensure first message is from user (Anthropic requirement)
    while (trimmed.length > 0 && trimmed[0].role !== 'user') {
      trimmed.shift();
    }

    return trimmed;
  }

  // ======================== PLANT ACCESS ========================

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

  // ======================== FAST PATH ========================

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
        const totalAssigned = Number(obj?.assignment?.totalAssigned || 0);
        const requested = Number(obj?.assignment?.requestedTruckCount || 0);
        if (pendingSlots > 0) {
          return { text: `Listo. El flete *${obj.code}* fue creado, pero faltan *${pendingSlots}* asignacion(es) de camion (${totalAssigned}/${requested} completadas).` };
        }
        if (requested > 0) {
          return { text: `Listo. El flete *${obj.code}* fue creado y quedaron *${totalAssigned}/${requested}* camiones asignados.` };
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

  // Only clear history for actions that truly end a complete workflow.
  // finish_autonomous_freight and cancel_freight removed — the user may be
  // finishing/canceling an old freight as a step before creating a new one,
  // and clearing history would lose the data they already provided.
  private static TERMINAL_ACTIONS = new Set([
    'confirm_create_freight',
  ]);

  private async clearPendingState(sessionId: string): Promise<void> {
    const s = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    const fs: any = (s?.flowState as any) || {};
    const {
      pendingFreight: _pf, pendingAction: _pa, _pendingButtons: _pb,
      pendingDocument: _pd, _pendingAction: _rpa, _pendingMessage: _rpm,
      ...rest
    } = fs;
    await this.prisma.whatsAppSession.update({ where: { id: sessionId }, data: { flowState: rest } });
  }

  private async clearHistoryAfterTerminalAction(sessionId: string, actionName: string): Promise<void> {
    if (!AgentService.TERMINAL_ACTIONS.has(actionName)) return;
    this.logger.log(`History cleared after terminal action: ${actionName}`);
    await this.prisma.$executeRaw`
      UPDATE "whatsapp_sessions"
      SET "flow_state" = COALESCE("flow_state", '{}'::jsonb) || '{"aiMessages":[],"pendingAction":null,"pendingFreight":null,"_pendingButtons":null}'::jsonb
      WHERE "id" = ${sessionId}
    `.catch(() => {});
  }

  private async tryResolvePendingByIntent(
    cleanedMessage: string, state: any, user: any, synUser: any, session: any,
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

    if (hasPendingFreight) {
      if (freightActionIdFromText && state.pendingFreight?.actionId && freightActionIdFromText !== state.pendingFreight.actionId) {
        return { text: 'La confirmacion no coincide con el flete pendiente. Reintenta con el boton mas reciente.' };
      }
      const res = await this.toolExecutor.executeTool('confirm_create_freight', { actionId: freightActionIdFromText || state.pendingFreight?.actionId }, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, creamos el flete.');
      await this.clearHistoryAfterTerminalAction(session.id, 'confirm_create_freight');
      return { text: parsed.text };
    }

    if (hasPendingAction) {
      const actionName = state.pendingAction?.tool || '';
      if (actionIdFromText && state.pendingAction?.actionId && actionIdFromText !== state.pendingAction.actionId) {
        return { text: 'La confirmacion no coincide con la accion pendiente. Reintenta con el boton mas reciente.' };
      }
      const res = await this.toolExecutor.executeTool('confirm_action', { actionId: actionIdFromText || state.pendingAction?.actionId }, user, synUser, session, plantAccessMap);
      const parsed = this.parseToolResultText(res, 'Listo, accion confirmada.');
      await this.clearHistoryAfterTerminalAction(session.id, actionName);
      return { text: parsed.text };
    }

    return null;
  }
}
