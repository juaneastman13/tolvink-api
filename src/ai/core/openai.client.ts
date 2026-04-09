// =====================================================================
// TOLVINK — OpenAI GPT client wrapper
// Same interface as GeminiClient so agent.service can switch providers
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import OpenAI from 'openai';
import { AI_MODEL_OPENAI, MODEL_TEMPERATURE } from './constants';
import { GeminiMessage, GeminiCallResult } from './gemini.client';
import { RunTree } from 'langsmith/run_trees';
import { sanitizeErrorForLog } from '../utils/error-handler';

@Injectable()
export class OpenAIClient implements OnModuleInit {
  private readonly logger = new Logger(OpenAIClient.name);
  private client: OpenAI | null = null;
  private readonly maxRetries = 3;
  private readonly baseRetryDelayMs = 400;
  private readonly langsmithEnabled =
    String(process.env.LANGSMITH_TRACING || '').toLowerCase() === 'true' && !!process.env.LANGSMITH_API_KEY;

  onModuleInit() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      this.logger.log(`OpenAI client initialized (model: ${AI_MODEL_OPENAI})`);
    } else {
      this.logger.warn('OPENAI_API_KEY not set — OpenAI provider disabled');
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  /** Convert Anthropic-style tool definitions to OpenAI function tools. */
  convertToolDeclarations(tools: any[]): any[] {
    // Return the original definitions — they are passed opaquely to generateContent
    // which does the actual OpenAI format conversion internally.
    return tools;
  }

  /**
   * Convert Gemini-format history to OpenAI chat messages.
   * Handles text, functionCall (→ tool_calls), and functionResponse (→ tool messages).
   */
  private convertHistory(geminiMessages: GeminiMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    for (const msg of geminiMessages) {
      if (msg.role === 'user') {
        const funcResponses = (msg.parts || []).filter((p: any) => p.functionResponse);
        const textParts = (msg.parts || []).filter((p: any) => p.text);

        if (funcResponses.length > 0) {
          // Tool results
          for (const fr of funcResponses) {
            const resp = fr.functionResponse!;
            messages.push({
              role: 'tool' as const,
              tool_call_id: (resp as any)._toolCallId || resp.name,
              content: typeof resp.response?.result === 'string'
                ? resp.response.result
                : JSON.stringify(resp.response?.result || resp.response || ''),
            });
          }
          if (textParts.length > 0) {
            messages.push({
              role: 'user' as const,
              content: textParts.map((p: any) => p.text).join('\n'),
            });
          }
        } else {
          messages.push({
            role: 'user' as const,
            content: (msg.parts || []).map((p: any) => p.text || '').filter(Boolean).join('\n'),
          });
        }
      } else if (msg.role === 'model') {
        const funcCalls = (msg.parts || []).filter((p: any) => p.functionCall);
        const textParts = (msg.parts || []).filter((p: any) => p.text);

        if (funcCalls.length > 0) {
          messages.push({
            role: 'assistant' as const,
            content: textParts.length > 0 ? textParts.map((p: any) => p.text).join('\n') : null,
            tool_calls: funcCalls.map((fc: any) => ({
              id: fc.functionCall._toolCallId || fc.functionCall.name,
              type: 'function' as const,
              function: {
                name: fc.functionCall.name,
                arguments: JSON.stringify(fc.functionCall.args || {}),
              },
            })),
          });
        } else {
          messages.push({
            role: 'assistant' as const,
            content: textParts.map((p: any) => p.text || '').filter(Boolean).join('\n') || '',
          });
        }
      }
    }

    return messages;
  }

  /** Build OpenAI tools array from tool definitions. */
  private buildOpenAITools(tools: any[]): OpenAI.Chat.ChatCompletionTool[] {
    return tools.map((t: any) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema || t.parameters || { type: 'object', properties: {}, required: [] },
      },
    }));
  }

  /**
   * Main call — same signature as GeminiClient.generateContent.
   * thinkingBudget is ignored (OpenAI doesn't have this feature).
   */
  async generateContent(
    systemInstruction: string,
    contents: GeminiMessage[],
    functionDeclarations: any[],
    _thinkingBudget?: number,
  ): Promise<GeminiCallResult> {
    if (!this.client) throw new Error('OpenAI client not initialized');

    const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemInstruction },
      ...this.convertHistory(contents),
    ];

    const openaiTools = functionDeclarations.length > 0
      ? this.buildOpenAITools(functionDeclarations)
      : undefined;

    // LangSmith tracing
    let llmTrace: RunTree | null = null;
    if (this.langsmithEnabled) {
      try {
        llmTrace = new RunTree({
          name: 'openai.chat_completion',
          run_type: 'llm',
          inputs: {
            model: AI_MODEL_OPENAI,
            messageCount: contents.length,
            toolsCount: functionDeclarations.length,
          },
          tags: ['tolvink', 'ai', 'openai'],
          metadata: {
            component: 'OpenAIClient',
            ls_provider: 'openai',
            ls_model_name: AI_MODEL_OPENAI,
            ls_temperature: MODEL_TEMPERATURE,
          },
        });
        await llmTrace.postRun();
      } catch (e: any) {
        this.logger.warn(`LangSmith llm trace init failed: ${sanitizeErrorForLog(e?.message)}`);
        llmTrace = null;
      }
    }

    // Call with retries
    let response: OpenAI.Chat.ChatCompletion | null = null;
    let lastErr: any;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        response = await this.client.chat.completions.create({
          model: AI_MODEL_OPENAI,
          messages: openaiMessages,
          tools: openaiTools,
          temperature: MODEL_TEMPERATURE,
          max_tokens: 2048,
        });
        break;
      } catch (e: any) {
        lastErr = e;
        const status = e?.status || e?.error?.status;
        const isRetryable = [429, 500, 503].includes(status) ||
          String(e?.message || '').includes('rate limit');
        if (!isRetryable || attempt === this.maxRetries) {
          if (llmTrace) {
            try {
              await llmTrace.end({ status: 'error', attempt }, String(e?.message || 'llm_error'));
              await llmTrace.patchRun();
            } catch {}
          }
          throw e;
        }
        const waitMs = this.baseRetryDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 120);
        this.logger.warn(`OpenAI error (attempt ${attempt + 1}/${this.maxRetries + 1}), retrying in ${waitMs}ms`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    }

    if (!response) throw lastErr || new Error('OpenAI response unavailable');

    const choice = response.choices[0];
    const message = choice?.message;

    // Extract text
    const text = message?.content || null;

    // Extract tool calls → GeminiCallResult format
    let functionCalls: GeminiCallResult['functionCalls'] = null;
    if (message?.tool_calls && message.tool_calls.length > 0) {
      functionCalls = message.tool_calls.map((tc: any) => {
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        const fnName = tc.function?.name || 'unknown';
        return {
          name: fnName,
          args,
          raw: { name: fnName, args, id: tc.id },
          rawPart: { functionCall: { name: fnName, args, _toolCallId: tc.id } },
        };
      });
    }

    // Map finish reason
    const finishReason = choice?.finish_reason === 'tool_calls' ? 'TOOL_CALLS'
      : choice?.finish_reason === 'stop' ? 'STOP'
      : choice?.finish_reason || 'STOP';

    const usageMetadata = {
      promptTokenCount: response.usage?.prompt_tokens || 0,
      candidatesTokenCount: response.usage?.completion_tokens || 0,
      totalTokenCount: response.usage?.total_tokens || 0,
    };

    if (llmTrace) {
      try {
        llmTrace.extra.metadata = {
          ...(llmTrace.extra.metadata || {}),
          ls_provider: 'openai',
          ls_model_name: AI_MODEL_OPENAI,
          ls_temperature: MODEL_TEMPERATURE,
          usage_metadata: usageMetadata,
        };
        await llmTrace.end({
          status: 'ok',
          model: AI_MODEL_OPENAI,
          finishReason,
          textChars: text?.length || 0,
          functionCallCount: functionCalls?.length || 0,
          promptTokens: usageMetadata.promptTokenCount,
          outputTokens: usageMetadata.candidatesTokenCount,
          totalTokens: usageMetadata.totalTokenCount,
        });
        await llmTrace.patchRun();
      } catch {}
    }

    return {
      text,
      functionCalls,
      finishReason,
      usageMetadata,
    };
  }
}
