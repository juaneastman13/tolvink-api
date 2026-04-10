// =====================================================================
// TOLVINK — Per-user rate limiter (in-memory)
// =====================================================================

const WINDOW_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 20;
const limits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = limits.get(userId);
  if (!entry || now > entry.resetAt) {
    limits.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }
  entry.count++;
  return entry.count > MAX_MESSAGES;
}

export function cleanupRateLimits(): void {
  const now = Date.now();
  for (const [k, v] of limits) {
    if (now > v.resetAt) limits.delete(k);
  }
  if (limits.size > 10_000) {
    const iter = limits.keys();
    while (limits.size > 8_000) {
      const k = iter.next().value;
      if (k) limits.delete(k); else break;
    }
  }
}
