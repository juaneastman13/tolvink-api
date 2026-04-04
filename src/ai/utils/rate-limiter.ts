// =====================================================================
// TOLVINK — Per-user AI rate limiter (in-memory)
// =====================================================================

import { RATE_LIMIT_MESSAGES, RATE_LIMIT_WINDOW_MS } from '../core/constants';

const rateMap = new Map<string, { count: number; resetAt: number }>();

/** Check rate limit; returns true if blocked. Increments counter on pass. */
export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateMap.get(userId);
  if (entry && now < entry.resetAt) {
    if (entry.count >= RATE_LIMIT_MESSAGES) return true;
    entry.count++;
    return false;
  }
  rateMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
  return false;
}

/** Periodic cleanup — call from a timer. */
export function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [k, v] of rateMap) {
    if (now > v.resetAt) rateMap.delete(k);
  }
  if (rateMap.size > 10_000) {
    const iter = rateMap.keys();
    while (rateMap.size > 8_000) {
      const k = iter.next().value;
      if (k) rateMap.delete(k); else break;
    }
  }
}
