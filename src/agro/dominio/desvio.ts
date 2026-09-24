/**
 * §6 — Desvíos presupuesto vs real, con descomposición precio/cantidad.
 *
 * Fórmula clásica (agronómica):
 *   Δtotal     = qR · pR − qP · pP
 *   Δprecio    = (pR − pP) · qR            (cuánto del desvío se explica por
 *                                            haber comprado/vendido a otro precio
 *                                            del que presupuestamos)
 *   Δcantidad  = (qR − qP) · pP            (cuánto se explica por haber movido
 *                                            más o menos cantidades)
 *   Δtotal    = Δprecio + Δcantidad        (identidad)
 *
 * En costos "más" es peor; en ingresos "más" es mejor. La función devuelve
 * el signo tal cual sale de la resta — el consumidor sabe el signo del
 * concepto por su tipo de cuenta.
 *
 * Umbrales de alerta (§4.1): un desvío se marca ⚠ si |Δtotal| supera
 * `desvioUsd` o `desvioPct` × |presupuestado|, ambos configurables.
 */

import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export interface DesvioInput {
  cantidadPresupuesto: Decimal | number;
  precioPresupuesto: Decimal | number;
  cantidadReal: Decimal | number;
  precioReal: Decimal | number;
}

export interface DesvioResult {
  presupuestadoUsd: Decimal;
  realUsd: Decimal;
  desvioTotalUsd: Decimal;
  desvioPrecioUsd: Decimal;
  desvioCantidadUsd: Decimal;
}

const round = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

export function calcularDesvio(inp: DesvioInput): DesvioResult {
  const qP = toDec(inp.cantidadPresupuesto);
  const pP = toDec(inp.precioPresupuesto);
  const qR = toDec(inp.cantidadReal);
  const pR = toDec(inp.precioReal);

  const presupuestado = qP.mul(pP);
  const real = qR.mul(pR);
  const total = real.minus(presupuestado);
  // Δprecio · qR + Δcantidad · pP = Δtotal (identidad).
  const dPrecio = pR.minus(pP).mul(qR);
  const dCantidad = qR.minus(qP).mul(pP);

  return {
    presupuestadoUsd: round(presupuestado),
    realUsd: round(real),
    desvioTotalUsd: round(total),
    desvioPrecioUsd: round(dPrecio),
    desvioCantidadUsd: round(dCantidad),
  };
}

export interface UmbralAlerta {
  desvioUsd: Decimal | number;
  /** 0..1, ej. 0.10 = 10%. */
  desvioPct: Decimal | number;
}

/**
 * True si el desvío total absoluto supera el umbral en USD o en % del
 * presupuestado. Cualquiera de los dos gatilla la alerta.
 */
export function pasaUmbral(r: DesvioResult, u: UmbralAlerta): boolean {
  const abs = r.desvioTotalUsd.abs();
  if (abs.gt(toDec(u.desvioUsd))) return true;
  const pctUmbral = toDec(u.desvioPct);
  if (r.presupuestadoUsd.eq(0)) return abs.gt(0);
  return abs.gt(r.presupuestadoUsd.abs().mul(pctUmbral));
}
