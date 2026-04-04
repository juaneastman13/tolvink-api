// =====================================================================
// TOLVINK — Thinking level selection for Gemini 2.5 Flash
// Determines thinking budget based on message complexity
// =====================================================================

/** Complex patterns that benefit from more thinking tokens. */
const COMPLEX_PATTERNS = [
  /\bcrear?\s+flete/i, /\bprepare_freight/i, /\bmandar?\s+\w+\s/i,
  /\basignar?\s/i, /\btransportista/i, /\bflota\s+propia/i,
  /\bexterno/i, /\bdelegad/i, /\bcancelar?\s+flete/i,
  /\bduplicar?\s/i, /\bmúltiples?\s+camion/i,
];

/** Simple patterns that need minimal thinking. */
const SIMPLE_PATTERNS = [
  /^(hola|buenas?|buen\s+d[ií]a|che)\b/i,
  /^(s[ií]|no|dale|va|ok|listo|confirm[ao]|cancel[ao])\b/i,
  /\b(qu[eé]\s+es|c[oó]mo\s+est[aá]|estado)\b/i,
  /^[1-9]$/,
];

export interface ThinkingConfig {
  budget: number;  // 0 = no thinking, 1024-24576 for varying complexity
}

/** Select thinking budget based on message content and session state. */
export function selectThinkingLevel(
  message: string,
  hasActiveFlow?: boolean,
): ThinkingConfig {
  // Active flow (freight creation, pending actions) benefits from thinking
  if (hasActiveFlow) {
    return { budget: 4096 };
  }

  // Simple confirmations/greetings need no thinking
  if (SIMPLE_PATTERNS.some(p => p.test(message))) {
    return { budget: 0 };
  }

  // Complex operations benefit from thinking
  if (COMPLEX_PATTERNS.some(p => p.test(message))) {
    return { budget: 8192 };
  }

  // Default: light thinking
  return { budget: 1024 };
}
