// =====================================================================
// TOLVINK — Fuzzy Matching for post-Whisper audio transcriptions
// Handles River Plate Spanish phonetic variations (seseo, yeísmo, b/v)
// =====================================================================

// ======================== GRAIN ALIASES ==============================

/** Known audio transcription variants for grain types */
export const GRAIN_ALIASES: Map<string, string[]> = new Map([
  ['Soja', ['soja', 'solla', 'soya', 'soia']],
  ['Maiz', ['maiz', 'mais', 'choclo']],
  ['Trigo', ['trigo', 'trigp']],
  ['Girasol', ['girasol', 'jirasol']],
  ['Sorgo', ['sorgo']],
  ['Cebada', ['cebada', 'sebada', 'sevada']],
  ['Otros', ['otros', 'otro']],
]);

// ======================== TEXT NORMALIZATION ==========================

const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'unos', 'unas',
  'al', 'en', 'y', 'o', 'a', 'por',
]);

/**
 * Normalize text for River Plate Spanish phonetic comparison.
 * Strips accents, applies seseo/yeísmo/b-v merging, removes stop words.
 */
export function normalizeText(text: string): string {
  let t = text
    .toLowerCase()
    // Strip accents (NFD decompose + remove combining diacriticals)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // River Plate phonetic equivalences
  t = t
    // b/v → b
    .replace(/v/g, 'b')
    // seseo: ce/ci → se/si, z → s
    .replace(/c([ei])/g, 's$1')
    .replace(/z/g, 's')
    // yeísmo: ll → y
    .replace(/ll/g, 'y')
    // silent h
    .replace(/h/g, '')
    // gue/gui → ge/gi
    .replace(/gu([ei])/g, 'g$1')
    // qu → k
    .replace(/qu/g, 'k')
    // x → ks
    .replace(/x/g, 'ks');

  // Remove stop words (only whole words)
  t = t
    .split(' ')
    .filter((w) => !STOP_WORDS.has(w))
    .join(' ')
    .trim();

  return t;
}

// ======================== LEVENSHTEIN DISTANCE =======================

/**
 * Standard Levenshtein distance with single-row optimization.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Ensure a is the shorter string for memory optimization
  if (a.length > b.length) [a, b] = [b, a];

  const aLen = a.length;
  const bLen = b.length;
  let prev = new Array(aLen + 1);
  let curr = new Array(aLen + 1);

  for (let i = 0; i <= aLen; i++) prev[i] = i;

  for (let j = 1; j <= bLen; j++) {
    curr[0] = j;
    for (let i = 1; i <= aLen; i++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[i] = Math.min(
        prev[i] + 1,      // deletion
        curr[i - 1] + 1,  // insertion
        prev[i - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  return prev[aLen];
}

// ======================== SIMILARITY SCORE ===========================

/**
 * Returns 0-1 similarity based on normalized Levenshtein distance.
 * Applies phonetic normalization before comparison.
 */
export function similarityScore(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(na, nb) / maxLen;
}

// ======================== FUZZY SEARCH ===============================

export interface FuzzyResult<T> {
  item: T;
  score: number;
  matchedLabel: string;
}

export interface FuzzyOptions {
  threshold?: number;                    // minimum score to include (default: 0.55)
  maxResults?: number;                   // default: 5
  aliases?: Map<string, string[]>;       // canonical → [variants]
}

/**
 * Search items by fuzzy name matching.
 * Checks aliases first for exact match, then Levenshtein similarity.
 */
export function fuzzySearch<T>(
  query: string,
  items: T[],
  getLabel: (item: T) => string,
  options?: FuzzyOptions,
): FuzzyResult<T>[] {
  const threshold = options?.threshold ?? 0.55;
  const maxResults = options?.maxResults ?? 5;
  const aliases = options?.aliases;

  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  // Check aliases first: if query matches a known variant, boost that item
  if (aliases) {
    for (const [canonical, variants] of aliases) {
      const normalizedVariants = variants.map((v) => normalizeText(v));
      if (normalizedVariants.includes(normalizedQuery)) {
        // Find the item matching this canonical name
        const matched = items.find(
          (item) => normalizeText(getLabel(item)) === normalizeText(canonical),
        );
        if (matched) {
          return [{ item: matched, score: 1.0, matchedLabel: getLabel(matched) }];
        }
      }
    }
  }

  // Levenshtein + substring matching
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const label = getLabel(item);
    const normalizedLabel = normalizeText(label);
    let score = similarityScore(query, label);

    // Substring boost: if query is contained in label or label in query, boost score
    if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) {
      const subScore = Math.min(normalizedQuery.length, normalizedLabel.length) /
        Math.max(normalizedQuery.length, normalizedLabel.length);
      // Use the better of Levenshtein score or substring-based score (min 0.80)
      score = Math.max(score, Math.max(subScore, 0.80));
    }

    if (score >= threshold) {
      results.push({ item, score, matchedLabel: label });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
}

// ======================== RESULT CLASSIFICATION ======================

export type FuzzyClassification = 'exact' | 'confident' | 'ambiguous' | 'none';

/**
 * Classify fuzzy search results for UX decisions:
 * - exact: top result ≥ 0.95 → auto-accept
 * - confident: top ≥ 0.85 with clear gap over second → auto-accept
 * - ambiguous: top ≥ 0.70 but no clear winner → ask user
 * - none: no good match → reject
 */
export function classifyFuzzyResult<T>(
  results: FuzzyResult<T>[],
): FuzzyClassification {
  if (results.length === 0) return 'none';

  const top = results[0].score;
  const second = results.length > 1 ? results[1].score : 0;

  if (top >= 0.95) return 'exact';
  if (top >= 0.85 && top - second > 0.15) return 'confident';
  if (top >= 0.70) return 'ambiguous';
  return 'none';
}
