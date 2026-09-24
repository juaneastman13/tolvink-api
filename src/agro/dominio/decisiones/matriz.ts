/**
 * Utilidad para construir tablas de doble entrada (heatmaps) a partir de
 * una función f(x, y) evaluada sobre una grilla de valores.
 */

import { MatrizDobleEntrada } from './tipos';

export function tablaDobleEntrada(
  labelX: string,
  labelY: string,
  valoresX: number[],
  valoresY: number[],
  fn: (x: number, y: number) => number,
  unidad = 'USD',
): MatrizDobleEntrada {
  const celdas: number[][] = [];
  for (const y of valoresY) {
    const fila: number[] = [];
    for (const x of valoresX) {
      const v = fn(x, y);
      fila.push(Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
    }
    celdas.push(fila);
  }
  return { labelX, labelY, valoresX, valoresY, celdas, unidad };
}

/** Serie de valores equidistantes; útil para armar ejes de la matriz. */
export function rango(min: number, max: number, pasos: number): number[] {
  if (pasos < 2) return [min];
  const step = (max - min) / (pasos - 1);
  const arr: number[] = [];
  for (let i = 0; i < pasos; i++) arr.push(Math.round((min + step * i) * 10000) / 10000);
  return arr;
}
