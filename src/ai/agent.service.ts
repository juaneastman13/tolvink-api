// =====================================================================
// TOLVINK — Agent Service (Gemini Flash Lite + native function calling)
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GeminiClient, GeminiMessage } from './core/gemini.client';
import { buildSystemPrompt } from './core/prompt-builder';
import { ToolExecutorService, READ_ONLY_TOOLS } from './tools/tool-executor';
import { ALL_TOOL_DEFINITIONS } from './tools/tool-definitions';
import { checkRateLimit, cleanupRateLimits } from './utils/rate-limiter';
import { classifyAiError, sanitizeErrorForLog } from '../common/error-utils';
import {
  MAX_TOOL_ITERATIONS, TOOL_TIMEOUT_MS, SESSION_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES, PROMPT_CACHE_TTL_MS, MAX_RESPONSE_CHARS,
  WEB_MAX_RESPONSE_CHARS,
} from './core/constants';

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private _chatLocks = new Set<string>();
  private _promptCache = new Map<string, { prompt: string; ts: number }>();

  private cleanupTimer = setInterval(() => {
    cleanupRateLimits();
    this.toolExecutor.cleanupPendingActions();
    const now = Date.now();
    for (const [k, v] of this._promptCache) {
      if (now - v.ts > PROMPT_CACHE_TTL_MS) this._promptCache.delete(k);
    }
  }, 5 * 60 * 1000);

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiClient,
    private toolExecutor: ToolExecutorService,
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
    _onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    if (!this.gemini.isEnabled()) {
      return { text: 'El asistente IA no esta disponible en este momento.' };
    }

    // Rate limiting
    if (checkRateLimit(user.id || phone)) {
      return { text: 'Muchos mensajes seguidos. Aguarda unos minutos.' };
    }

    // Concurrency lock
    const lockKey = session?.id || `phone:${phone}`;
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

    const isWeb = phone === 'web';

    try {
      // Build system prompt (cached)
      const cacheKey = `${session?.id}:${isWeb}`;
      const cached = this._promptCache.get(cacheKey);
      let systemPrompt: string;
      if (cached && Date.now() - cached.ts < PROMPT_CACHE_TTL_MS) {
        systemPrompt = cached.prompt;
      } else {
        systemPrompt = buildSystemPrompt(user, isWeb);
        this._promptCache.set(cacheKey, { prompt: systemPrompt, ts: Date.now() });
      }

      // Load history from session — stored in Anthropic format, convert to Gemini
      const state = (session?.flowState as any) || {};
      const storedMessages: any[] = state.aiMessages || [];

      // Add document indicator if there's a pending photo/file
      const pendingDoc = state.pendingDocument;
      const docIndicator = pendingDoc?.url ? `\n[ARCHIVO PENDIENTE: "${pendingDoc.name}" listo para adjuntar con attach_document]` : '';
      const userText = userMessage.slice(0, 5000) + docIndicator;

      // Convert stored history to Gemini format + add new user message
      const trimmedHistory = this.trimHistory(storedMessages);
      let geminiMessages: GeminiMessage[] = [
        ...this.gemini.convertHistory(trimmedHistory),
        { role: 'user', parts: [{ text: userText }] },
      ];

      // Filter and convert tool definitions
      const filteredDefs = this.toolExecutor.filterTools(ALL_TOOL_DEFINITIONS, user);
      const geminiTools = this.gemini.convertTools(filteredDefs);

      // Tool loop
      const loopDeadline = Date.now() + TOOL_TIMEOUT_MS;
      let loopCount = 0;
      let lastText = '';

      while (loopCount < MAX_TOOL_ITERATIONS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Gemini call #${loopCount}, messages: ${geminiMessages.length}, tools: ${geminiTools.length}`);

        const response = await this.gemini.sendMessage({
          system: systemPrompt,
          messages: geminiMessages,
          tools: geminiTools,
        });

        lastText = response.text;

        // Add model response to messages
        const modelParts: any[] = [];
        if (response.text) modelParts.push({ text: response.text });
        for (const fc of response.functionCalls) {
          modelParts.push({ functionCall: { name: fc.name, args: fc.args } });
        }
        if (modelParts.length > 0) {
          geminiMessages.push({ role: 'model', parts: modelParts });
        }

        // No function calls — model is done
        if (response.functionCalls.length === 0) {
          break;
        }

        // Execute tools
        const allReadOnly = response.functionCalls.every(fc => READ_ONLY_TOOLS.has(fc.name));
        const toolResponses: any[] = [];

        if (allReadOnly && response.functionCalls.length > 1) {
          // Parallel for read-only
          const settled = await Promise.allSettled(response.functionCalls.map(async (fc) => {
            this.logger.log(`Tool (parallel): ${fc.name}`);
            const result = await this.toolExecutor.executeTool(fc.name, fc.args, user, session);
            return { functionResponse: { name: fc.name, response: { result } } };
          }));
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            toolResponses.push(
              s.status === 'fulfilled'
                ? s.value
                : { functionResponse: { name: response.functionCalls[i].name, response: { result: `Error: ${(s as any).reason?.message || 'Unknown'}` } } },
            );
          }
        } else {
          // Sequential
          for (const fc of response.functionCalls) {
            this.logger.log(`Tool: ${fc.name}`);
            const result = await this.toolExecutor.executeTool(fc.name, fc.args, user, session);
            toolResponses.push({ functionResponse: { name: fc.name, response: { result } } });
          }
        }

        geminiMessages.push({ role: 'user', parts: toolResponses });

        // If a tool staged an action with buttons, exit loop immediately
        if (this.toolExecutor.hasPendingAction(session?.id)) {
          this.logger.log('Pending action staged — exiting tool loop');
          break;
        }
      }

      // Get pending buttons from tool executor
      const pendingButtons = this.toolExecutor.getPendingButtons(session?.id);

      // When there are pending buttons, use ONLY the staging summary
      let finalText: string;
      if (pendingButtons) {
        finalText = this.toolExecutor.getPendingSummary(session?.id) || '';
      } else {
        finalText = lastText;

        // Truncate response
        const maxChars = isWeb ? WEB_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS;
        if (finalText.length > maxChars) {
          const breakPoint = finalText.lastIndexOf('\n', maxChars);
          finalText = breakPoint > maxChars * 0.5 ? finalText.slice(0, breakPoint) : finalText.slice(0, maxChars);
        }

        // Strip UUIDs from non-staging responses
        finalText = finalText.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          (match, offset) => {
            const before = finalText.slice(Math.max(0, offset - 80), offset);
            if (/https?:\/\/\S*$/i.test(before)) return match;
            return '';
          },
        );
      }

      if (!finalText) {
        finalText = 'No se pudo procesar el mensaje.';
      }

      // Save history to session — convert Gemini messages back to storable format
      // Store in a neutral format that can be converted to either Gemini or Anthropic
      const allMessages = [...trimmedHistory];
      // Add user message
      allMessages.push({ role: 'user', content: userText });
      // Add model responses and tool results from gemini messages (skip the ones already in trimmedHistory + new user)
      const newGeminiMessages = geminiMessages.slice(trimmedHistory.length + 1); // skip converted history + user message
      for (const gMsg of newGeminiMessages) {
        if (gMsg.role === 'model') {
          const content: any[] = [];
          for (const part of gMsg.parts) {
            if (part.text) content.push({ type: 'text', text: part.text });
            if (part.functionCall) content.push({ type: 'tool_use', id: `call_${Date.now()}`, name: part.functionCall.name, input: part.functionCall.args || {} });
          }
          allMessages.push({ role: 'assistant', content });
        } else if (gMsg.role === 'user') {
          const content: any[] = [];
          for (const part of gMsg.parts) {
            if (part.text) content.push({ type: 'text', text: part.text });
            if (part.functionResponse) content.push({ type: 'tool_result', tool_use_id: part.functionResponse.name, content: typeof part.functionResponse.response?.result === 'string' ? part.functionResponse.response.result : JSON.stringify(part.functionResponse.response?.result || '') });
          }
          allMessages.push({ role: 'user', content });
        }
      }

      const trimmedToStore = allMessages.slice(-MAX_HISTORY_MESSAGES);

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...state,
            aiMessages: trimmedToStore,
            lastMessageAt: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
        },
      });

      return {
        text: finalText.trim(),
        buttons: pendingButtons,
      };
    } catch (e: any) {
      const errCode = classifyAiError(e);
      this.logger.error(`Chat error [${errCode}]: ${sanitizeErrorForLog(e?.message)}`, e.stack?.slice(0, 300));
      if (errCode === 'rate_limited') {
        return { text: 'El asistente esta con alta demanda. Intenta en unos segundos.' };
      }
      return { text: 'Se produjo un inconveniente. Intenta de nuevo.' };
    } finally {
      this._chatLocks.delete(lockKey);
    }
  }

  /** Trim and sanitize stored history messages */
  private trimHistory(messages: any[]): any[] {
    const validTypes = new Set(['text', 'tool_use', 'tool_result', 'image']);

    let cleaned = messages.filter((m: any) => {
      if (!m || !m.role) return false;
      const content = m.content;
      if (typeof content === 'string') return true;
      if (Array.isArray(content)) {
        return content.length > 0 && content.every((b: any) => b && validTypes.has(b.type));
      }
      return false;
    });

    if (cleaned.length > MAX_HISTORY_MESSAGES) {
      cleaned = cleaned.slice(-MAX_HISTORY_MESSAGES);
    }

    // Ensure valid start: must begin with user role, no orphaned tool_results
    let changed = true;
    while (changed && cleaned.length > 0) {
      changed = false;
      if (cleaned[0]?.role !== 'user') {
        cleaned.shift();
        changed = true;
        continue;
      }
      const content = cleaned[0].content;
      if (Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result') {
        cleaned.shift();
        changed = true;
      }
    }

    return cleaned;
  }
}
