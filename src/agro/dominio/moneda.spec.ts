import { Decimal } from '@prisma/client/runtime/library';
import { aUsd, normalizarImporte } from './moneda';

describe('dominio/moneda', () => {
  it('USD se mantiene tal cual', () => {
    expect(aUsd(100, 'USD', 40).toString()).toBe('100');
  });

  it('UYU convierte por tipo de cambio', () => {
    expect(aUsd(4000, 'UYU', 40).toString()).toBe('100');
  });

  it('redondea a 2 decimales banker rounding', () => {
    // 100 / 3 = 33.333... → 33.33
    expect(aUsd(100, 'UYU', 3).toString()).toBe('33.33');
  });

  it('rechaza tipo de cambio 0 o negativo cuando la moneda es UYU', () => {
    expect(() => aUsd(100, 'UYU', 0)).toThrow(RangeError);
    expect(() => aUsd(100, 'UYU', -1)).toThrow(RangeError);
  });

  it('normalizarImporte devuelve la terna canónica', () => {
    const n = normalizarImporte(new Decimal(4000), 'UYU', new Decimal(40));
    expect(n.moneda).toBe('UYU');
    expect(n.montoUsd.toString()).toBe('100');
    expect(n.tipoCambio.toString()).toBe('40');
  });
});
