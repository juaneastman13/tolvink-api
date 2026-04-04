// =====================================================================
// TOLVINK — Google Gemini API client wrapper
// Uses @google/genai SDK with gemini-3.1-flash-lite-preview
// =====================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenAI, Type as GeminiType } from '@google/genai';
import { AI_MODEL, MODEL_TEMPERATURE } from './constants';

export interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<{ text?: string; functionCall?: { name: string; args: any }; functionResponse?: { name: string; response: any } }>;
}

export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export interface GeminiCallResult {
  text: string | null;
  functionCalls: Array<{ name: string; args: any; raw: any; rawPart: any }> | null;
  finishReason: string;
  usageMetadata?: any;
}

@Injectable()
export class GeminiClient implements OnModuleInit {
  private readonly logger = new Logger(GeminiClient.name);
  private ai: GoogleGenAI | null = null;

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
      this.logger.log(`Gemini AI client initialized (model: ${AI_MODEL})`);
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('GEMINI_API_KEY is required in production');
      }
      this.logger.warn('GEMINI_API_KEY not set — AI assistant disabled');
    }
  }

  isEnabled(): boolean {
    return !!this.ai;
  }

  /** Convert Anthropic-style tool definitions to Gemini function declarations. */
  convertToolDeclarations(tools: any[]): GeminiFunctionDeclaration[] {
    return tools.map(t => {
      const params = t.input_schema || t.parameters;
      const converted: GeminiFunctionDeclaration = {
        name: t.name,
        description: t.description,
      };
      if (params && Object.keys(params.properties || {}).length > 0) {
        converted.parameters = this.convertSchema(params);
      }
      return converted;
    });
  }

  /** Convert JSON Schema to Gemini OpenAPI-style schema. */
  private convertSchema(schema: any): any {
    if (!schema) return undefined;

    const typeMap: Record<string, string> = {
      string: 'STRING',
      number: 'NUMBER',
      integer: 'INTEGER',
      boolean: 'BOOLEAN',
      object: 'OBJECT',
      array: 'ARRAY',
    };

    const result: any = {};
    const schemaType = schema.type;
    result.type = typeMap[schemaType] || 'STRING';

    if (schema.description) result.description = schema.description;
    if (schema.enum) result.enum = schema.enum;

    if (schemaType === 'object' && schema.properties) {
      result.properties = {};
      for (const [key, val] of Object.entries(schema.properties)) {
        result.properties[key] = this.convertSchema(val);
      }
      if (schema.required?.length > 0) {
        result.required = schema.required;
      }
    }

    if (schemaType === 'array' && schema.items) {
      result.items = this.convertSchema(schema.items);
    }

    return result;
  }

  /** Call Gemini API with tool support. Returns text and/or function calls. */
  async generateContent(
    systemInstruction: string,
    contents: GeminiMessage[],
    functionDeclarations: GeminiFunctionDeclaration[],
    thinkingBudget?: number,
  ): Promise<GeminiCallResult> {
    if (!this.ai) throw new Error('Gemini client not initialized');

    const config: any = {
      systemInstruction,
      temperature: MODEL_TEMPERATURE,
    };

    if (functionDeclarations.length > 0) {
      config.tools = [{ functionDeclarations }];
    }

    // Enable thinking for complex operations
    if (thinkingBudget && thinkingBudget > 0) {
      config.thinkingConfig = {
        thinkingBudget,
      };
    }

    const response = await this.ai.models.generateContent({
      model: AI_MODEL,
      contents: contents as any,
      config,
    });

    // Extract text
    let text: string | null = null;
    const textPart = response.candidates?.[0]?.content?.parts?.find((p: any) => p.text);
    if (textPart) text = (textPart as any).text;

    // Extract function calls
    let functionCalls: Array<{ name: string; args: any; raw: any; rawPart: any }> | null = null;
    const fcParts = response.candidates?.[0]?.content?.parts?.filter((p: any) => p.functionCall) || [];
    if (fcParts.length > 0) {
      functionCalls = fcParts.map((p: any) => ({
        name: p.functionCall.name,
        args: p.functionCall.args || {},
        // Preserve the full functionCall payload (including thought_signature).
        raw: p.functionCall,
        // Preserve the entire part because thought signature can be at part level.
        rawPart: p,
      }));
    }

    const finishReason = response.candidates?.[0]?.finishReason || 'STOP';

    return {
      text,
      functionCalls,
      finishReason,
      usageMetadata: response.usageMetadata,
    };
  }
}
