// =====================================================================
// TOLVINK — Grain text normalizer
// Maps free-text grain names (Spanish) to system enum values
// =====================================================================

const GRAIN_MAP: Record<string, string> = {
  // Soja
  'soja': 'Soja',
  'soja 1ra': 'Soja',
  'soja primera': 'Soja',
  'soja 2da': 'Soja',
  'soja segunda': 'Soja',
  'soybean': 'Soja',

  // Maíz
  'maiz': 'Maíz',
  'maíz': 'Maíz',
  'corn': 'Maíz',
  'choclo': 'Maíz',

  // Trigo
  'trigo': 'Trigo',
  'wheat': 'Trigo',

  // Girasol
  'girasol': 'Girasol',
  'sunflower': 'Girasol',

  // Sorgo
  'sorgo': 'Sorgo',
  'sorghum': 'Sorgo',

  // Cebada
  'cebada': 'Cebada',
  'barley': 'Cebada',

  // Arroz
  'arroz': 'Otros',
  'rice': 'Otros',

  // Colza / Canola
  'colza': 'Otros',
  'canola': 'Otros',
};

/**
 * Normalize free-text grain name to system enum value.
 * Returns the normalized grain or the original text if no match found.
 */
export function normalizeGrain(input: string): { grain: string; normalized: boolean } {
  const clean = input.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents for matching
    .replace(/\s+/g, ' ');

  // Direct match
  if (GRAIN_MAP[clean]) {
    return { grain: GRAIN_MAP[clean], normalized: true };
  }

  // Try with accents preserved
  const withAccents = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (GRAIN_MAP[withAccents]) {
    return { grain: GRAIN_MAP[withAccents], normalized: true };
  }

  // Partial match: check if input starts with a known grain
  for (const [key, value] of Object.entries(GRAIN_MAP)) {
    if (clean.startsWith(key) || key.startsWith(clean)) {
      return { grain: value, normalized: true };
    }
  }

  // No match — return original text as-is
  return { grain: input.trim(), normalized: false };
}
