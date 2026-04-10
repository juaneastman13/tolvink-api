// =====================================================================
// TOLVINK — Error handling utilities (shared across modules)
// =====================================================================

/** Redact sensitive fragments before logging external/provider errors. */
export function sanitizeErrorForLog(input: unknown): string {
  let msg = String(input ?? '');
  msg = msg.replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_API_KEY]');
  msg = msg.replace(/sk-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED_OPENAI_KEY]');
  msg = msg.replace(/(api[_-]?key['"\s:=]+)([^\s'",}]+)/gi, '$1[REDACTED]');
  msg = msg.replace(/(Bearer\s+)[A-Za-z0-9\-._~+/=]+/gi, '$1[REDACTED]');
  msg = msg.replace(/("?(?:access|refresh|id)?_?token"?\s*[:=]\s*"?)([^"\s,}]+)/gi, '$1[REDACTED]');
  msg = msg.replace(/(authorization["'\s:=]+)([^\s'",}]+)/gi, '$1[REDACTED]');
  return msg;
}

/** Coarse error categorization for logs/observability. */
export function classifyAiError(errLike: unknown): 'provider_suspended' | 'provider_unavailable' | 'rate_limited' | 'forbidden' | 'timeout' | 'unknown' {
  const msg = String((errLike as any)?.message || errLike || '').toLowerCase();
  if (msg.includes('consumer_suspended') || msg.includes('has been suspended') || msg.includes('insufficient_quota') || msg.includes('billing')) return 'provider_suspended';
  if (msg.includes('unavailable') || msg.includes('high demand') || msg.includes('503') || msg.includes('server_error') || msg.includes('500')) return 'provider_unavailable';
  if (msg.includes('rate limit') || msg.includes('429') || msg.includes('quota')) return 'rate_limited';
  if (msg.includes('permission_denied') || msg.includes('forbidden') || msg.includes('403')) return 'forbidden';
  if (msg.includes('timeout') || msg.includes('timed out')) return 'timeout';
  return 'unknown';
}
