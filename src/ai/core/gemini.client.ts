// =====================================================================
// TOLVINK — Gemini Client (@google/genai SDK)
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import type { AiToolDefinition } from '../tools/tool-definitions';
import {
  getConfiguredAiProvider,
  getGeminiMaxOutputTokens,
  getGeminiModel,
  getGeminiTemperature,
  LlmMessage,
  LlmResponse,
  ToolCallingLlmProvider,
} from './llm-provider';

export type GeminiMessage = LlmMessage;
export type GeminiResponse = LlmResponse;

@Injectable()
export class GeminiClient implements OnModuleInit, ToolCallingLlmProvider {
  private readonly logger = new Logger(GeminiClient.name);
  private client: GoogleGenAI | null = null;
  private readonly provider = getConfiguredAiProvider();
  private readonly model = getGeminiModel();
  private readonly maxOutputTokens = getGeminiMaxOutputTokens();
  private readonly temperature = getGeminiTemperature();

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      if (this.provider !== 'gemini') {
        this.logger.warn(`Unsupported AI_PROVIDER=${this.provider}; falling back to Gemini because GEMINI_API_KEY is configured`);
      }
      this.client = new GoogleGenAI({ apiKey });
      this.logger.log(`Gemini client initialized (model: ${this.model}, key: ${apiKey.slice(0, 8)}...)`);
    } else {
      this.logger.error('GEMINI_API_KEY not set — Mechanic module will be unavailable');
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  /** Convert Tolvink tool definitions to Gemini function declarations */
  convertTools(tools: AiToolDefinition[]): any[] {
    return tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: {
        type: 'OBJECT',
        properties: Object.fromEntries(
          Object.entries(t.input_schema.properties || {}).map(([k, v]: [string, any]) => [k, {
            type: (v.type || 'string').toUpperCase(),
            description: v.description || '',
            ...(v.enum ? { enum: v.enum } : {}),
          }]),
        ),
        ...(t.input_schema.required?.length ? { required: t.input_schema.required } : {}),
      },
    }));
  }

  /** Convert Anthropic-format message history to Gemini format */
  convertHistory(messages: any[]): GeminiMessage[] {
    const result: GeminiMessage[] = [];

    for (const msg of messages) {
      if (!msg || !msg.role) continue;

      const geminiRole = msg.role === 'assistant' ? 'model' : 'user';

      if (typeof msg.content === 'string') {
        result.push({ role: geminiRole, parts: [{ text: msg.content }] });
        continue;
      }

      if (!Array.isArray(msg.content)) continue;

      const parts: any[] = [];
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === 'text' && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === 'tool_use') {
          parts.push({ functionCall: { name: block.name, args: block.input || {} } });
        } else if (block.type === 'tool_result') {
          parts.push({
            functionResponse: {
              name: block.tool_use_id || 'unknown',
              response: { result: block.content || '' },
            },
          });
        }
      }

      if (parts.length > 0) {
        result.push({ role: geminiRole, parts });
      }
    }

    return result;
  }

  async sendMessage(params: {
    system: string;
    messages: GeminiMessage[];
    tools: any[];
  }): Promise<GeminiResponse> {
    if (!this.client) throw new Error('Gemini client not initialized');

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: params.messages,
      config: {
        systemInstruction: params.system,
        maxOutputTokens: this.maxOutputTokens,
        temperature: this.temperature,
        tools: params.tools.length > 0 ? [{ functionDeclarations: params.tools }] : undefined,
      },
    });

    // Parse response
    const candidate = response.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text);
    const functionCalls = parts
      .filter((p: any) => p.functionCall)
      .map((p: any) => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));

    // Log usage
    const usage = response.usageMetadata;
    if (usage) {
      this.logger.log(
        `[cost] in=${usage.promptTokenCount || 0} out=${usage.candidatesTokenCount || 0}` +
        (usage.cachedContentTokenCount ? ` cached=${usage.cachedContentTokenCount}` : ''),
      );
    }

    return {
      text: textParts.join('\n'),
      functionCalls,
      rawParts: parts,
      usageMetadata: usage,
    };
  }
}
