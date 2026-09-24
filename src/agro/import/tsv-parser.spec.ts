import { normalizeFecha, normalizeNumber, num, parseTsv, requireNum } from './tsv-parser';

describe('import/tsv-parser', () => {
  it('parsea TSV con headers', () => {
    const rows = parseTsv('fecha\tcabezas\tmonto\n15/03/2025\t100\t1.234,56\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw).toEqual({
      fecha: '15/03/2025',
      cabezas: '100',
      monto: '1.234,56',
    });
  });

  it('acepta ; como separador cuando no hay tabs', () => {
    const rows = parseTsv('fecha;cabezas\n15/03/2025;100\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].raw.cabezas).toBe('100');
  });

  it('respeta comillas dobles envolventes', () => {
    const rows = parseTsv('detalle\tmonto\n"Compra, urgente"\t100\n');
    expect(rows[0].raw.detalle).toBe('Compra, urgente');
  });

  it('normalizeNumber convierte formato UY', () => {
    expect(normalizeNumber('1.234,56')).toBe('1234.56');
    expect(normalizeNumber('100')).toBe('100');
    expect(normalizeNumber('')).toBe('');
  });

  it('normalizeFecha convierte dd/mm/yyyy', () => {
    expect(normalizeFecha('15/03/2025')).toBe('2025-03-15');
    expect(normalizeFecha('2025-03-15')).toBe('2025-03-15');
    expect(normalizeFecha('')).toBeNull();
  });

  it('num devuelve null en celdas vacías', () => {
    expect(num('')).toBeNull();
    expect(num('  ')).toBeNull();
    expect(num('12,5')).toBe(12.5);
  });

  it('requireNum tira si es inválido', () => {
    expect(() => requireNum('abc', 'kg')).toThrow();
  });

  it('salta líneas vacías', () => {
    const rows = parseTsv('a\tb\n1\t2\n\n3\t4\n');
    expect(rows).toHaveLength(2);
  });
});
