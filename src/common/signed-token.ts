// =====================================================================
// TOLVINK — Signed Token Utility (HMAC-SHA256)
// Self-contained tokens for public page authentication (no DB storage)
// Format: base64url(payload).base64url(hmac)
// =====================================================================

import * as crypto from 'crypto';

export function createSignedToken(
  payload: Record<string, any>,
  secret: string,
  ttlMinutes: number,
): string {
  const data = { ...payload, exp: Date.now() + ttlMinutes * 60 * 1000 };
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export function verifySignedToken(
  token: string,
  secret: string,
): Record<string, any> | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx < 1) return null;

  const encoded = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  try {
    const data = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}
