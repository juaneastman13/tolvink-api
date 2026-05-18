import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

export class AgentLlmError extends Error {
  constructor(message: string, public readonly code: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'AgentLlmError';
  }
}

type MessageParam = Anthropic.Messages.MessageParam;
type Tool = Anthropic.Messages.Tool;
type Message = Anthropic.Messages.Message;

interface ChatOptions {
  model?: 'sonnet' | 'haiku';
  temperature?: number;
  maxTokens?: number;
  tools?: Tool[];
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client: Anthropic;
  private anthropicKey: string;

  private readonly SONNET_MODEL = 'claude-sonnet-4-6';
  private readonly HAIKU_MODEL = 'claude-haiku-4-5-20251001';
  private readonly DEFAULT_MODEL = this.SONNET_MODEL;

  constructor(private config: ConfigService) {
    this.anthropicKey = this.config.get<string>('ANTHROPIC_API_KEY') || '';
    if (!this.anthropicKey) {
      this.logger.warn('ANTHROPIC_API_KEY not set — LLM calls will fail');
    }
    this.client = new Anthropic({ apiKey: this.anthropicKey });
  }

  /**
   * Call Claude and return the assistant's text reply (no tools).
   * For tool use, call `complete()` instead.
   */
  async chat(systemPrompt: string, messages: MessageParam[], options: ChatOptions = {}): Promise<string> {
    const response = await this.complete(systemPrompt, messages, options);
    const textContent = response.content.find((c) => c.type === 'text');
    return textContent && textContent.type === 'text' ? textContent.text : '';
  }

  /**
   * Call Claude and return the full Message (with tool_use blocks if tools are provided).
   */
  async complete(systemPrompt: string, messages: MessageParam[], options: ChatOptions = {}): Promise<Message> {
    const startTime = Date.now();
    const model = options.model === 'haiku' ? this.HAIKU_MODEL : this.DEFAULT_MODEL;

    try {
      if (!this.anthropicKey) {
        throw new AgentLlmError('ANTHROPIC_API_KEY not configured', 'NO_API_KEY');
      }

      const request: Anthropic.Messages.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.7,
        system: systemPrompt,
        messages,
      };
      if (options.tools && options.tools.length > 0) {
        request.tools = options.tools;
      }

      const response = await this.client.messages.create(request);

      const elapsed = Date.now() - startTime;
      const toolCalls = response.content.filter((c) => c.type === 'tool_use').length;
      this.logger.debug(
        `[LLM] ${model} ${elapsed}ms | in:${response.usage.input_tokens} out:${response.usage.output_tokens} | tools:${toolCalls} | stop:${response.stop_reason}`,
      );

      return response;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`[LLM] Error after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);

      if (error instanceof Anthropic.APIError) {
        throw new AgentLlmError(`Anthropic API error: ${error.message}`, error.status?.toString() ?? 'UNKNOWN', error);
      }
      if (error instanceof AgentLlmError) throw error;
      throw new AgentLlmError(
        `LLM error: ${error instanceof Error ? error.message : String(error)}`,
        'UNKNOWN',
        error,
      );
    }
  }

  getModelId(type: 'sonnet' | 'haiku' = 'sonnet'): string {
    return type === 'haiku' ? this.HAIKU_MODEL : this.SONNET_MODEL;
  }

  isConfigured(): boolean {
    return !!this.anthropicKey;
  }
}
