/**
 * §5.5 — Reconocimiento de campaña vs ejercicio.
 *
 * Cada `AgroLoteCampania` es una **orden de producción**: acumula costos
 * desde el barbecho hasta la venta. Reglas:
 *
 *   - El resultado de una campaña se reconoce en el **ejercicio en que se
 *     cosecha** (fecha real de cosecha, no de siembra).
 *   - Costos de siembras cuya cosecha cae en el ejercicio siguiente quedan
 *     como **activo "Cultivos en crecimiento"** al cierre, valuados a costo
 *     incurrido.
 *   - El reporte "por zafra" y el reporte "por ejercicio" deben conciliar
 *     sin ajustes manuales.
 */

import { ejercicioDe, EjercicioConfig } from './ejercicio';
import { Decimal } from '@prisma/client/runtime/library';

export interface CampaniaResumen {
  /** Fecha real de cosecha del lote-campaña. Null si aún no cosechó. */
  fechaCosecha: Date | null;
  /** Costos totales acumulados en el lote-campaña (USD). */
  costoAcumuladoUsd: Decimal | number;
  /** Ingresos totales acumulados en el lote-campaña (USD). Ventas + transferencia interna al feedlot. */
  ingresoAcumuladoUsd: Decimal | number;
}

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export interface ClasificacionCampania {
  /** Ejercicio al que se imputa el resultado (el que contiene la cosecha). Null si sin cosechar. */
  ejercicioReconocimiento: number | null;
  /** Resultado (ingreso − costo). Solo se reconoce si ya cosechó. */
  resultadoUsd: Decimal;
  /** Costo capitalizado como "Cultivos en crecimiento" si aún no cosechó al cierre. */
  activoCultivosEnPieUsd: Decimal;
}

/**
 * Clasifica una campaña respecto de un ejercicio de cierre:
 *   - Si `fechaCosecha` cae dentro del ejercicio o antes → reconoce resultado
 *     en `ejercicioDe(fechaCosecha)`.
 *   - Si `fechaCosecha` es null o cae después del cierre → los costos quedan
 *     como activo "Cultivos en crecimiento".
 */
export function clasificarCampania(
  cfg: EjercicioConfig,
  campania: CampaniaResumen,
  fechaCierre: Date,
): ClasificacionCampania {
  const costo = toDec(campania.costoAcumuladoUsd);
  const ingreso = toDec(campania.ingresoAcumuladoUsd);

  if (!campania.fechaCosecha || campania.fechaCosecha > fechaCierre) {
    return {
      ejercicioReconocimiento: null,
      resultadoUsd: new Decimal(0),
      activoCultivosEnPieUsd: costo.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
    };
  }
  const ej = ejercicioDe(cfg, campania.fechaCosecha);
  return {
    ejercicioReconocimiento: ej,
    resultadoUsd: ingreso.minus(costo).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
    activoCultivosEnPieUsd: new Decimal(0),
  };
}
