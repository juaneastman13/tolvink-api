import {
  normalizeText,
  tokenize,
  levenshteinDistance,
  similarityScore,
  tokenMatchScore,
  fuzzySearch,
  classifyFuzzyResult,
  FuzzyResult,
  GRAIN_ALIASES,
  ENTITY_ALIASES,
} from '../fuzzy-match';

// ======================== normalizeText ============================

describe('normalizeText', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeText('Paysandú')).toBe('paysandu');
  });

  it('applies seseo: c(e/i) → s, z → s', () => {
    expect(normalizeText('Cebada')).toBe('sebada');
    expect(normalizeText('maíz')).toBe('mais');
  });

  it('applies yeísmo: ll → y', () => {
    expect(normalizeText('solla')).toBe('soya');
  });

  it('merges b/v', () => {
    expect(normalizeText('sevada')).toBe('sebada');
  });

  it('removes silent h', () => {
    expect(normalizeText('helvecia')).toBe('elbesia'); // h removed, v→b, c(e)→s(e), i→i, a→a
  });

  it('removes stop words', () => {
    const result = normalizeText('Planta de la Cooperativa');
    expect(result).not.toContain(' de ');
    expect(result).not.toContain(' la ');
  });

  it('strips business suffixes', () => {
    expect(normalizeText('Young S.A.')).toBe('young'); // phonetic: y stays, ou stays, ng stays
  });

  it('strips s.r.l. suffix', () => {
    const result = normalizeText('Empresa S.R.L.');
    expect(result).not.toContain('srl');
    expect(result).not.toContain('s.r.l');
  });
});

// ======================== tokenize =================================

describe('tokenize', () => {
  it('splits normalized text into tokens', () => {
    const tokens = tokenize('Planta Acopiadora Young S.A.');
    expect(tokens).toContain('planta');
    expect(tokens).toContain('acopiadora'); // 'c' before 'o' is NOT affected by seseo (only c before e/i)
    expect(tokens).toContain('young');
  });

  it('returns empty array for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });
});

// ======================== levenshteinDistance =======================

describe('levenshteinDistance', () => {
  it('returns 0 for identical strings', () => {
    expect(levenshteinDistance('abc', 'abc')).toBe(0);
  });

  it('returns length for empty vs non-empty', () => {
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
  });

  it('handles single substitution', () => {
    expect(levenshteinDistance('kitten', 'sitten')).toBe(1);
  });

  it('handles insertion/deletion', () => {
    expect(levenshteinDistance('young', 'yung')).toBe(1);
  });
});

// ======================== tokenMatchScore ==========================

describe('tokenMatchScore', () => {
  it('returns high score when query tokens match subset of candidate', () => {
    const score = tokenMatchScore('young', 'Planta Acopiadora Young S.A.');
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it('returns high score for multi-token partial match', () => {
    const score = tokenMatchScore('planta de young', 'Planta Acopiadora Young S.A.');
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it('handles typo tolerance for longer tokens', () => {
    // "yung" vs "young" — after normalization both are short, but test the mechanism
    const score = tokenMatchScore('cooperatiba', 'Cooperativa Agraria Nacional');
    expect(score).toBeGreaterThanOrEqual(0.5);
  });

  it('returns 0 for completely unrelated strings', () => {
    const score = tokenMatchScore('helado', 'Planta Acopiadora Young S.A.');
    expect(score).toBe(0);
  });

  it('returns 0 for empty input', () => {
    expect(tokenMatchScore('', 'something')).toBe(0);
    expect(tokenMatchScore('something', '')).toBe(0);
  });
});

// ======================== fuzzySearch ==============================

describe('fuzzySearch', () => {
  const plants = [
    { id: 1, name: 'Planta Acopiadora Young S.A.' },
    { id: 2, name: 'Cooperativa Agraria Nacional' },
    { id: 3, name: 'Palmira S.A.' },
    { id: 4, name: 'COPAGRAN Mercedes' },
    { id: 5, name: 'Young' },
  ];
  const getLabel = (p: { name: string }) => p.name;

  it('"planta de young" → matches Planta Acopiadora Young', () => {
    const results = fuzzySearch('planta de young', plants, getLabel);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.name).toContain('Young');
  });

  it('"young" → matches Young or Planta Acopiadora Young', () => {
    const results = fuzzySearch('young', plants, getLabel);
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.item.name);
    expect(names.some((n) => n.includes('Young'))).toBe(true);
  });

  it('"cooperativa agro" → matches Cooperativa Agraria Nacional', () => {
    const results = fuzzySearch('cooperativa agro', plants, getLabel);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item.name).toContain('Cooperativa');
  });

  it('"yung" → matches Young via alias or typo tolerance', () => {
    const results = fuzzySearch('yung', plants, getLabel, {
      aliases: ENTITY_ALIASES,
      threshold: 0.45,
    });
    expect(results.length).toBeGreaterThan(0);
    const names = results.map((r) => r.item.name);
    expect(names.some((n) => n.includes('Young'))).toBe(true);
  });

  it('alias match returns score 1.0', () => {
    const grains = [
      { id: 1, name: 'Soja' },
      { id: 2, name: 'Maiz' },
    ];
    const results = fuzzySearch('soya', grains, (g) => g.name, {
      aliases: GRAIN_ALIASES,
    });
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(1.0);
    expect(results[0].item.name).toBe('Soja');
  });

  it('respects maxResults', () => {
    const results = fuzzySearch('planta', plants, getLabel, { maxResults: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty for no match', () => {
    const results = fuzzySearch('xyznotexist', plants, getLabel);
    expect(results).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const results = fuzzySearch('', plants, getLabel);
    expect(results).toEqual([]);
  });
});

// ======================== classifyFuzzyResult ======================

describe('classifyFuzzyResult', () => {
  it('returns "none" for empty results', () => {
    expect(classifyFuzzyResult([])).toBe('none');
  });

  it('returns "exact" for score >= 0.95', () => {
    const results: FuzzyResult<string>[] = [
      { item: 'a', score: 0.98, matchedLabel: 'a' },
    ];
    expect(classifyFuzzyResult(results)).toBe('exact');
  });

  it('returns "confident" for top >= 0.85 with clear gap', () => {
    const results: FuzzyResult<string>[] = [
      { item: 'a', score: 0.90, matchedLabel: 'a' },
      { item: 'b', score: 0.60, matchedLabel: 'b' },
    ];
    expect(classifyFuzzyResult(results)).toBe('confident');
  });

  it('returns "ambiguous" for top >= 0.70 without clear gap', () => {
    const results: FuzzyResult<string>[] = [
      { item: 'a', score: 0.80, matchedLabel: 'a' },
      { item: 'b', score: 0.78, matchedLabel: 'b' },
    ];
    expect(classifyFuzzyResult(results)).toBe('ambiguous');
  });

  it('returns "none" for all scores below 0.70', () => {
    const results: FuzzyResult<string>[] = [
      { item: 'a', score: 0.50, matchedLabel: 'a' },
    ];
    expect(classifyFuzzyResult(results)).toBe('none');
  });
});
