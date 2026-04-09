// =====================================================================
// TOLVINK — Thinking level selection for Gemini 2.5 Pro
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
  aiMessagesCount?: number,
  hasActiveContext?: boolean,
): ThinkingConfig {
  // Active flow (freight creation, pending actions, active freight in context)
  if (hasActiveFlow) {
    return { budget: 4096 };
  }

  // If there's conversation history (>= 2 AI messages), the user might be
  // answering a question from the previous turn. Never give 0 budget — the
  // model needs to reason about what the previous question was.
  if (aiMessagesCount && aiMessagesCount >= 2) {
    if (SIMPLE_PATTERNS.some(p => p.test(message))) {
      return { budget: 1024 };
    }
  }

  // Active context (freight or filter) — give minimum thinking
  if (hasActiveContext) {
    return { budget: 2048 };
  }

  // Simple confirmations/greetings without history = no thinking
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
