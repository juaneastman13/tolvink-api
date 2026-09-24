/**
 * §6 — Flujo de caja rolling 12 meses.
 *
 * Reglas:
 *   - Ventana móvil: 12 meses desde `mesAnclaje` (default: mes corriente).
 *   - Los meses ya cerrados (mesAnclaje < mes) usan el REAL (cobros/pagos
 *     efectivos por `fechaCobroPago` / `fechaCobro` / `fechaPago`).
 *   - Los meses futuros usan el PRESUPUESTO (movimientos económicos
 *     esperados por fecha).
 *   - Saldo inicial = saldo real de bancos a la fecha de arranque
 *     (o 0 si no se pasa).
 *   - Alertas por mes:
 *       · rojo si saldoFinal < 0
 *       · amarillo si saldoFinal < saldoMinimoOperativo
 *   - Salida: 12 filas + resumen con mes de saldo mínimo y monto a
 *     financiar para cubrirlo.
 *
 * Se sirve como función pura: quien la llama arma los ingresos/egresos
 * mes a mes (real hasta el cierre, presupuesto en adelante) y esta
 * función acumula y detecta las alertas.
 */

import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export type OrigenFlujo = 'REAL' | 'PRESUPUESTO';

export interface MovMensual {
  /** Año calendario. */
  ano: number;
  /** 1..12. */
  mes: number;
  ingresosUsd: Decimal | number;
  egresosUsd: Decimal | number;
  origen: OrigenFlujo;
}

export interface FilaCaja {
  ano: number;
  mes: number;
  ingresosUsd: Decimal;
  egresosUsd: Decimal;
  netoUsd: Decimal;
  saldoInicialUsd: Decimal;
  saldoFinalUsd: Decimal;
  origen: OrigenFlujo;
  alerta: 'ROJO' | 'AMARILLO' | 'OK';
}

export interface CajaResumen {
  filas: FilaCaja[];
  saldoInicialUsd: Decimal;
  saldoMinimoUsd: Decimal;
  mesSaldoMinimo: { ano: number; mes: number } | null;
  /** Monto a financiar = max(0, saldoMinimoOperativo − saldoMinimoDelPeriodo). */
  montoFinanciarUsd: Decimal;
}

const round = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

/**
 * Ejecuta el flujo de 12 filas (o cuantas movs vengan) acumulando el saldo.
 * Los movs deben venir ORDENADOS por ano/mes ascendente.
 */
export function proyectarCaja(
  movs: MovMensual[],
  saldoInicialUsd: Decimal | number,
  saldoMinimoOperativo: Decimal | number,
): CajaResumen {
  let saldo = toDec(saldoInicialUsd);
  const minOp = toDec(saldoMinimoOperativo);
  const filas: FilaCaja[] = [];
  let mesMin: { ano: number; mes: number } | null = null;
  let saldoMin: Decimal | null = null;

  for (const m of movs) {
    const ing = toDec(m.ingresosUsd);
    const egr = toDec(m.egresosUsd);
    const neto = ing.minus(egr);
    const saldoInicialMes = saldo;
    saldo = saldo.plus(neto);
    let alerta: FilaCaja['alerta'] = 'OK';
    if (saldo.lt(0)) alerta = 'ROJO';
    else if (saldo.lt(minOp)) alerta = 'AMARILLO';

    filas.push({
      ano: m.ano,
      mes: m.mes,
      ingresosUsd: round(ing),
      egresosUsd: round(egr),
      netoUsd: round(neto),
      saldoInicialUsd: round(saldoInicialMes),
      saldoFinalUsd: round(saldo),
      origen: m.origen,
      alerta,
    });

    if (saldoMin === null || saldo.lt(saldoMin)) {
      saldoMin = saldo;
      mesMin = { ano: m.ano, mes: m.mes };
    }
  }

  const saldoMinFinal = saldoMin ?? new Decimal(0);
  const financiar = minOp.minus(saldoMinFinal);
  const montoFinanciarUsd = financiar.gt(0) ? round(financiar) : new Decimal(0);

  return {
    filas,
    saldoInicialUsd: round(toDec(saldoInicialUsd)),
    saldoMinimoUsd: round(saldoMinFinal),
    mesSaldoMinimo: mesMin,
    montoFinanciarUsd,
  };
}
