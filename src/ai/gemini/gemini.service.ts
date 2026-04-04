// =====================================================================
// TOLVINK — Gemini AI Service (Google)
// Conversational assistant for WhatsApp with tool use
// Mirror of ai.service.ts but using Google Gemini SDK
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { GoogleGenAI } from '@google/genai';
import {
  sanitizeForPrompt as _sanitizeForPrompt,
} from '../ai.utils';
import { ResponseFormatterService } from '../response/response-formatter.service';
import { SessionManagerService } from '../session/session-manager.service';
import { GeminiPromptBuilderService } from './gemini-prompt-builder.service';
import { IntentRouterService } from '../routing/intent-router.service';
import { AiContextService } from '../tools/ai-context.service';
import { LocationToolsService } from '../tools/location-tools.service';
import { AiService } from '../ai.service';
import { MessageInterceptorService } from '../interceptor/message-interceptor.service';
import {
  MAX_HISTORY, MAX_TOOL_LOOPS, AI_SESSION_TIMEOUT_MIN, APP_URL,
  STALE_SESSION_MIN, AI_RATE_LIMIT_WINDOW_MS, AI_RATE_LIMIT_MAX,
} from '../ai.constants';
import { convertAllToolsToGemini } from './gemini-tool-adapter';
import { detectDomains, getToolNamesForDomains } from '../routing/tool-domain-router';
import {
  GEMINI_MODELS, GEMINI_FLASH_MAX_TOKENS, GEMINI_PRO_MAX_TOKENS, GEMINI_TEMPERATURE,
} from './gemini.constants';

const geminiRateMap = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class GeminiService implements OnModuleDestroy {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;

  // Access side-effects map via public API on SessionManagerService
  get _chatSideEffects(): Map<string, Record<string, any>> {
    return this.sessionManager.getChatSideEffectsMap();
  }
  private _chatLocks = new Set<string>();
  private _proRetried: Map<string, number> | null = null;

  private rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of geminiRateMap) { if (now > v.resetAt) geminiRateMap.delete(k); }
    if (geminiRateMap.size > 10_000) {
      const iter = geminiRateMap.keys();
      while (geminiRateMap.size > 8_000) {
        const k = iter.next().value;
        if (k) geminiRateMap.delete(k); else break;
      }
    }
    this.locationTools.cleanupCooldowns();
    this.sessionManager.cleanStaleSideEffects();
  }, 5 * 60 * 1000);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => AiService)) private aiService: AiService,
    private responseFormatter: ResponseFormatterService,
    private sessionManager: SessionManagerService,
    private promptBuilder: GeminiPromptBuilderService,
    private intentRouter: IntentRouterService,
    private aiContext: AiContextService,
    private locationTools: LocationToolsService,
    private interceptor: MessageInterceptorService,
  ) {
    const apiKey = this.config.get<string>('GEMINI_API_KEY');
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
      this.logger.log(`Gemini AI assistant enabled (${GEMINI_MODELS.flash})`);
    } else {
      if (process.env.NODE_ENV === 'production') {
        this.logger.warn('GEMINI_API_KEY not set — Gemini AI assistant disabled');
      } else {
        this.logger.warn('GEMINI_API_KEY not set — Gemini AI assistant disabled');
      }
    }
  }

  // Cache system prompts per session
  private _promptCache = new Map<string, { prompt: string; ts: number }>();
  private readonly PROMPT_CACHE_TTL = 5 * 60 * 1000;

  onModuleDestroy() { clearInterval(this.rateCleanupTimer); }

  isEnabled(): boolean {
    return !!this.client;
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

    // Per-user rate limiting
    const now = Date.now();
    const userId = user.id || phone;
    const rateEntry = geminiRateMap.get(userId);
    if (rateEntry && now < rateEntry.resetAt) {
      if (rateEntry.count >= AI_RATE_LIMIT_MAX) {
        return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
      }
      rateEntry.count++;
    } else {
      geminiRateMap.set(userId, { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW_MS });
    }

    // Per-session lock
    if (this._chatLocks.has(session.id)) {
      return { text: 'Estoy procesando su mensaje anterior, aguarde un momento.' };
    }
    this._chatLocks.add(session.id);

    // Session company override
    const sessionState = (session?.flowState as any) || {};
    const sessionCompanyId = sessionState.selectedCompanyId;
    if (sessionCompanyId && sessionCompanyId !== user.activeCompanyId) {
      const isMember = (user.memberships || []).some((m: any) => m.companyId === sessionCompanyId && m.active !== false);
      if (isMember) {
        user.activeCompanyId = sessionCompanyId;
      }
    }

    const synUser = this.aiContext.buildSyntheticUser(user);
    const companyType = this.aiContext.resolveCompanyType(user);
    const isWeb = phone === 'web';

    // ═══ LAYER 0: Intercept without AI ═══
    const state0 = (session?.flowState as any) || {};
    try {
      const interceptResult = await this.interceptor.intercept(
        userMessage, user, companyType, state0, isWeb,
      );
      if (interceptResult.handled) {
        this.logger.log(`[layer0] action=${interceptResult.action} cost=$0.00`);
        const aiMessages0: any[] = state0.aiMessages || [];
        aiMessages0.push({ role: 'user', content: userMessage });
        aiMessages0.push({ role: 'assistant', content: [{ type: 'text', text: interceptResult.response || '' }] });
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: {
            flowState: { ...state0, aiMessages: aiMessages0.slice(-MAX_HISTORY), lastMessageAt: new Date().toISOString() },
            expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
          },
        });
        this._chatLocks.delete(session.id);
        return {
          text: interceptResult.response || '',
          buttons: interceptResult.interactive?.action?.buttons?.map((b: any) => b.reply) || undefined,
          navigate: interceptResult.navigate,
        };
      }
    } catch (e: any) {
      this.logger.warn(`[layer0] intercept error: ${e.message}`);
    }
    // ═══ LAYER 1: Gemini AI ═══

    const plantAccessMap = await this.resolveUserPlantAccess(user);

    // Cap and preprocess message
    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    const cleanedMessage = this.responseFormatter.preprocessMessage(cappedMessage);

    // Load conversation history
    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Build system prompt (cached)
    const promptCacheKey = `${session.id}:${companyType}:${isWeb}`;
    const cachedPrompt = this._promptCache.get(promptCacheKey);
    let systemPrompt: string;
    let proactiveData: string | undefined;
    if (cachedPrompt && Date.now() - cachedPrompt.ts < this.PROMPT_CACHE_TTL) {
      systemPrompt = cachedPrompt.prompt;
    } else {
      const promptResult = await this.promptBuilder.build(user, companyType, isWeb, plantAccessMap);
      systemPrompt = promptResult.fullPrompt;
      proactiveData = promptResult.proactiveData;
      this._promptCache.set(promptCacheKey, { prompt: systemPrompt, ts: Date.now() });
      if (this._promptCache.size > 500) {
        const now = Date.now();
        for (const [k, v] of this._promptCache) { if (now - v.ts > this.PROMPT_CACHE_TTL) this._promptCache.delete(k); }
      }
    }

    // Inject context (stale session, pending document, location, active context, etc.)
    let messageToSend = cleanedMessage;
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessages.length > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el último mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()áéíóúñÁÉÍÓÚÑ]/g, '').slice(0, 60);
      const activeCode = state.activeContext?.lastFreightCode;
      messageToSend = `[Sistema: ARCHIVO PENDIENTE "${safeName}" (${doc.type}, URL: ${doc.url}). Analizar el mensaje del usuario para determinar a qué adjuntar.${activeCode ? ` Flete activo: ${_sanitizeForPrompt(activeCode)}.` : ''} Si no queda claro, preguntar.]\n\n${messageToSend}`;
    }

    if (state.lastLocation) {
      const loc = state.lastLocation;
      messageToSend = `[Sistema: UBICACIÓN GUARDADA — lat: ${loc.lat}, lng: ${loc.lng}${loc.name ? `, nombre: "${_sanitizeForPrompt(loc.name)}"` : ''}${loc.address ? `, dirección: "${_sanitizeForPrompt(loc.address)}"` : ''}. Usar en prepare_freight si aplica.]\n\n${messageToSend}`;
    }

    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      if (ac.lastFreightCode) {
        messageToSend = `[FLETE ACTIVO: ${_sanitizeForPrompt(ac.lastFreightCode)}. REGLA: Toda acción del usuario sobre "el flete", "este", "ese", o sin especificar código, se ejecuta sobre ${_sanitizeForPrompt(ac.lastFreightCode)}. NO preguntar cuál flete. Resumen: ${_sanitizeForPrompt(ac.lastFreightSummary || '')}. Última acción: ${_sanitizeForPrompt(ac.lastAction || 'ninguna')}.${ac.lastSearchFilter ? ` Último filtro: ${_sanitizeForPrompt(ac.lastSearchFilter)}.` : ''}]\n\n${messageToSend}`;
      } else if (ac.lastSearchFilter) {
        messageToSend = `[Contexto activo: último filtro: ${_sanitizeForPrompt(ac.lastSearchFilter)}]\n\n${messageToSend}`;
      }
    }

    if (state._sessionExpiredNote && state._recoveredContext) {
      const rc = state._recoveredContext;
      const parts: string[] = [];
      if (rc.lastFreightCode) parts.push(`último flete: ${_sanitizeForPrompt(rc.lastFreightCode)}`);
      if (rc.lastAction) parts.push(`última acción: ${_sanitizeForPrompt(rc.lastAction)}`);
      if (rc.lastSearchFilter) parts.push(`último filtro: ${_sanitizeForPrompt(rc.lastSearchFilter)}`);
      if (parts.length > 0) {
        messageToSend = `[Sistema: la sesión anterior expiró. Contexto recuperado: ${parts.join('. ')}. Informar brevemente al usuario.]\n\n${messageToSend}`;
      }
    }

    if (state.pendingAction) {
      const pa = state.pendingAction;
      messageToSend = `[Sistema: hay una acción pendiente de confirmación: ${_sanitizeForPrompt(pa.summary || pa.tool || '')}. Si el usuario confirma → confirm_action. Si cancela o cambia de tema → ignorar.]\n\n${messageToSend}`;
    }

    // Convert Anthropic-format history to Gemini format
    const geminiHistory = this.convertHistoryToGemini(aiMessages);

    // Add user message to Anthropic-format history (for session storage)
    aiMessages.push({ role: 'user', content: messageToSend });

    // Filter tools by role AND domain
    const roleFilteredTools = this.intentRouter.getFilteredTools(user, companyType, isWeb);
    const sessionStateForRouter = {
      activeFlow: state.pendingFreight ? 'create_freight' : undefined,
      pendingAction: state.pendingAction,
      pendingFreight: state.pendingFreight,
    };
    const domains = detectDomains(cleanedMessage, sessionStateForRouter);
    const allowedToolNames = getToolNamesForDomains(domains);
    const domainFilteredTools = roleFilteredTools.filter(t => allowedToolNames.has(t.name));
    this.logger.log(`[tools] domains=${[...domains].join(',')} tools=${domainFilteredTools.length}/${roleFilteredTools.length}`);
    const geminiTools = convertAllToolsToGemini(domainFilteredTools);

    // Select model — Flash default
    let selectedModel: string = GEMINI_MODELS.flash;
    let maxTokens = GEMINI_FLASH_MAX_TOKENS;

    // Global timeout
    const loopDeadline = Date.now() + 90_000;
    let loopCount = 0;

    // Initialize side-effects
    this._chatSideEffects.delete(session.id);

    try {
      // Build Gemini conversation contents
      let contents = [
        ...geminiHistory,
        { role: 'user', parts: [{ text: messageToSend }] },
      ];

      // Inject proactive data as first turn on new sessions (paid once, not every turn)
      if (proactiveData && geminiHistory.length === 0) {
        contents.unshift(
          { role: 'user', parts: [{ text: proactiveData }] },
          { role: 'model', parts: [{ text: 'Entendido.' }] },
        );
      }

      let lastResponse: any = null;

      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline exceeded after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Sending to Gemini (loop ${loopCount}, model=${selectedModel}), messages: ${contents.length}`);

        const callGemini = async (): Promise<any> => {
          const timeoutMs = 45_000;
          let timeoutHandle: ReturnType<typeof setTimeout>;
          const timeout = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error('Gemini API timeout')), timeoutMs);
          });

          try {
            const apiCall = this.client!.models.generateContent({
              model: selectedModel,
              contents,
              config: {
                systemInstruction: systemPrompt,
                temperature: GEMINI_TEMPERATURE,
                maxOutputTokens: maxTokens,
                tools: [geminiTools] as any,
              },
            });
            return await Promise.race([apiCall, timeout]);
          } finally {
            clearTimeout(timeoutHandle!);
          }
        };

        let response: any;
        try {
          response = await callGemini();
        } catch (retryErr: any) {
          const status = retryErr?.status || retryErr?.statusCode;
          const isTransient = !status || status === 429 || status >= 500 || retryErr.message?.includes('timeout');
          if (isTransient && Date.now() + 50_000 < loopDeadline) {
            this.logger.warn(`Gemini API transient error (${retryErr.message}), retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
            response = await callGemini();
          } else {
            throw retryErr;
          }
        }

        lastResponse = response;

        // Extract parts from response
        const candidate = response.candidates?.[0];
        if (!candidate?.content?.parts) {
          this.logger.warn('Gemini returned no candidate parts');
          break;
        }

        const responseParts = candidate.content.parts;
        const functionCalls = responseParts.filter((p: any) => p.functionCall);
        const textParts = responseParts.filter((p: any) => p.text);

        if (functionCalls.length === 0) {
          // No tool calls — we have the final response
          break;
        }

        // Add assistant response to contents
        contents.push({ role: 'model', parts: responseParts });

        // Execute tool calls
        const READ_ONLY_TOOLS = new Set([
          'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
          'search_fields', 'search_lots', 'get_user_profile',
          'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
          'list_documents', 'freight_history', 'get_dashboard',
          'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
          'get_truck_detail', 'get_truck_documents', 'get_expiring_documents', 'list_truck_expenses',
          'list_truck_incomes', 'list_truck_movements', 'get_truck_economic_summary', 'get_fleet_summary', 'get_fleet_alerts',
          'navigate_app',
        ]);

        const allReadOnly = functionCalls.every((fc: any) => READ_ONLY_TOOLS.has(fc.functionCall.name));
        const functionResponses: any[] = [];

        if (allReadOnly && functionCalls.length > 1) {
          // Parallel execution for read-only tools
          this.logger.log(`Executing ${functionCalls.length} read-only tools in parallel`);
          const settled = await Promise.allSettled(functionCalls.map(async (fc: any) => {
            const { name, args } = fc.functionCall;
            this.logger.log(`Gemini tool call (parallel): ${name}`);
            const result = await this.executeTool(name, args || {}, user, synUser, session, plantAccessMap);
            return { functionResponse: { name, response: { result } } };
          }));
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            if (s.status === 'fulfilled') {
              functionResponses.push(s.value);
            } else {
              functionResponses.push({
                functionResponse: {
                  name: functionCalls[i].functionCall.name,
                  response: { error: s.reason?.message || 'Unknown error' },
                },
              });
            }
          }
        } else {
          // Sequential execution
          for (const fc of functionCalls) {
            const { name, args } = fc.functionCall;
            this.logger.log(`Gemini tool call: ${name}`);
            const result = await this.executeTool(name, args || {}, user, synUser, session, plantAccessMap);
            functionResponses.push({ functionResponse: { name, response: { result } } });
          }
        }

        // Detect prepare_freight failure on Flash → escalate to Pro
        if (selectedModel === GEMINI_MODELS.flash) {
          const prepareCall = functionCalls.find((fc: any) => fc.functionCall.name === 'prepare_freight');
          if (prepareCall) {
            const prepareResp = functionResponses.find((fr: any) => fr.functionResponse.name === 'prepare_freight');
            const resultStr = prepareResp?.functionResponse?.response?.result || '';
            // Only escalate if Flash misunderstood parameters, not if user data is wrong
            const isComprehensionError = (
              /missing required|invalid.*param|unexpected.*type|schema.*valid/i.test(resultStr) ||
              /trips.*required|branchId.*required|grain.*required/i.test(resultStr)
            ) && !/no encontr|not found|no existe|sin resultados|no hay/i.test(resultStr);
            if (isComprehensionError && !this._proRetried?.has(session.id)) {
              this.logger.warn('prepare_freight failed on Flash — retrying with Pro');
              if (!this._proRetried) this._proRetried = new Map();
              this._proRetried.set(session.id, Date.now());
              selectedModel = GEMINI_MODELS.pro;
              maxTokens = GEMINI_PRO_MAX_TOKENS;
              // Remove last model response, retry
              contents = contents.slice(0, -1);
              loopCount--;
              continue;
            }
          }
        }

        // Add function responses to contents
        contents.push({ role: 'user', parts: functionResponses });
      }

      // Extract final text
      let finalText = '';
      if (lastResponse?.candidates?.[0]?.content?.parts) {
        const textParts = lastResponse.candidates[0].content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text);
        finalText = textParts.join('\n');
      }

      if (!finalText && loopCount >= MAX_TOOL_LOOPS) {
        const activeCtx = state.activeContext?.lastFreightCode
          ? ` sobre el flete ${state.activeContext.lastFreightCode}`
          : '';
        finalText = `La operación${activeCtx} requiere más pasos de los que puedo completar en una sola interacción. Por favor, intente con un pedido más específico o utilice la plataforma web: ${APP_URL}`;
      }

      if (!finalText) {
        finalText = 'No se pudo procesar el mensaje.';
      }

      // Cost logging
      const usageMetadata = lastResponse?.usageMetadata;
      if (usageMetadata) {
        const model = selectedModel === GEMINI_MODELS.flash ? 'flash' : 'pro';
        const escalated = this._proRetried?.has(session.id) || false;
        this.logger.log(`[cost] provider=gemini model=${model} escalated=${escalated} ` +
          `input=${usageMetadata.promptTokenCount ?? 0} output=${usageMetadata.candidatesTokenCount ?? 0} ` +
          `cached=${usageMetadata.cachedContentTokenCount ?? 0} loops=${loopCount}`);
      }

      // Post-process
      finalText = this.responseFormatter.validateResponse(finalText, isWeb);

      // Save history — convert Gemini contents back to Anthropic format for session storage
      const anthropicHistory = this.convertGeminiToAnthropicHistory(contents);
      aiMessages.length = 0;
      aiMessages.push(...anthropicHistory);

      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};
      const latestFlowStep = freshSession?.flowStep ?? session.flowStep;
      const latestFlowType = freshSession?.flowType ?? session.flowType;

      const sideEffects = this._chatSideEffects.get(session.id) || {};
      this._chatSideEffects.delete(session.id);

      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, _sessionExpiredNote: _expNote, _recoveredContext: _recCtx, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, _navigate, ...otherSideEffects } = sideEffects;

      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      const trimmedMessages = aiMessages.slice(-MAX_HISTORY).map((msg, idx, arr) => {
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
          ...(_navigate ? { _lastNavigate: _navigate } : { _lastNavigate: null }),
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
    } catch (e: any) {
      this._chatSideEffects.delete(session.id);
      this.logger.error(`Gemini chat error [session=${session.id} user=${user.id}]: ${e.message}`, e.stack?.slice(0, 500));
      return { text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente o utilice las opciones del menú.' };
    } finally {
      this._chatLocks.delete(session.id);
    }
  }

  // ======================== HISTORY CONVERSION =============================

  /**
   * Convert Anthropic-format session history to Gemini contents format.
   * Gemini enforces strict turn ordering:
   *   - Turns must alternate user/model
   *   - functionCall (model turn) must be followed by functionResponse (user turn)
   *   - No consecutive same-role turns
   *
   * If the history from a previous Anthropic session can't be cleanly converted,
   * we drop it and start fresh (Gemini will still have the system prompt context).
   */
  private convertHistoryToGemini(aiMessages: any[]): any[] {
    const contents: any[] = [];

    for (const msg of aiMessages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          contents.push({ role: 'user', parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          // Tool results from Anthropic format → functionResponse
          const fnParts: any[] = [];
          const textParts: any[] = [];
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              fnParts.push({
                functionResponse: {
                  name: block.tool_use_id || 'unknown',
                  response: { result: block.content || '' },
                },
              });
            } else if (block.type === 'text') {
              textParts.push({ text: block.text });
            }
          }
          // Function responses go in their own user turn
          if (fnParts.length > 0) {
            contents.push({ role: 'user', parts: fnParts });
          }
          // Text parts go in a separate user turn
          if (textParts.length > 0) {
            contents.push({ role: 'user', parts: textParts });
          }
        }
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          contents.push({ role: 'model', parts: [{ text: msg.content }] });
        } else if (Array.isArray(msg.content)) {
          const parts: any[] = [];
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                functionCall: { name: block.name, args: block.input || {} },
              });
            }
          }
          if (parts.length > 0) {
            contents.push({ role: 'model', parts });
          }
        }
      }
    }

    // Validate turn ordering for Gemini:
    // 1. Must start with 'user'
    // 2. No consecutive same-role turns (except user→user for fn response after text)
    // 3. functionCall (model) must be followed by functionResponse (user)
    const valid = this.validateGeminiTurns(contents);
    if (!valid) {
      this.logger.warn(`Invalid Gemini history (${contents.length} turns from Anthropic session) — starting fresh`);
      return [];
    }

    return contents;
  }

  /**
   * Validate Gemini conversation turns.
   * Returns false if the turn sequence would cause a 400 error.
   */
  private validateGeminiTurns(contents: any[]): boolean {
    if (contents.length === 0) return true;

    // Must start with user
    if (contents[0].role !== 'user') return false;

    for (let i = 0; i < contents.length; i++) {
      const curr = contents[i];
      const prev = i > 0 ? contents[i - 1] : null;

      // Check: model turn with functionCall must be followed by user turn with functionResponse
      if (prev?.role === 'model') {
        const hasFnCall = prev.parts?.some((p: any) => p.functionCall);
        if (hasFnCall) {
          if (curr.role !== 'user') return false;
          const hasFnResponse = curr.parts?.some((p: any) => p.functionResponse);
          if (!hasFnResponse) return false;
        }
      }

      // Check: no two consecutive model turns
      if (curr.role === 'model' && prev?.role === 'model') return false;
    }

    // Must not end with a model turn that has functionCall (no response)
    const last = contents[contents.length - 1];
    if (last.role === 'model' && last.parts?.some((p: any) => p.functionCall)) return false;

    return true;
  }

  /**
   * Convert Gemini contents back to Anthropic format for session storage.
   * This maintains compatibility with existing session management.
   */
  private convertGeminiToAnthropicHistory(contents: any[]): any[] {
    const messages: any[] = [];

    for (const entry of contents) {
      if (entry.role === 'user') {
        const hasFunctionResponse = entry.parts?.some((p: any) => p.functionResponse);
        if (hasFunctionResponse) {
          const toolResults = entry.parts
            .filter((p: any) => p.functionResponse)
            .map((p: any) => ({
              type: 'tool_result',
              tool_use_id: p.functionResponse.name,
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response?.result || p.functionResponse.response || ''),
            }));
          messages.push({ role: 'user', content: toolResults });
        } else {
          const text = entry.parts?.map((p: any) => p.text).filter(Boolean).join('\n') || '';
          if (text) messages.push({ role: 'user', content: text });
        }
      } else if (entry.role === 'model') {
        const blocks: any[] = [];
        for (const part of (entry.parts || [])) {
          if (part.text) {
            blocks.push({ type: 'text', text: part.text });
          } else if (part.functionCall) {
            blocks.push({
              type: 'tool_use',
              id: `gemini_${part.functionCall.name}_${Date.now()}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            });
          }
        }
        if (blocks.length > 0) {
          messages.push({ role: 'assistant', content: blocks });
        }
      }
    }

    return messages;
  }

  // ======================== TOOL EXECUTION ===============================
  // Delegates to AiService to avoid duplicating 188 tool handlers

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

  /**
   * Execute a tool by delegating to AiService's executeTool.
   * Shares the same 188 tool handlers without duplicating code.
   */
  private async executeTool(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
    plantAccessMap?: Map<string, string>,
  ): Promise<string> {
    return (this.aiService as any).executeTool(toolName, input, user, synUser, session, plantAccessMap);
  }

}
