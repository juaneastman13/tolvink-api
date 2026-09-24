/**
 * Parser de tablas TSV pegadas desde Excel/Google Sheets.
 *
 * Reglas:
 *   - Primera línea = headers (case-insensitive, trimmed).
 *   - Separador: tab. Si no hay tabs, se acepta `;` como alternativa (CSV UY).
 *   - Comillas dobles envolventes se remueven; `""` se colapsa a `"`.
 *   - Decimales con coma se traducen a punto ANTES de parsear números.
 *   - Fechas dd/mm/yyyy se normalizan a yyyy-mm-dd.
 *   - Celdas vacías → null.
 */

export interface ParsedRow {
  raw: Record<string, string>;
  /** Índice de la fila (empezando en 1 para la primera fila de datos). */
  lineNumber: number;
}

const TAB = '\t';
const CSV_SEP = ';';

function pickSeparator(sample: string): string {
  return sample.includes(TAB) ? TAB : CSV_SEP;
}

function splitLine(line: string, sep: string): string[] {
  // Parser simple con soporte de comillas dobles.
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === sep && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Parsea el texto pegado y devuelve las filas con headers normalizados
 * (lowercased + trimmed). Sin conversión de tipos: quien consume decide.
 */
export function parseTsv(text: string): ParsedRow[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const sep = pickSeparator(lines[0]);
  const headers = splitLine(lines[0], sep).map((h) => h.toLowerCase());
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i], sep);
    if (cols.every((c) => c === '')) continue; // línea vacía
    const raw: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      raw[headers[j]] = cols[j] ?? '';
    }
    rows.push({ raw, lineNumber: i });
  }
  return rows;
}

/** Convierte "12,5" → "12.5"; "1.234,56" → "1234.56". Deja vacío como ''. */
export function normalizeNumber(s: string | undefined): string {
  if (s === undefined || s === null) return '';
  const t = s.trim();
  if (t === '') return '';
  // Formato UY: miles con punto, decimales con coma. Formato EN: al revés.
  // Estrategia: si hay coma, se asume UY.
  if (t.includes(',')) {
    return t.replace(/\./g, '').replace(',', '.');
  }
  return t;
}

/** Convierte dd/mm/yyyy → yyyy-mm-dd. Deja ISO tal cual. Devuelve null si vacío. */
export function normalizeFecha(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return t;
}

export function num(s: string | undefined): number | null {
  const n = normalizeNumber(s);
  if (n === '') return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

export function requireNum(s: string | undefined, label: string): number {
  const v = num(s);
  if (v === null) throw new Error(`${label}: número inválido "${s}"`);
  return v;
}

export function nonEmpty(s: string | undefined, label: string): string {
  if (!s || !s.trim()) throw new Error(`${label} requerido`);
  return s.trim();
}
