/**
 * §5.9 — Feedlot: por cabeza, por día, por tanda/corral.
 *
 * El feedlot NO entra en la carga (UG/ha) ni en kg/ha de cría o recría.
 * Se mide por sus propios KPI:
 *
 *   - Días de encierre
 *   - GMD (ganancia media diaria) real  = (kgSalida − kgEntrada) / díasEncierre / cabezas
 *   - Conversión real                   = kgMSConsumidos / kgGanados
 *   - Costo por kg ganado                = costoTotalUsd / kgGanadosTotales
 *   - Margen por cabeza y por día       = margenTotalUsd / cabezas [/ díasEncierre]
 *   - Precio de equilibrio (breakeven)   = costoTotalPorCabeza / kgSalidaPorCabeza
 *     (precio USD/kg vivo por debajo del cual la tanda pierde plata)
 */

import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number): Decimal =>
  x instanceof Decimal ? x : new Decimal(x);

export interface TandaInput {
  cabezas: number;
  fechaIngreso: Date;
  fechaSalida: Date;
  kgEntradaTotal: Decimal | number;
  kgSalidaTotal: Decimal | number;
  /** Consumo total de materia seca en kg (raciones, grano, etc.). */
  kgMsConsumidos: Decimal | number;
  /** Costo total imputado a la tanda: gasto + transferencia interna grano + sanidad + personal + etc. */
  costoTotalUsd: Decimal | number;
  /** Ingreso total: venta al frigorífico, o valor de salida si aún no vendido. */
  ingresoTotalUsd: Decimal | number;
}

export interface TandaResult {
  cabezas: number;
  diasEncierre: number;
  kgGanadosTotales: Decimal;
  gmdKgDia: Decimal;
  /** kg MS / kg ganados */
  conversion: Decimal;
  costoPorKgGanado: Decimal;
  margenTotalUsd: Decimal;
  margenPorCabezaUsd: Decimal;
  margenPorCabezaDiaUsd: Decimal;
  /** USD/kg vivo. */
  precioEquilibrioUsdKg: Decimal;
}

const round = (d: Decimal, n: number) => d.toDecimalPlaces(n, Decimal.ROUND_HALF_EVEN);

export function calcularTanda(inp: TandaInput): TandaResult {
  if (inp.cabezas <= 0) throw new RangeError('cabezas > 0');
  const dias = Math.round(
    (inp.fechaSalida.getTime() - inp.fechaIngreso.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (dias <= 0) throw new RangeError('fechaSalida debe ser posterior a fechaIngreso');

  const kgE = toDec(inp.kgEntradaTotal);
  const kgS = toDec(inp.kgSalidaTotal);
  const kgMs = toDec(inp.kgMsConsumidos);
  const costo = toDec(inp.costoTotalUsd);
  const ingreso = toDec(inp.ingresoTotalUsd);

  const kgGan = kgS.minus(kgE);
  if (kgGan.lte(0)) throw new RangeError('kg ganados ≤ 0 (kgSalida ≤ kgEntrada)');

  const gmd = kgGan.div(inp.cabezas).div(dias);
  const conversion = kgMs.div(kgGan);
  const costoKgGan = costo.div(kgGan);
  const margen = ingreso.minus(costo);
  const margenCab = margen.div(inp.cabezas);
  const margenCabDia = margenCab.div(dias);
  const costoPorCab = costo.div(inp.cabezas);
  const kgSalPorCab = kgS.div(inp.cabezas);
  const breakeven = kgSalPorCab.gt(0) ? costoPorCab.div(kgSalPorCab) : new Decimal(0);

  return {
    cabezas: inp.cabezas,
    diasEncierre: dias,
    kgGanadosTotales: round(kgGan, 2),
    gmdKgDia: round(gmd, 3),
    conversion: round(conversion, 3),
    costoPorKgGanado: round(costoKgGan, 4),
    margenTotalUsd: round(margen, 2),
    margenPorCabezaUsd: round(margenCab, 2),
    margenPorCabezaDiaUsd: round(margenCabDia, 4),
    precioEquilibrioUsdKg: round(breakeven, 4),
  };
}
