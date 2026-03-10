// =====================================================================
// TOLVINK — AI Service Constants
// Shared configuration, status labels, and rate limiting parameters
// =====================================================================

export const MAX_HISTORY = 25;
export const MAX_TOOL_LOOPS = 3;
export const AI_SESSION_TIMEOUT_MIN = 30;
export const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';
export const OWN_FLEET_SHORTCUT = 'own_fleet';

// Model configuration — Claude Sonnet 4.6
// NOTE: Anthropic API supports temperature, top_p, top_k.
// It does NOT support presence_penalty / frequency_penalty (those are OpenAI-only).
// temperature 0.4  → better interpretation of ambiguous messages while keeping operational precision.
// max_tokens 1200  → enough room for context-aware responses + lists in Spanish.
export const MODEL_ID = 'claude-sonnet-4-6';
export const MODEL_TEMPERATURE = 0.4;
export const MODEL_MAX_TOKENS = 1200;
export const MAX_RESPONSE_CHARS = 3000;   // Hard cap before truncation (WhatsApp ~4096, chunking handles split)
export const STALE_SESSION_MIN = 10;      // Minutes gap that triggers context reminder
export const URUGUAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000; // UTC-3 (Uruguay has no DST)

// Shared freight status labels — single source of truth for Spanish translations
export const FREIGHT_STATUS_LABELS: Record<string, string> = {
  pending_assignment: 'Pend. asignación', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};
// Short version for list items (max ~12 chars)
export const FREIGHT_STATUS_SHORT: Record<string, string> = {
  pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'En viaje', loaded: 'Cargado', finished: 'Completado',
  canceled: 'Cancelado', rejected: 'Rechazado',
};

// Audio filler words common in River Plate Spanish voice transcriptions
export const AUDIO_FILLERS = /\b(eh+|ehmm*|emm*|mmm*|a+h+|o sea|digamos|viste)\b[,.]?\s*/gi;

// Per-user AI rate limiting: max 20 messages per 5 minutes
export const AI_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
export const AI_RATE_LIMIT_MAX = 20;
