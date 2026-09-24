/**
 * §5.6 — Costo de oportunidad del capital.
 *
 * Tasa configurable (`AgroConfig.tasaCostoOportunidad`, anual USD) aplicada
 * sobre:
 *   - **Capital hacienda promedio** de cada actividad (cría, recría, feedlot).
 *   - **Capital circulante**: insumos y cultivos en pie de agricultura.
 *
 * NUNCA se aplica sobre:
 *   - Tierra (ya remunerada con la renta ficta).
 *   - Maquinaria (ya está en la tarifa).
 *
 * Se calcula **proporcional al tiempo** (fracción del año).
 *
 * Solo se muestra en la vista de decisión ("margen económico");
 * NO en el resultado contable.
 */

import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number): Decimal =>
  x instanceof Decimal ? x : new Decimal(x);

export interface CostoOportunidadInput {
  /** Capital inmovilizado (USD) — promedio del período o al inicio. */
  capitalUsd: Decimal | number;
  /** Tasa anual USD (0..1). */
  tasaAnual: Decimal | number;
  /** Fracción del año (0..1). Ej: 6 meses = 0.5. */
  fraccionAno: Decimal | number;
}

/**
 * Costo de oportunidad para un capital dado, proporcional al tiempo.
 *   CO = capital × tasa × fracciónAño
 */
export function costoOportunidad(inp: CostoOportunidadInput): Decimal {
  const cap = toDec(inp.capitalUsd);
  const t = toDec(inp.tasaAnual);
  const fr = toDec(inp.fraccionAno);
  if (t.lt(0)) throw new RangeError('tasaAnual < 0');
  if (fr.lt(0)) throw new RangeError('fraccionAno < 0');
  return cap.mul(t).mul(fr).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
}

/**
 * Fracción del año entre dos fechas (año de 365 días).
 */
export function fraccionAno(desde: Date, hasta: Date): Decimal {
  const ms = hasta.getTime() - desde.getTime();
  if (ms < 0) throw new RangeError('desde > hasta');
  return new Decimal(ms)
    .div(1000 * 60 * 60 * 24)
    .div(365)
    .toDecimalPlaces(6, Decimal.ROUND_HALF_EVEN);
}
