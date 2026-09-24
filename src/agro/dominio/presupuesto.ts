/**
 * §4.4 y §6 — Presupuesto.
 *
 * El presupuesto **económico** se CALCULA (no se carga): es la
 * multiplicación de cantidades físicas × precios, agrupadas por la misma
 * estructura de cuentas y centros que se usa para el real.
 *
 * Cargados por el usuario:
 *   - `AgroPresFisico`: cantidades planificadas por mes/centro/concepto
 *     (nacimientos, destetes, compras, ventas, pesos, ha, rindes, insumos/ha,
 *     toneladas de grano al feedlot).
 *   - `AgroPresPrecio`: precio USD por producto o categoría, por mes y
 *     escenario (pesimista/base/optimista).
 */

import { AgroCentroTipo } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export interface FisicoRow {
  mes: number;
  centro?: AgroCentroTipo | null;
  categoriaCod?: string | null;
  productoId?: string | null;
  concepto: string;
  cantidad: Decimal | number;
}

export interface PrecioRow {
  mes: number;
  productoId?: string | null;
  categoriaCod?: string | null;
  precioUsd: Decimal | number;
}

/**
 * Resuelve el precio aplicable para una fila física.
 *
 * Estrategia de matching (más específico gana):
 *   1. mismo mes + mismo productoId + misma categoriaCod
 *   2. mismo mes + mismo productoId
 *   3. mismo mes + misma categoriaCod
 *   4. cualquier mes anterior o igual, mismo productoId/categoriaCod (fallback)
 */
export function resolverPrecio(
  fila: FisicoRow,
  precios: PrecioRow[],
): Decimal | null {
  const candidatos = precios.filter(
    (p) => p.mes <= fila.mes && ((fila.productoId && p.productoId === fila.productoId) ||
      (fila.categoriaCod && p.categoriaCod === fila.categoriaCod)),
  );
  if (candidatos.length === 0) return null;
  // Prefiero el mes más cercano (mayor <= fila.mes).
  candidatos.sort((a, b) => b.mes - a.mes);
  return toDec(candidatos[0].precioUsd);
}

export interface EconomicoRow {
  mes: number;
  centro?: AgroCentroTipo | null;
  concepto: string;
  productoId?: string | null;
  categoriaCod?: string | null;
  cantidad: Decimal;
  precioUsd: Decimal;
  montoUsd: Decimal;
}

/**
 * Calcula el presupuesto económico = físico × precio, fila a fila.
 * Devuelve un array plano; el agrupador es del llamador.
 * Si no encuentra precio, deja `precioUsd = 0` y `montoUsd = 0`.
 */
export function calcularEconomico(
  fisico: FisicoRow[],
  precios: PrecioRow[],
): EconomicoRow[] {
  return fisico.map((f) => {
    const precio = resolverPrecio(f, precios) ?? new Decimal(0);
    const cantidad = toDec(f.cantidad);
    const monto = cantidad.mul(precio).toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);
    return {
      mes: f.mes,
      centro: f.centro ?? null,
      concepto: f.concepto,
      productoId: f.productoId ?? null,
      categoriaCod: f.categoriaCod ?? null,
      cantidad,
      precioUsd: precio,
      montoUsd: monto,
    };
  });
}

/**
 * Total por centro (útil para el tablero).
 */
export function totalizarPorCentro(rows: EconomicoRow[]): Record<string, Decimal> {
  const acc: Record<string, Decimal> = {};
  for (const r of rows) {
    const k = r.centro ?? 'SIN_CENTRO';
    acc[k] = (acc[k] ?? new Decimal(0)).plus(r.montoUsd);
  }
  return acc;
}
