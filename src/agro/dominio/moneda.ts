import { Decimal } from '@prisma/client/runtime/library';

/**
 * Conversión de importes a USD.
 *
 * Regla dura: se persisten los tres valores (monto original, moneda, tipoCambio, montoUsd)
 * para que la lectura no dependa de la serie histórica.
 *
 * `tipoCambio` = UYU por USD (ej. 40).
 */

export type Moneda = 'USD' | 'UYU';

export function aUsd(monto: Decimal | number, moneda: Moneda, tipoCambio: Decimal | number): Decimal {
  const m = monto instanceof Decimal ? monto : new Decimal(monto);
  if (moneda === 'USD') return m;
  const tc = tipoCambio instanceof Decimal ? tipoCambio : new Decimal(tipoCambio);
  if (tc.lte(0)) {
    throw new RangeError('tipoCambio debe ser > 0 para convertir UYU→USD');
  }
  // 2 decimales de precisión para importes finales.
  return m.div(tc).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * Devuelve la terna canónica { moneda, tipoCambio, montoUsd } lista para persistir.
 */
export function normalizarImporte(
  monto: Decimal | number,
  moneda: Moneda,
  tipoCambio: Decimal | number,
): { monto: Decimal; moneda: Moneda; tipoCambio: Decimal; montoUsd: Decimal } {
  const m = monto instanceof Decimal ? monto : new Decimal(monto);
  const tc = tipoCambio instanceof Decimal ? tipoCambio : new Decimal(tipoCambio);
  return {
    monto: m,
    moneda,
    tipoCambio: tc,
    montoUsd: aUsd(m, moneda, tc),
  };
}
