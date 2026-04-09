// =====================================================================
// TOLVINK — Claude Sonnet Client (Anthropic SDK)
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, MODEL_TEMPERATURE, MAX_OUTPUT_TOKENS } from './constants';
import { sanitizeErrorForLog } from '../utils/error-handler';

@Injectable()
export class ClaudeClient implements OnModuleInit {
  private readonly logger = new Logger(ClaudeClient.name);
  private client: Anthropic | null = null;

  onModuleInit() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log(`Claude client initialized (model: ${AI_MODEL})`);
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('ANTHROPIC_API_KEY is required in production');
      }
      this.logger.warn('ANTHROPIC_API_KEY not set — AI assistant disabled');
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  async sendMessage(params: {
    system: string;
    messages: Anthropic.MessageParam[];
    tools: Anthropic.Tool[];
  }): Promise<Anthropic.Message> {
    if (!this.client) throw new Error('Claude client not initialized');

    const response = await this.client.messages.create({
      model: AI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: MODEL_TEMPERATURE,
      system: [
        {
          type: 'text' as const,
          text: params.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      tools: params.tools.map((tool, idx) => {
        if (idx === params.tools.length - 1) {
          return { ...tool, cache_control: { type: 'ephemeral' as const } };
        }
        return tool;
      }),
      messages: params.messages,
    });

    this.logger.log(
      `[cost] input=${response.usage.input_tokens} output=${response.usage.output_tokens}` +
      ((response.usage as any).cache_creation_input_tokens ? ` cache_create=${(response.usage as any).cache_creation_input_tokens}` : '') +
      ((response.usage as any).cache_read_input_tokens ? ` cache_read=${(response.usage as any).cache_read_input_tokens}` : ''),
    );

    return response;
  }
}
