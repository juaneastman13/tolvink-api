/**
 * Contratos comunes de los modelos de decisión (§6.2).
 *
 * Todos los modelos devuelven la misma forma para que el frontend pueda
 * mapear a un componente genérico (KPI + curva + heatmap + alertas).
 */

import { Decimal } from '@prisma/client/runtime/library';

export type Escenario = 'PESIMISTA' | 'BASE' | 'OPTIMISTA' | 'SECA';

/** Punto para gráfico de línea. */
export interface Punto {
  x: number | string;
  y: number;
  /** Metadata libre (fecha ISO, etiqueta de tramo, etc). */
  meta?: Record<string, string | number | boolean | null>;
}

/** Tabla de doble entrada para heatmap: `celdas[y][x]` en la coordenada `(valoresX[x], valoresY[y])`. */
export interface MatrizDobleEntrada {
  labelX: string;
  labelY: string;
  valoresX: number[];
  valoresY: number[];
  /** [y][x], mismo orden que valoresY[] × valoresX[]. */
  celdas: number[][];
  /** Unidad de las celdas: "USD", "USD/ha", "USD/cab", "kg/día", "%", etc. */
  unidad: string;
}

/** Escala del breakeven / óptimo, para dibujar la línea de referencia sobre el heatmap. */
export interface CurvaBreakeven {
  /** Pares (x, y) donde el margen es 0 (o el criterio de umbral). */
  puntos: Punto[];
}

export interface DecisionResultado<TParams> {
  parametros: TParams;
  resultado: {
    valorPrincipal: number;
    unidad: string;
    /** Frase corta lista para mostrar bajo el número principal. */
    interpretacion: string;
  };
  /** Serie temporal / dependencia primaria (opcional). */
  curva?: {
    labelX: string;
    labelY: string;
    unidadY: string;
    puntos: Punto[];
    /** Índice dentro de `puntos` del máximo/óptimo. Puede ser null si no aplica. */
    optimo?: { indice: number; texto: string } | null;
  };
  matriz?: MatrizDobleEntrada;
  breakeven?: CurvaBreakeven;
  /** Corridas paralelas por escenario para comparar. */
  escenarios?: Record<Escenario, number>;
  alertas: string[];
  recomendacion: string;
}

/**
 * Modificadores por escenario. Multiplicativos sobre inputs numéricos
 * relevantes. El brief indica para "seca": rinde −40%, GMD pastoreo −30%,
 * suplementación extra, ventas anticipadas.
 *
 * Un modelo consume `EscenarioMult` y decide qué inputs shiftea; no todos
 * los modelos usan todos los campos.
 */
export interface EscenarioMult {
  precio: number; // 1.0 = sin cambio
  rinde: number;
  gmd: number;
  costoInsumos: number;
  demandaSuplemento: number; // > 1 en seca (más ración)
}

export const ESCENARIOS: Record<Escenario, EscenarioMult> = {
  PESIMISTA:  { precio: 0.85, rinde: 0.85, gmd: 0.90, costoInsumos: 1.10, demandaSuplemento: 1.10 },
  BASE:       { precio: 1.00, rinde: 1.00, gmd: 1.00, costoInsumos: 1.00, demandaSuplemento: 1.00 },
  OPTIMISTA:  { precio: 1.15, rinde: 1.15, gmd: 1.10, costoInsumos: 0.95, demandaSuplemento: 0.95 },
  SECA:       { precio: 0.95, rinde: 0.60, gmd: 0.70, costoInsumos: 1.15, demandaSuplemento: 1.40 },
};

/** Convierte Decimal→number para las shapes de decisión (siempre USD-nominales, no tenemos precisión bajo el céntimo). */
export function n(d: Decimal | number | null | undefined, decimals = 2): number {
  if (d === null || d === undefined) return 0;
  const dec = d instanceof Decimal ? d : new Decimal(d);
  return dec.toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN).toNumber();
}
