/**
 * Serializador CSV para exportar tablas al usuario (§9 del brief).
 *
 * Formato: UTF-8 con BOM (para que Excel lo abra sin romper acentos),
 * separador `;` (formato UY: Excel-en-español), comillas dobles envolventes
 * cuando el valor contiene `;` o `"` o salto de línea. Decimales con coma.
 * Fechas ISO `YYYY-MM-DD`.
 */

const BOM = '﻿';

function fmt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return String(v).replace('.', ',');
  const s = typeof v === 'object' ? String(v) : String(v);
  return s;
}

function escapeCell(v: unknown): string {
  const s = fmt(v);
  if (/[";\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convierte un array de filas homogéneo en un string CSV. Detecta las
 * columnas de la primera fila (mantiene el orden de sus keys).
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return BOM;
  const headers = Object.keys(rows[0]);
  const lines: string[] = [];
  lines.push(headers.map(escapeCell).join(';'));
  for (const r of rows) {
    lines.push(headers.map((h) => escapeCell(r[h])).join(';'));
  }
  return BOM + lines.join('\r\n') + '\r\n';
}
