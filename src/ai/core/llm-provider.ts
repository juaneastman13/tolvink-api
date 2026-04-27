import type { AiToolDefinition } from '../tools/tool-definitions';

export type AiProviderName = 'gemini';

export const DEFAULT_AI_PROVIDER: AiProviderName = 'gemini';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_GEMINI_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_GEMINI_TEMPERATURE = 0.3;
export const DEFAULT_GEMINI_REQUEST_TIMEOUT_MS = 25_000;

export interface LlmMessage {
  role: 'user' | 'model';
  parts: any[];
}

export interface LlmResponse {
  text: string;
  functionCalls: Array<{ name: string; args: any }>;
  rawParts: any[];
  usageMetadata?: any;
  finishReason?: string;
  model?: string;
}

export interface ToolCallingLlmProvider {
  isEnabled(): boolean;
  convertTools(tools: AiToolDefinition[]): any[];
  convertHistory(messages: any[]): LlmMessage[];
  sendMessage(params: {
    system: string;
    messages: LlmMessage[];
    tools: any[];
  }): Promise<LlmResponse>;
}

export function getConfiguredAiProvider(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AI_PROVIDER || DEFAULT_AI_PROVIDER).trim().toLowerCase();
}

export function getGeminiModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL).trim();
}

export function getGeminiFallbackModel(env: NodeJS.ProcessEnv = process.env): string {
  return (env.GEMINI_FALLBACK_MODEL || DEFAULT_GEMINI_FALLBACK_MODEL).trim();
}

export function getGeminiMaxOutputTokens(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.GEMINI_MAX_OUTPUT_TOKENS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_GEMINI_MAX_OUTPUT_TOKENS;
}

export function getGeminiTemperature(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.GEMINI_TEMPERATURE);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_GEMINI_TEMPERATURE;
}

export function getGeminiRequestTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.GEMINI_REQUEST_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_GEMINI_REQUEST_TIMEOUT_MS;
}
