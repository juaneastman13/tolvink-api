/**
 * §5.2 — Transferencia interna de grano propio al feedlot.
 *
 * El grano que Agricultura entrega al Feedlot se contabiliza a
 * **valor neto en campo**: precio de referencia (pizarra) menos flete y
 * gastos de comercialización. No se usa el precio bruto.
 *
 * Efectos:
 *   - Agricultura acredita un ingreso por este importe.
 *   - Feedlot debita un costo por el mismo importe.
 *   - Ambos por la misma cifra: el efecto sobre el resultado de empresa
 *     es cero, pero cada centro queda con su cifra real.
 *
 * Sin esta regla:
 *   - Agricultura pierde el ingreso (grano se "regala" al feedlot).
 *   - Feedlot queda con un costo artificialmente bajo → parece más rentable
 *     de lo que es.
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface ValoracionGranoFeedlot {
  toneladas: Decimal | number;
  /** Precio de referencia (pizarra) USD/t. */
  precioReferenciaUsdT: Decimal | number;
  /** Flete USD/t (si aplica). */
  fleteUsdT?: Decimal | number;
  /** Comisión/gastos de venta USD/t (si aplica). */
  comisionUsdT?: Decimal | number;
}

export interface AsientoTransferenciaGrano {
  /** USD/t neto en campo (precio efectivo del movimiento). */
  precioNetoUsdT: Decimal;
  /** Importe total USD (= toneladas × precioNetoUsdT). */
  importeUsd: Decimal;
  /** Ingreso a acreditar al centro AGR. */
  ingresoAgricultura: Decimal;
  /** Costo a debitar al centro FEED. */
  costoFeedlot: Decimal;
}

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

/**
 * Calcula la valoración y el asiento gemelo (ingreso agri = costo feedlot)
 * para una transferencia interna de grano al feedlot.
 *
 * Redondeo: 4 decimales en USD/t (precisión de precio), 2 decimales en el
 * importe final.
 */
export function calcularAsientoFeedlot(v: ValoracionGranoFeedlot): AsientoTransferenciaGrano {
  const ton = toDec(v.toneladas);
  const bruto = toDec(v.precioReferenciaUsdT);
  const flete = toDec(v.fleteUsdT);
  const comision = toDec(v.comisionUsdT);

  if (ton.lte(0)) throw new RangeError('toneladas debe ser > 0');
  if (bruto.lte(0)) throw new RangeError('precioReferenciaUsdT debe ser > 0');

  const neto = bruto.minus(flete).minus(comision);
  if (neto.lte(0)) {
    throw new RangeError(
      `Precio neto en campo no puede ser ≤ 0 (bruto ${bruto} − flete ${flete} − comisión ${comision})`,
    );
  }
  const netoR = neto.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
  const importe = ton.mul(netoR).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  return {
    precioNetoUsdT: netoR,
    importeUsd: importe,
    ingresoAgricultura: importe,
    costoFeedlot: importe,
  };
}
