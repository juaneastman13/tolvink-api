// =====================================================================
// TOLVINK — Gemini Client (@google/genai SDK)
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import type { AiToolDefinition } from '../tools/tool-definitions';

const AI_MODEL = 'gemini-3.1-flash-lite-preview';
const MAX_OUTPUT_TOKENS = 2048;
const TEMPERATURE = 0.3;

/** Gemini message format */
export interface GeminiMessage {
  role: 'user' | 'model';
  parts: any[];
}

/** Parsed response from Gemini */
export interface GeminiResponse {
  text: string;
  functionCalls: Array<{ name: string; args: any }>;
  usageMetadata?: any;
}

@Injectable()
export class GeminiClient implements OnModuleInit {
  private readonly logger = new Logger(GeminiClient.name);
  private client: GoogleGenAI | null = null;

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey });
      this.logger.log(`Gemini client initialized (model: ${AI_MODEL})`);
    } else {
      this.logger.warn('GEMINI_API_KEY not set — AI disabled');
    }
  }

  isEnabled(): boolean {
    return !!this.client;
  }

  /** Convert Anthropic-format tool definitions to Gemini function declarations */
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
      model: AI_MODEL,
      contents: params.messages,
      config: {
        systemInstruction: params.system,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
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
      usageMetadata: usage,
    };
  }
}
