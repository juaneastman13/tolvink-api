// =====================================================================
// TOLVINK — AI Constants
// =====================================================================

export const MAX_TOOL_ITERATIONS = 15;
export const TOOL_TIMEOUT_MS = 120_000;
export const WHATSAPP_TOOL_TIMEOUT_MS = 25_000;
export const MAX_HISTORY_MESSAGES = 40;
export const SESSION_TIMEOUT_MS = 60 * 60 * 1000;
export const MAX_RESPONSE_CHARS = 1600;
export const WEB_MAX_RESPONSE_CHARS = 3000;
export const PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;
export const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';
export const URUGUAY_UTC_OFFSET_MS = -3 * 60 * 60 * 1000;

export const FREIGHT_STATUS_SHORT: Record<string, string> = {
  pending_assignment: 'Pend. asig.', assigned: 'Asignado', accepted: 'Aceptado',
  in_progress: 'A campo', loaded: 'A planta', finished: 'Finalizado',
  canceled: 'Cancelado',
};
