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

interface ChatOptions {
  model?: 'sonnet' | 'haiku';
  temperature?: number;
  maxTokens?: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private client: Anthropic;
  private anthropicKey: string;

  // Model IDs
  private readonly SONNET_MODEL = 'claude-sonnet-4-6-20250514';
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
   * Call Claude for a conversation turn. System prompt gets prompt caching for cost reduction.
   * Returns the text content of the assistant's response.
   */
  async chat(systemPrompt: string, messages: MessageParam[], options: ChatOptions = {}): Promise<string> {
    const startTime = Date.now();
    const model = options.model === 'haiku' ? this.HAIKU_MODEL : this.DEFAULT_MODEL;

    try {
      if (!this.anthropicKey) {
        throw new AgentLlmError('ANTHROPIC_API_KEY not configured', 'NO_API_KEY');
      }

      const response = await this.client.messages.create({
        model,
        max_tokens: options.maxTokens ?? 1024,
        temperature: options.temperature ?? 0.7,
        system: systemPrompt,
        messages,
      } as any); // TODO: Etapa 2 - Add prompt caching with cache_control when SDK supports it

      const elapsed = Date.now() - startTime;
      const textContent = response.content.find((c) => c.type === 'text');
      const responseText = textContent && textContent.type === 'text' ? textContent.text : '';

      this.logger.debug(
        `[LLM] ${model} completed in ${elapsed}ms | ` +
        `tokens: ${response.usage.input_tokens} in, ${response.usage.output_tokens} out`,
      );

      return responseText;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      this.logger.error(`[LLM] Error after ${elapsed}ms: ${error instanceof Error ? error.message : String(error)}`);

      if (error instanceof Anthropic.APIError) {
        throw new AgentLlmError(
          `Anthropic API error: ${error.message}`,
          error.status?.toString() ?? 'UNKNOWN',
          error,
        );
      }

      if (error instanceof AgentLlmError) {
        throw error;
      }

      throw new AgentLlmError(
        `LLM error: ${error instanceof Error ? error.message : String(error)}`,
        'UNKNOWN',
        error,
      );
    }
  }

  /**
   * Get the model ID (for testing/logging purposes)
   */
  getModelId(type: 'sonnet' | 'haiku' = 'sonnet'): string {
    return type === 'haiku' ? this.HAIKU_MODEL : this.SONNET_MODEL;
  }

  /**
   * Check if the API key is configured
   */
  isConfigured(): boolean {
    return !!this.anthropicKey;
  }
}
