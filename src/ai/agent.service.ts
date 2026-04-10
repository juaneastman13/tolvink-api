// =====================================================================
// TOLVINK — Agent Service (Claude Sonnet + native tool use)
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaService } from '../database/prisma.service';
import { ClaudeClient } from './core/claude.client';
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
    private claude: ClaudeClient,
    private toolExecutor: ToolExecutorService,
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
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    if (!this.claude.isEnabled()) {
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

      // Load history from session
      const state = (session?.flowState as any) || {};
      const storedMessages: Anthropic.MessageParam[] = state.aiMessages || [];

      // Build messages: trimmed history + new user message
      let messages: Anthropic.MessageParam[] = [
        ...this.trimHistory(storedMessages),
        { role: 'user' as const, content: userMessage.slice(0, 5000) },
      ];

      // Convert tool definitions to Anthropic format
      const tools: Anthropic.Tool[] = ALL_TOOL_DEFINITIONS.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      }));

      // Tool loop
      const loopDeadline = Date.now() + TOOL_TIMEOUT_MS;
      let loopCount = 0;
      let lastResponse: Anthropic.Message | null = null;

      while (loopCount < MAX_TOOL_ITERATIONS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Claude call #${loopCount}, messages: ${messages.length}, tools: ${tools.length}`);

        const response = await this.claude.sendMessage({ system: systemPrompt, messages, tools });
        lastResponse = response;

        // Log cost
        const u = response.usage;
        this.logger.log(
          `[cost] in=${u.input_tokens} out=${u.output_tokens}` +
          ((u as any).cache_read_input_tokens ? ` cache_read=${(u as any).cache_read_input_tokens}` : ''),
        );

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
          // Parallel for read-only
          const settled = await Promise.allSettled(toolUseBlocks.map(async (block) => {
            this.logger.log(`Tool (parallel): ${block.name}`);
            const result = await this.toolExecutor.executeTool(block.name, block.input, user, session);
            return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
          }));
          toolResults = settled.map((s, i) =>
            s.status === 'fulfilled'
              ? s.value
              : { type: 'tool_result' as const, tool_use_id: toolUseBlocks[i].id, content: `Error: ${(s as any).reason?.message || 'Unknown'}`, is_error: true },
          );
        } else {
          // Sequential
          toolResults = [];
          for (const block of toolUseBlocks) {
            this.logger.log(`Tool: ${block.name}`);
            const result = await this.toolExecutor.executeTool(block.name, block.input, user, session);
            toolResults.push({ type: 'tool_result' as const, tool_use_id: block.id, content: result });
          }
        }

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
        finalText = 'No se pudo procesar el mensaje.';
      }

      // Truncate response
      const maxChars = isWeb ? WEB_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS;
      if (finalText.length > maxChars) {
        const breakPoint = finalText.lastIndexOf('\n', maxChars);
        finalText = breakPoint > maxChars * 0.5 ? finalText.slice(0, breakPoint) : finalText.slice(0, maxChars);
      }

      // Strip UUIDs from response
      finalText = finalText.replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        (match, offset) => {
          const before = finalText.slice(Math.max(0, offset - 80), offset);
          if (/https?:\/\/\S*$/i.test(before)) return match;
          return '';
        },
      );

      // Get pending buttons from tool executor
      const pendingButtons = this.toolExecutor.getPendingButtons(session?.id);

      // Save history to session
      const trimmedMessages = messages.slice(-MAX_HISTORY_MESSAGES);
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...state,
            aiMessages: trimmedMessages,
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

  private trimHistory(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    // Filter out any messages from old agent formats (Gemini/OpenAI) that aren't valid Anthropic
    let cleaned = messages.filter((m: any) => {
      // Must have role
      if (!m || !m.role) return false;
      // Skip messages with Gemini-style parts (functionCall, functionResponse)
      if (Array.isArray(m.parts)) return false;
      // Validate content
      const content = m.content;
      if (typeof content === 'string') return true;
      if (Array.isArray(content)) {
        // Filter out blocks with unknown types
        const validTypes = new Set(['text', 'tool_use', 'tool_result', 'image']);
        return content.length > 0 && content.every((b: any) => b && validTypes.has(b.type));
      }
      return false;
    });

    // Trim to max
    if (cleaned.length > MAX_HISTORY_MESSAGES) {
      cleaned = cleaned.slice(-MAX_HISTORY_MESSAGES);
    }

    // Remove leading assistant messages (Anthropic requires first message to be user)
    while (cleaned.length > 0 && cleaned[0].role !== 'user') {
      cleaned.shift();
    }

    // Remove orphaned tool_results at start (no matching tool_use in previous assistant message)
    while (cleaned.length > 0 && cleaned[0].role === 'user') {
      const content = cleaned[0].content;
      if (Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result') {
        cleaned.shift();
        // Also remove leading assistant messages that may follow
        while (cleaned.length > 0 && cleaned[0].role !== 'user') {
          cleaned.shift();
        }
      } else {
        break;
      }
    }

    return cleaned;
  }
}
