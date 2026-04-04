// =====================================================================
// TOLVINK — Gemini Service Constants
// Google Gemini model configuration (Flash default, Pro fallback)
// =====================================================================

export const GEMINI_MODELS = {
  flash: 'gemini-2.5-flash',
  pro: 'gemini-2.5-pro',
} as const;
export type GeminiModelTier = keyof typeof GEMINI_MODELS;

// Token limits
export const GEMINI_FLASH_MAX_TOKENS = 2048;   // Was 1200, caused truncated responses
export const GEMINI_PRO_MAX_TOKENS = 4096;     // Pro fallback gets more room
export const GEMINI_TEMPERATURE = 0.4;         // Match Anthropic config

// Cost per million tokens (USD) — for logging/estimation
export const GEMINI_PRICING = {
  flash: { input: 0.30, output: 2.50, cachedInput: 0.075 },
  pro:   { input: 1.25, output: 10.0, cachedInput: 0.3125 },
} as const;
