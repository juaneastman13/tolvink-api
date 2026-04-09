// =====================================================================
// TOLVINK — AI Service Constants (Claude Sonnet)
// =====================================================================

export const AI_MODEL = 'claude-sonnet-4-20250514';
export const MAX_TOOL_ITERATIONS = 15;
export const TOOL_TIMEOUT_MS = 120_000;
export const MAX_HISTORY_MESSAGES = 40;
export const SESSION_TIMEOUT_MS = 60 * 60 * 1000; // 60 min
export const RATE_LIMIT_MESSAGES = 20;
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const MAX_RESPONSE_CHARS = 1600; // WhatsApp
export const WEB_MAX_RESPONSE_CHARS = 3000;
export const MODEL_TEMPERATURE = 0.3;
export const MAX_OUTPUT_TOKENS = 2048;
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
export const STALE_SESSION_MIN = 15;

if (!process.env.FRONTEND_URL) console.warn('[Tolvink] FRONTEND_URL not set — using tolvink.com fallback');
export const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';

export const URUGUAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000; // UTC-3

// Shared freight status labels
export const FREIGHT_STATUS_LABELS: Record<string, string> = {
  pending_assignment: 'Pend. asignacion', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};
export const FREIGHT_STATUS_SHORT: Record<string, string> = {
  pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};

// Audio filler words common in River Plate Spanish voice transcriptions
export const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|o sea|digamos|viste)\b[,.]?\s*/gi;
