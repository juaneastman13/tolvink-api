/**
 * §5.4 — Asignación de costos compartidos.
 *
 * Personal y maquinaria compartidos se reparten con **porcentajes
 * explícitos** por centro, guardados en `AgroConfig.porcentajesAsignacion`.
 * Nunca por criterios implícitos.
 *
 * Excepción documentada: si un porcentaje "personal-de-pasto" está definido
 * pero no llegan detalles por centro, se puede repartir entre `CRI` y `REC`
 * **por UG promedio** — es el fallback histórico.
 *
 * Maquinaria: dos modos (`AgroConfig.modoMaquinaria`).
 *   - `PORCENTAJE`: reparto porcentual del costo total del centro MAQ.
 *   - `TARIFA`: cada labor se carga al lote a tarifa de contratista.
 *     El centro `MAQ` acumula la diferencia:
 *       - Sobrerrecupero  (ahorro por tener equipo propio, positivo)
 *       - Subrecupero     (indicio comprar-vs-contratar, negativo)
 */

import { AgroCentroTipo } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number): Decimal =>
  x instanceof Decimal ? x : new Decimal(x);

/** Fracciones (0..1) que suman ≈ 1. */
export type PorcentajesPorCentro = Partial<Record<AgroCentroTipo, number | Decimal>>;

export interface AsignacionResult {
  asignado: Partial<Record<AgroCentroTipo, Decimal>>;
  /** Diferencia por redondeo, en caso de que %s no sumen exacto 1. */
  residuo: Decimal;
}

/**
 * Reparte un monto total entre centros según los porcentajes dados.
 * Valida que la suma esté entre 0.999 y 1.001 (tolerancia por redondeo).
 * El residuo se acumula en el centro de mayor peso (o el primero si no lo hay).
 */
export function repartirPorPorcentaje(
  total: Decimal | number,
  porcentajes: PorcentajesPorCentro,
): AsignacionResult {
  const t = toDec(total);
  const entries = Object.entries(porcentajes) as Array<[AgroCentroTipo, number | Decimal]>;
  if (entries.length === 0) throw new RangeError('porcentajes vacío');

  const suma = entries.reduce<Decimal>((a, [, v]) => a.plus(toDec(v)), new Decimal(0));
  if (suma.lt(0.999) || suma.gt(1.001)) {
    throw new RangeError(`Los porcentajes deben sumar 1; suman ${suma.toString()}`);
  }

  const asignado: Partial<Record<AgroCentroTipo, Decimal>> = {};
  let acumulado = new Decimal(0);
  for (const [centro, v] of entries) {
    const parte = t.mul(toDec(v)).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    asignado[centro] = parte;
    acumulado = acumulado.plus(parte);
  }
  const residuo = t.minus(acumulado);

  // Ajuste: el residuo se suma al centro más grande para preservar la suma exacta.
  if (!residuo.eq(0)) {
    let mayor: AgroCentroTipo = entries[0][0];
    let mayorPct = toDec(entries[0][1]);
    for (const [c, v] of entries) {
      const dv = toDec(v);
      if (dv.gt(mayorPct)) {
        mayorPct = dv;
        mayor = c;
      }
    }
    asignado[mayor] = (asignado[mayor] ?? new Decimal(0)).plus(residuo);
  }

  return { asignado, residuo: new Decimal(0) };
}

/**
 * Reparte un monto entre `CRI` y `REC` proporcional a las UG promedio de
 * cada centro. Fallback para personal-de-pasto cuando no hay % explícito.
 */
export function repartirPorUg(
  total: Decimal | number,
  ugCri: Decimal | number,
  ugRec: Decimal | number,
): AsignacionResult {
  const uC = toDec(ugCri);
  const uR = toDec(ugRec);
  const sum = uC.plus(uR);
  if (sum.lte(0)) throw new RangeError('UG total 0');
  const pctCri = uC.div(sum);
  const pctRec = uR.div(sum);
  return repartirPorPorcentaje(total, { CRI: pctCri, REC: pctRec });
}

// ── Maquinaria: modo TARIFA — resultado del centro MAQ ────────────────

export interface EntradaTarifaMaq {
  /** USD ingresado (tarifa cobrada al lote a precio de contratista). */
  ingresoTarifa: Decimal | number;
  /** USD costo real de la labor propia (combustible, mant., amortización). */
  costoReal: Decimal | number;
}

export interface ResultadoMaqTarifa {
  ingresoTotal: Decimal;
  costoTotal: Decimal;
  /** Positivo = sobrerrecupero (ahorro); negativo = subrecupero. */
  diferencia: Decimal;
}

/**
 * Consolida el resultado del centro MAQ en modo TARIFA.
 * `sobrerrecupero > 0` → tener equipo propio salió más barato que contratar.
 * `sobrerrecupero < 0` → equipo propio salió más caro (input para decisión).
 */
export function consolidarMaquinariaTarifa(
  entradas: EntradaTarifaMaq[],
): ResultadoMaqTarifa {
  const ing = entradas.reduce<Decimal>((a, e) => a.plus(toDec(e.ingresoTarifa)), new Decimal(0));
  const cost = entradas.reduce<Decimal>((a, e) => a.plus(toDec(e.costoReal)), new Decimal(0));
  return {
    ingresoTotal: ing.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
    costoTotal: cost.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
    diferencia: ing.minus(cost).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN),
  };
}
