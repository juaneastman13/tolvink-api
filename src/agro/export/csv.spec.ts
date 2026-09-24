import { toCsv } from './csv';

describe('export/csv', () => {
  it('genera header + BOM + separador ; + CRLF', () => {
    const csv = toCsv([{ fecha: '2025-04-01', monto: 100 }]);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines[0]).toBe('fecha;monto');
    expect(lines[1]).toBe('2025-04-01;100');
  });

  it('escapa comillas y separadores', () => {
    const csv = toCsv([{ detalle: 'Compra "urgente"; ver', monto: 100 }]);
    const line = csv.replace('﻿', '').split('\r\n')[1];
    expect(line).toBe('"Compra ""urgente""; ver";100');
  });

  it('vacío → sólo BOM', () => {
    expect(toCsv([])).toBe('﻿');
  });

  it('convierte decimal a coma UY', () => {
    const csv = toCsv([{ x: 12.5 }]);
    expect(csv.includes('12,5')).toBe(true);
  });
});
