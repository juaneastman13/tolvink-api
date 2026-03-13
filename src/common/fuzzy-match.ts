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

// ======================== ENTITY ALIASES =============================

/** P2-5: Common abbreviations and alternate names for Uruguayan ag entities */
export const ENTITY_ALIASES: Map<string, string[]> = new Map([
  // Cooperatives / major plants
  ['COPAGRAN', ['copagran', 'copagra']],
  ['CONAPROLE', ['conaprole', 'conprole', 'conapro']],
  ['CALMER', ['calmer']],
  ['CARGILL', ['cargill', 'cargil', 'kargill']],
  ['BARRACA ERRO', ['erro', 'barraca erro']],
  ['AGRONEGOCIOS DEL PLATA', ['adp', 'agronegocios']],
  ['CEREOIL', ['cereoil', 'cereol']],
  ['ISUSA', ['isusa']],
  ['SPEADEX', ['speadex', 'spedex']],
  // Locations
  ['Nueva Palmira', ['palmira', 'nueva palmira', 'n palmira']],
  ['Nueva Helvecia', ['helvecia', 'nueva helvecia', 'n helvecia']],
  ['Young', ['young', 'yung']],
  ['Paysandú', ['paysandu', 'paysandú']],
  ['Mercedes', ['mercedes']],
  ['Dolores', ['dolores']],
  ['Fray Bentos', ['fray bentos', 'fbentos']],
]);

// ======================== TEXT NORMALIZATION ==========================

const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'un', 'una', 'unos', 'unas',
  'al', 'en', 'y', 'o', 'a', 'por',
]);

/** Business suffixes stripped during normalization */
const BUSINESS_SUFFIXES = ['s.a.', 's.r.l.', 'ltda', 'ltda.', 'sa', 'srl'];

/**
 * Normalize text for River Plate Spanish phonetic comparison.
 * Strips accents, applies seseo/yeísmo/b-v merging, removes stop words and business suffixes.
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

  // Remove business suffixes before phonetic normalization
  for (const suffix of BUSINESS_SUFFIXES) {
    if (t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length).trim();
    }
    // Also handle with leading space and dots
    t = t.replace(new RegExp('\\b' + suffix.replace(/\./g, '\\.?') + '\\b', 'g'), '').trim();
  }
  // Remove trailing dots/commas after suffix removal
  t = t.replace(/[.,]+$/, '').trim();

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

/** Split normalized text into tokens (words) */
export function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized.split(/\s+/).filter(Boolean);
}

/**
 * Token-based matching: checks how many query tokens match candidate tokens.
 * For tokens ≥5 chars, allows Levenshtein distance ≤1 (typo tolerance).
 * For tokens 3-4 chars, requires exact match after normalization.
 * Returns a composite score 0-1.
 */
export function tokenMatchScore(query: string, candidate: string): number {
  const queryTokens = tokenize(query);
  const candidateTokens = tokenize(candidate);
  if (queryTokens.length === 0 || candidateTokens.length === 0) return 0;

  let matchedQueryTokens = 0;
  const usedCandidateIndexes = new Set<number>();

  for (const qt of queryTokens) {
    let bestMatch = -1;
    let bestDist = Infinity;

    for (let ci = 0; ci < candidateTokens.length; ci++) {
      if (usedCandidateIndexes.has(ci)) continue;
      const ct = candidateTokens[ci];

      // Exact match
      if (qt === ct) {
        bestMatch = ci;
        bestDist = 0;
        break;
      }

      // Substring match: query token is start of candidate token or vice-versa
      if (ct.startsWith(qt) || qt.startsWith(ct)) {
        const dist = Math.abs(ct.length - qt.length);
        if (dist < bestDist) {
          bestMatch = ci;
          bestDist = dist <= 2 ? 0 : dist;
        }
        continue;
      }

      // Typo tolerance for longer tokens (≥5 chars)
      if (qt.length >= 5 || ct.length >= 5) {
        const dist = levenshteinDistance(qt, ct);
        if (dist <= 1 && dist < bestDist) {
          bestMatch = ci;
          bestDist = dist;
        }
      } else if (qt.length >= 3 && ct.length >= 3) {
        // For 3-4 char tokens, only allow distance 0 (already handled above)
        const dist = levenshteinDistance(qt, ct);
        if (dist === 0 && dist < bestDist) {
          bestMatch = ci;
          bestDist = dist;
        }
      }
    }

    if (bestMatch >= 0 && bestDist <= 1) {
      matchedQueryTokens++;
      usedCandidateIndexes.add(bestMatch);
    }
  }

  if (matchedQueryTokens === 0) return 0;

  // (a) % of query tokens that matched
  const queryRatio = matchedQueryTokens / queryTokens.length;
  // (b) % of candidate tokens that were matched
  const candidateRatio = usedCandidateIndexes.size / candidateTokens.length;
  // (c) Order bonus: check if matched tokens appear in the same relative order
  const matchedIndexes = Array.from(usedCandidateIndexes).sort((a, b) => a - b);
  let orderBonus = 0;
  if (matchedIndexes.length >= 2) {
    let inOrder = true;
    for (let i = 1; i < matchedIndexes.length; i++) {
      if (matchedIndexes[i] <= matchedIndexes[i - 1]) {
        inOrder = false;
        break;
      }
    }
    orderBonus = inOrder ? 0.05 : 0;
  }

  // Composite: heavily weight query coverage, lighter weight on candidate coverage
  const score = queryRatio * 0.65 + candidateRatio * 0.30 + orderBonus;
  return Math.min(score, 1.0);
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

  // Multi-strategy matching: Levenshtein, token-based, and substring
  const results: FuzzyResult<T>[] = [];
  for (const item of items) {
    const label = getLabel(item);
    const normalizedLabel = normalizeText(label);

    // Strategy 1: Whole-string Levenshtein similarity
    const levScore = similarityScore(query, label);

    // Strategy 2: Token-based matching (handles partial name queries)
    const tokScore = tokenMatchScore(query, label);

    // Strategy 3: Substring boost
    let subScore = 0;
    if (normalizedLabel.includes(normalizedQuery) || normalizedQuery.includes(normalizedLabel)) {
      const ratio = Math.min(normalizedQuery.length, normalizedLabel.length) /
        Math.max(normalizedQuery.length, normalizedLabel.length);
      subScore = Math.max(ratio, 0.80);
    }

    // Take the best score across all strategies
    const score = Math.max(levScore, tokScore, subScore);

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
