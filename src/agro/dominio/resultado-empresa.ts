/**
 * §5.7 — Resultado de empresa. Dos vistas.
 *
 * ## Vista NEGOCIOS (para comparar actividades)
 *   Margen bruto (MB) después de tierra por actividad = ingresos − costos
 *   directos − renta ficta de la tierra que usa esa actividad.
 *   Cada actividad se compara consigo misma como si arrendara su tierra.
 *
 * ## Vista EMPRESA (resultado real)
 *   Σ MB después de tierra
 *   + reversión de renta ficta   ← porque la empresa es dueña de la tierra
 *   ± resultado del centro MAQ  (§5.4)
 *   − estructura no asignada
 *   − amortizaciones no asignadas
 *   = Resultado operativo (ingreso de capital)
 *   − intereses
 *   ± diferencia de cambio
 *   = Resultado neto
 *
 *   Resultado por tenencia (§5.3) se muestra APARTE del resultado neto.
 */

import { AgroCentroTipo } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export interface MargenActividad {
  centro: AgroCentroTipo;
  ingresosUsd: Decimal | number;
  /** Costos directos ya asignados a la actividad. */
  costosDirectosUsd: Decimal | number;
  /** Renta ficta (o real) de la tierra que usa la actividad. */
  rentaTierraUsd: Decimal | number;
}

export interface VistaNegocios {
  porCentro: Array<{
    centro: AgroCentroTipo;
    mbDespuesTierra: Decimal;
  }>;
  totalMbDespuesTierra: Decimal;
}

export function vistaNegocios(margenes: MargenActividad[]): VistaNegocios {
  const round = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  const porCentro = margenes.map((m) => ({
    centro: m.centro,
    mbDespuesTierra: round(
      toDec(m.ingresosUsd).minus(toDec(m.costosDirectosUsd)).minus(toDec(m.rentaTierraUsd)),
    ),
  }));
  const totalMbDespuesTierra = round(
    porCentro.reduce<Decimal>((a, x) => a.plus(x.mbDespuesTierra), new Decimal(0)),
  );
  return { porCentro, totalMbDespuesTierra };
}

export interface VistaEmpresaInput {
  margenes: MargenActividad[];
  /** Renta ficta total imputada a las actividades (para revertir). */
  rentaFictaTotalUsd: Decimal | number;
  /** Resultado del centro MAQ (§5.4). + o −. */
  resultadoMaqUsd: Decimal | number;
  /** Costos de estructura no asignados a ningún centro operativo. */
  estructuraNoAsignadaUsd: Decimal | number;
  /** Amortizaciones no asignadas. */
  amortizacionesNoAsignadasUsd: Decimal | number;
  /** Intereses de préstamos. */
  interesesUsd: Decimal | number;
  /** Diferencia de cambio del ejercicio. + o −. */
  diferenciaCambioUsd: Decimal | number;
  /** Resultado por tenencia (§5.3). Se muestra aparte. */
  resultadoTenenciaUsd?: Decimal | number;
}

export interface VistaEmpresaResultado {
  totalMbDespuesTierra: Decimal;
  reversionRentaFicta: Decimal;
  resultadoMaq: Decimal;
  estructuraNoAsignada: Decimal;
  amortizacionesNoAsignadas: Decimal;
  /** = Σ MB + reversión ± MAQ − estructura − amortizaciones */
  resultadoOperativo: Decimal;
  intereses: Decimal;
  diferenciaCambio: Decimal;
  /** = operativo − intereses ± dif cambio */
  resultadoNeto: Decimal;
  /** APARTE (no dentro del resultado neto). */
  resultadoTenencia: Decimal;
}

export function vistaEmpresa(inp: VistaEmpresaInput): VistaEmpresaResultado {
  const round = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
  const vn = vistaNegocios(inp.margenes);
  const revRenta = toDec(inp.rentaFictaTotalUsd);
  const maq = toDec(inp.resultadoMaqUsd);
  const est = toDec(inp.estructuraNoAsignadaUsd);
  const amort = toDec(inp.amortizacionesNoAsignadasUsd);
  const int = toDec(inp.interesesUsd);
  const df = toDec(inp.diferenciaCambioUsd);
  const ten = toDec(inp.resultadoTenenciaUsd);

  const operativo = vn.totalMbDespuesTierra
    .plus(revRenta)
    .plus(maq)
    .minus(est)
    .minus(amort);

  const neto = operativo.minus(int).plus(df);

  return {
    totalMbDespuesTierra: vn.totalMbDespuesTierra,
    reversionRentaFicta: round(revRenta),
    resultadoMaq: round(maq),
    estructuraNoAsignada: round(est),
    amortizacionesNoAsignadas: round(amort),
    resultadoOperativo: round(operativo),
    intereses: round(int),
    diferenciaCambio: round(df),
    resultadoNeto: round(neto),
    resultadoTenencia: round(ten),
  };
}
