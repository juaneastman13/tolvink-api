/**
 * Recomposición de negocios: mix óptimo por MB/ha.
 *
 * Modelo simple bang-for-buck (sin LP solver):
 *   - Cada actividad tiene: haDisponibles, mbUsdHa, capitalUsdHa, restricciones.
 *   - Se ordenan por MB/ha decreciente.
 *   - Se asignan ha en ese orden hasta agotar ha totales y capital.
 *
 * Alcanza para el 90% de los casos (el brief menciona "recomposición";
 * un LP puro requeriría restricciones sofisticadas de rotación que hoy
 * no tenemos modeladas).
 */

import { DecisionResultado, Escenario, ESCENARIOS } from './tipos';

export interface Actividad {
  codigo: string; // 'AGR_SOJA' | 'AGR_TRIGO' | 'CRI' | 'REC' | 'FEED'
  haDisponiblesMax: number;
  haDisponiblesMin?: number; // ej. para mantener el rodeo mínimo
  mbUsdHa: number; // MB por ha
  capitalUsdHa: number; // capital circulante requerido
  requiereAptitud?: string; // etiqueta libre; no se usa acá pero se puede loguear
}

export interface RecomposicionParams {
  haTotales: number;
  capitalDisponibleUsd: number;
  actividades: Actividad[];
  escenario?: Escenario;
}

interface Asignacion {
  codigo: string;
  ha: number;
  mbTotalUsd: number;
  capitalTotalUsd: number;
}

/**
 * Corrida "una sola vez" para un escenario dado; sin barrer los cuatro. Se
 * usa internamente para poblar `escenarios` sin recursión infinita.
 */
function corrida(p: RecomposicionParams, escenario: Escenario): number {
  const mult = ESCENARIOS[escenario];
  const ordenadas = [...p.actividades]
    .map((a) => ({
      ...a,
      mbAjustado: a.mbUsdHa * mult.rinde * mult.precio - a.capitalUsdHa * mult.costoInsumos * 0.05,
    }))
    .sort((a, b) => b.mbAjustado - a.mbAjustado);

  let haRestantes = p.haTotales;
  let capitalRestante = p.capitalDisponibleUsd;
  const asig = new Map<string, { ha: number; mb: number }>();

  for (const a of ordenadas) {
    const min = Math.max(0, a.haDisponiblesMin ?? 0);
    if (min > 0 && haRestantes >= min && capitalRestante >= min * a.capitalUsdHa) {
      asig.set(a.codigo, { ha: min, mb: min * a.mbAjustado });
      haRestantes -= min;
      capitalRestante -= min * a.capitalUsdHa;
    }
  }
  for (const a of ordenadas) {
    if (haRestantes <= 0 || capitalRestante <= 0) break;
    const ya = asig.get(a.codigo)?.ha ?? 0;
    const capacidad = Math.max(0, a.haDisponiblesMax - ya);
    const haXCap = a.capitalUsdHa > 0 ? capitalRestante / a.capitalUsdHa : haRestantes;
    const asignar = Math.min(haRestantes, capacidad, haXCap);
    if (asignar <= 0) continue;
    const prev = asig.get(a.codigo) ?? { ha: 0, mb: 0 };
    prev.ha += asignar;
    prev.mb += asignar * a.mbAjustado;
    asig.set(a.codigo, prev);
    haRestantes -= asignar;
    capitalRestante -= asignar * a.capitalUsdHa;
  }
  let mbTotal = 0;
  for (const v of asig.values()) mbTotal += v.mb;
  return Math.round(mbTotal * 100) / 100;
}

export function calcularRecomposicion(
  p: RecomposicionParams,
): DecisionResultado<RecomposicionParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const ordenadas = [...p.actividades]
    .map((a) => ({
      ...a,
      mbAjustado: a.mbUsdHa * mult.rinde * mult.precio - a.capitalUsdHa * mult.costoInsumos * 0.05, // penalización por capital
    }))
    .sort((a, b) => b.mbAjustado - a.mbAjustado);

  // Asegurar mínimos primero.
  let haRestantes = p.haTotales;
  let capitalRestante = p.capitalDisponibleUsd;
  const asig = new Map<string, Asignacion>();

  for (const a of ordenadas) {
    const min = Math.max(0, a.haDisponiblesMin ?? 0);
    if (min > 0 && haRestantes >= min && capitalRestante >= min * a.capitalUsdHa) {
      asig.set(a.codigo, {
        codigo: a.codigo,
        ha: min,
        mbTotalUsd: min * a.mbAjustado,
        capitalTotalUsd: min * a.capitalUsdHa,
      });
      haRestantes -= min;
      capitalRestante -= min * a.capitalUsdHa;
    }
  }

  // Distribuir el resto por MB/ha descendente.
  for (const a of ordenadas) {
    if (haRestantes <= 0 || capitalRestante <= 0) break;
    const ya = asig.get(a.codigo)?.ha ?? 0;
    const capacidad = Math.max(0, a.haDisponiblesMax - ya);
    const haXCap = a.capitalUsdHa > 0 ? capitalRestante / a.capitalUsdHa : haRestantes;
    const asignar = Math.min(haRestantes, capacidad, haXCap);
    if (asignar <= 0) continue;
    const prev = asig.get(a.codigo) ?? {
      codigo: a.codigo,
      ha: 0,
      mbTotalUsd: 0,
      capitalTotalUsd: 0,
    };
    prev.ha += asignar;
    prev.mbTotalUsd += asignar * a.mbAjustado;
    prev.capitalTotalUsd += asignar * a.capitalUsdHa;
    asig.set(a.codigo, prev);
    haRestantes -= asignar;
    capitalRestante -= asignar * a.capitalUsdHa;
  }

  const salida = Array.from(asig.values()).map((x) => ({
    ...x,
    ha: Math.round(x.ha * 10) / 10,
    mbTotalUsd: Math.round(x.mbTotalUsd * 100) / 100,
    capitalTotalUsd: Math.round(x.capitalTotalUsd * 100) / 100,
  }));
  const totalMb = salida.reduce((a, x) => a + x.mbTotalUsd, 0);

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = corrida(p, e);
  }

  const alertas: string[] = [];
  if (haRestantes > 0.1) alertas.push(`Sobran ${haRestantes.toFixed(0)} ha sin asignar (falta capital o techo de área).`);
  if (capitalRestante > 0 && haRestantes <= 0.1)
    alertas.push(`Sobra capital USD ${capitalRestante.toFixed(0)}: podés diversificar en fondos/pasturas.`);

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(totalMb * 100) / 100,
      unidad: 'USD MB total',
      interpretacion: `Mix óptimo con MB total USD ${totalMb.toFixed(0)}. Ha sin asignar: ${haRestantes.toFixed(0)}.`,
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      salida.length === 0
        ? 'Sin actividades viables con las restricciones dadas.'
        : `Priorizar ${salida.slice(0, 3).map((x) => `${x.codigo} (${x.ha} ha)`).join(', ')}.`,
    // curva no aplica; devolvemos el detalle vía "matriz" degenerada de una columna.
    matriz: {
      labelX: 'Métrica',
      labelY: 'Actividad',
      valoresX: [1, 2, 3],
      valoresY: salida.map((_x, i) => i),
      celdas: salida.map((s) => [s.ha, s.mbTotalUsd, s.capitalTotalUsd]),
      unidad: 'mixto',
    },
  };
}
