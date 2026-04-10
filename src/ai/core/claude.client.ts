// =====================================================================
// TOLVINK — Claude Client (Anthropic SDK)
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

const AI_MODEL = 'claude-sonnet-4-20250514';
const MAX_OUTPUT_TOKENS = 2048;
const TEMPERATURE = 0.3;

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
      this.logger.warn('ANTHROPIC_API_KEY not set — AI disabled');
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

    return this.client.messages.create({
      model: AI_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      system: [
        {
          type: 'text' as const,
          text: params.system,
          cache_control: { type: 'ephemeral' as const },
        },
      ],
      tools: params.tools.length > 0
        ? params.tools.map((tool, idx) => {
            if (idx === params.tools.length - 1) {
              return { ...tool, cache_control: { type: 'ephemeral' as const } };
            }
            return tool;
          })
        : undefined as any,
      messages: params.messages,
    });
  }
}
