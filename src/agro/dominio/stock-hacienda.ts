/**
 * Reglas de stock de hacienda (§4.3 del brief).
 *
 * Todo movimiento afecta el stock de una combinación `(centro, categoriaCod)`.
 * Estas son funciones puras que se aplican **antes** de persistir para validar.
 *
 * Convenciones de signo:
 *   - NACIMIENTO   → +cabezas en (centro, categoria)
 *   - COMPRA       → +cabezas en (centro, categoria)
 *   - INVENTARIO   → set (histórico) — para reconciliar. No valida stock previo.
 *   - VENTA        → −cabezas en (centro, categoria)
 *   - MUERTE       → −cabezas en (centro, categoria)
 *   - TRANSF       → −cabezas en origen, +cabezas en destino
 *   - RECATEG      → como TRANSF: origen categoría A → destino categoría B (mismo centro por default,
 *                    o centro distinto si `centroDestino` viene definido).
 *   - PESADA       → 0 (no mueve stock; sólo actualiza peso)
 *   - DICOSE       → 0 (declaración, no movimiento)
 *   - TACTO        → 0 (marca preñadas)
 */

import { AgroCentroTipo, AgroMovHaciendaTipo } from '@prisma/client';

export interface MovHacienda {
  tipo: AgroMovHaciendaTipo;
  centro: AgroCentroTipo;
  categoriaCod: string;
  centroDestino?: AgroCentroTipo | null;
  categoriaDestino?: string | null;
  cabezas: number;
}

export interface StockKey {
  centro: AgroCentroTipo;
  categoriaCod: string;
}

export type StockMap = Map<string, number>;

export function stockKey(centro: AgroCentroTipo, cat: string): string {
  return `${centro}::${cat}`;
}

/**
 * Aplica un movimiento a un StockMap mutable. Devuelve el saldo resultante
 * de la o las combinaciones afectadas, para inspección.
 */
export function aplicar(stock: StockMap, mov: MovHacienda): StockKey[] {
  const affected: StockKey[] = [];
  const cabezas = mov.cabezas;

  const add = (centro: AgroCentroTipo, cat: string, delta: number) => {
    const k = stockKey(centro, cat);
    stock.set(k, (stock.get(k) ?? 0) + delta);
    affected.push({ centro, categoriaCod: cat });
  };

  switch (mov.tipo) {
    case 'NACIMIENTO':
    case 'COMPRA':
      add(mov.centro, mov.categoriaCod, +cabezas);
      break;
    case 'VENTA':
    case 'MUERTE':
      add(mov.centro, mov.categoriaCod, -cabezas);
      break;
    case 'TRANSF':
    case 'RECATEG': {
      const destCentro = mov.centroDestino ?? mov.centro;
      const destCat = mov.categoriaDestino ?? mov.categoriaCod;
      add(mov.centro, mov.categoriaCod, -cabezas);
      add(destCentro, destCat, +cabezas);
      break;
    }
    case 'INVENTARIO':
      // set absoluto: escribimos el saldo directamente
      stock.set(stockKey(mov.centro, mov.categoriaCod), cabezas);
      affected.push({ centro: mov.centro, categoriaCod: mov.categoriaCod });
      break;
    case 'PESADA':
    case 'DICOSE':
    case 'TACTO':
      // no afecta stock
      break;
  }
  return affected;
}

/**
 * Valida las reglas duras de un movimiento (antes de aplicarlo).
 *
 *   1. `cabezas > 0` para todo tipo excepto PESADA/DICOSE/TACTO (permiten 0
 *      si el usuario está sólo registrando pesada o declaración).
 *   2. TRANSF y RECATEG requieren destino:
 *        - TRANSF: distinto centro. Categoría puede ser la misma o distinta.
 *        - RECATEG: distinta categoría. Centro puede ser el mismo o distinto.
 *   3. TRANSF con mismo centro y misma categoría es no-op → error.
 *   4. Movimientos que restan (VENTA/MUERTE/TRANSF/RECATEG) no pueden dejar
 *      el saldo (centro, categoría) por debajo de 0.
 *
 * Retorna la lista de errores; array vacío = válido.
 */
export function validar(
  mov: MovHacienda,
  stockActual: StockMap,
): string[] {
  const errs: string[] = [];
  const mueveStock = ['NACIMIENTO', 'COMPRA', 'VENTA', 'MUERTE', 'TRANSF', 'RECATEG'].includes(
    mov.tipo,
  );

  if (mueveStock && (!Number.isFinite(mov.cabezas) || mov.cabezas <= 0)) {
    errs.push(`cabezas debe ser > 0 para tipo ${mov.tipo}`);
  }

  if (mov.tipo === 'TRANSF') {
    const destCentro = mov.centroDestino ?? mov.centro;
    const destCat = mov.categoriaDestino ?? mov.categoriaCod;
    if (destCentro === mov.centro && destCat === mov.categoriaCod) {
      errs.push('TRANSF requiere centro o categoría de destino distinta a la de origen');
    }
    if (!mov.centroDestino) {
      errs.push('TRANSF requiere centroDestino');
    }
  }

  if (mov.tipo === 'RECATEG') {
    if (!mov.categoriaDestino) {
      errs.push('RECATEG requiere categoriaDestino');
    } else if (
      mov.categoriaDestino === mov.categoriaCod &&
      (mov.centroDestino ?? mov.centro) === mov.centro
    ) {
      errs.push('RECATEG requiere categoría de destino distinta');
    }
  }

  // Validación de saldo: aplicamos sobre una copia y verificamos que ninguna
  // combinación afectada quede negativa.
  if (mov.tipo === 'VENTA' || mov.tipo === 'MUERTE' || mov.tipo === 'TRANSF' || mov.tipo === 'RECATEG') {
    const proyeccion = new Map(stockActual);
    aplicar(proyeccion, mov);
    // Verifico sólo las claves con delta < 0 (las que este mov redujo).
    const originKey = stockKey(mov.centro, mov.categoriaCod);
    const originSaldo = proyeccion.get(originKey) ?? 0;
    if (originSaldo < 0) {
      errs.push(
        `Stock insuficiente en ${mov.centro}/${mov.categoriaCod}: quedaría ${originSaldo} cabezas`,
      );
    }
  }

  return errs;
}

/**
 * Recorre una serie de movimientos ordenados por fecha y devuelve el
 * stock resultante. Útil para reconstruir el estado sin base de datos
 * en tests, y para el reporte "stock a una fecha".
 */
export function proyectarStock(movs: MovHacienda[]): StockMap {
  const s: StockMap = new Map();
  for (const m of movs) aplicar(s, m);
  return s;
}
