/**
 * §5.8 — Equivalencias carne–grano.
 *
 * Medidas de productividad **física**, no de rentabilidad. Se usan
 * precios base **fijos** (promedio 5 años) de config para convertir
 * ingresos heterogéneos a un denominador común.
 *
 * - `kg de carne equivalente`  = ingresoUsd / pBaseCarne(USD/kg)
 * - `t  de soja equivalente`   = ingresoUsd / pBaseSoja(USD/t)
 *
 * Precios corrientes NO se usan acá: el objetivo es aislar la eficiencia
 * productiva del efecto precio.
 */

import { Decimal } from '@prisma/client/runtime/library';

export interface PreciosBase {
  /** USD/kg carne. */
  pBaseCarne: Decimal | number;
  /** USD/t soja. */
  pBaseSoja: Decimal | number;
  /** USD/t trigo (opcional). */
  pBaseTrigo?: Decimal | number;
}

const toDec = (x: Decimal | number): Decimal =>
  x instanceof Decimal ? x : new Decimal(x);

export function kgCarneEquivalente(
  ingresoUsd: Decimal | number,
  precios: PreciosBase,
): Decimal {
  const p = toDec(precios.pBaseCarne);
  if (p.lte(0)) throw new RangeError('pBaseCarne debe ser > 0');
  return toDec(ingresoUsd).div(p).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

export function tSojaEquivalente(
  ingresoUsd: Decimal | number,
  precios: PreciosBase,
): Decimal {
  const p = toDec(precios.pBaseSoja);
  if (p.lte(0)) throw new RangeError('pBaseSoja debe ser > 0');
  return toDec(ingresoUsd).div(p).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
}

export function tTrigoEquivalente(
  ingresoUsd: Decimal | number,
  precios: PreciosBase,
): Decimal {
  if (!precios.pBaseTrigo) throw new RangeError('pBaseTrigo no configurado');
  const p = toDec(precios.pBaseTrigo);
  if (p.lte(0)) throw new RangeError('pBaseTrigo debe ser > 0');
  return toDec(ingresoUsd).div(p).toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
}
