// =====================================================================
// TOLVINK — AI Service Constants
// Shared configuration, status labels, and rate limiting parameters
// =====================================================================

export const MAX_HISTORY = 15;  // Was 25; reduces token cost per turn, 15 covers 3 full tool loops
export const MAX_TOOL_LOOPS = 5;  // 5 loops needed: crear flete = search_plants + list_fields + list_lots + prepare_freight + confirm
export const AI_SESSION_TIMEOUT_MIN = 60;  // Was 30; field workers pause 45-60 min (lunch, travel)
if (!process.env.FRONTEND_URL) console.warn('[Tolvink] FRONTEND_URL not set — using tolvink.com fallback');
export const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';
export const OWN_FLEET_SHORTCUT = 'own_fleet';

// Model configuration — Haiku/Sonnet tiered routing
// Haiku: read-only queries, greetings, status. ~$1/$5 per MTok.
// Sonnet: freight creation, assignments, mutations. ~$3/$15 per MTok.
export const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
} as const;
export type ModelTier = keyof typeof MODELS;

// Legacy aliases (used by existing code)
export const MODEL_ID = MODELS.sonnet;
export const MODEL_ID_FAST = MODELS.haiku;
export const MODEL_TEMPERATURE = 0.4;
export const MODEL_MAX_TOKENS = 600;     // Avg Haiku response is 200-400t; 600 covers lists/summaries
export const HAIKU_MAX_TOKENS = 512;
export const SONNET_MAX_TOKENS = 4096;
export const MAX_RESPONSE_CHARS = 1600;   // WhatsApp fragments >~1600 chars; web uses WEB_MAX_RESPONSE_CHARS
export const WEB_MAX_RESPONSE_CHARS = 3000;
export const STALE_SESSION_MIN = 10;      // Minutes gap that triggers context reminder
export const URUGUAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000; // UTC-3 (Uruguay has no DST)

// Shared freight status labels — single source of truth for Spanish translations
export const FREIGHT_STATUS_LABELS: Record<string, string> = {
  pending_assignment: 'Pend. asignación', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};
// Short version for list items (max ~12 chars)
export const FREIGHT_STATUS_SHORT: Record<string, string> = {
  pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};

// Audio filler words common in River Plate Spanish voice transcriptions
export const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|o sea|digamos|viste)\b[,.]?\s*/gi;

// Per-user AI rate limiting: max 20 messages per 5 minutes
export const AI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const AI_RATE_LIMIT_MAX = 20;
