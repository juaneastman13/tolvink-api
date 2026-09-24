/**
 * Optimización de fertilización.
 *
 * Modelo estándar Mitscherlich: rinde alcanzado por una dosis `d` de N
 * (kg/ha) sigue una curva de rendimientos decrecientes:
 *
 *   rinde(d) = rindeMax · (1 − exp(−k · (d + d0)))
 *
 * Con `rindeMax` (asíntota de rinde t/ha), `k` (respuesta), `d0` (aporte
 * del suelo). El óptimo económico está donde el ingreso marginal iguala
 * el costo marginal:
 *
 *   d/dd [ rinde(d) · precioGrano · precioBase − d · precioFert ] = 0
 *   precioGrano · rindeMax · k · exp(−k(d+d0)) = precioFert
 *
 *   d* = (1/k) · ln( precioGrano · rindeMax · k / precioFert ) − d0
 *
 * Devuelve la curva completa (rinde y margen por dosis) + dosis óptima +
 * relación de precios kg-grano/kg-fert (input clave del brief).
 */

import { DecisionResultado, ESCENARIOS, Escenario, Punto } from './tipos';

export interface FertilizacionParams {
  cultivo: string; // 'trigo' | 'soja' | ...
  precioGranoUsdT: number;
  precioFertUsdT: number; // USD/t de fertilizante
  rindeMaxTha: number; // asíntota
  k: number; // parámetro de respuesta (0.005..0.02 típ. para N en trigo)
  aporteSueloKgHa?: number; // d0
  dosisMaxKgHa?: number; // ventana de análisis
  escenario?: Escenario;
}

function rindeAt(d: number, p: FertilizacionParams, mult = ESCENARIOS.BASE): number {
  const d0 = p.aporteSueloKgHa ?? 0;
  const rMax = p.rindeMaxTha * mult.rinde;
  return rMax * (1 - Math.exp(-p.k * (d + d0)));
}

/**
 * Dosis óptima económica en kg/ha:
 *   d* = (1/k) · ln( pGrano · rMax · k / pFert ) − d0
 * (con pFert convertido a USD/kg y pGrano a USD/kg-grano).
 */
function dosisOptima(p: FertilizacionParams, mult = ESCENARIOS.BASE): number {
  const pG = (p.precioGranoUsdT * mult.precio) / 1000; // USD/kg grano
  const pF = (p.precioFertUsdT * mult.costoInsumos) / 1000; // USD/kg fert
  const rMax = p.rindeMaxTha * mult.rinde;
  const arg = (pG * rMax * 1000 * p.k) / pF; // rMax·k está en t/ha por unidad de N → pasamos a kg
  if (arg <= 1) return 0; // no cierra: fertilizar no es rentable
  const d0 = p.aporteSueloKgHa ?? 0;
  return Math.max(0, Math.log(arg) / p.k - d0);
}

export function calcularFertilizacion(
  p: FertilizacionParams,
): DecisionResultado<FertilizacionParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const dOpt = dosisOptima(p, mult);
  const dMax = p.dosisMaxKgHa ?? Math.max(200, dOpt * 2);

  const curva: Punto[] = [];
  let idxMax = 0;
  let margenMax = -Infinity;
  const steps = 40;
  for (let i = 0; i <= steps; i++) {
    const d = (dMax * i) / steps;
    const r = rindeAt(d, p, mult);
    const ingreso = r * p.precioGranoUsdT * mult.precio;
    const costo = (d / 1000) * p.precioFertUsdT * mult.costoInsumos;
    const margen = ingreso - costo;
    curva.push({ x: Math.round(d * 10) / 10, y: Math.round(margen * 100) / 100, meta: { rinde: r } });
    if (margen > margenMax) {
      margenMax = margen;
      idxMax = curva.length - 1;
    }
  }

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = Math.round(dosisOptima(p, ESCENARIOS[e]) * 10) / 10;
  }

  // Relación kg-grano / kg-fert (input mencionado en §6.1):
  const relacion = p.precioFertUsdT > 0 ? p.precioGranoUsdT / p.precioFertUsdT : 0;
  const alertas: string[] = [];
  if (dOpt === 0) alertas.push('Con estos precios la fertilización no es rentable: no aplicar N.');
  if (relacion < 0.15) alertas.push('Relación precio grano/fert muy baja; considerá esperar para comprar fertilizante.');

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(dOpt * 10) / 10,
      unidad: 'kg N/ha',
      interpretacion: `Dosis óptima económica ≈ ${dOpt.toFixed(0)} kg N/ha. Margen máx. USD ${margenMax.toFixed(2)}/ha.`,
    },
    curva: {
      labelX: 'dosis N (kg/ha)',
      labelY: 'margen (USD/ha)',
      unidadY: 'USD/ha',
      puntos: curva,
      optimo: { indice: idxMax, texto: `óptimo ${(curva[idxMax].x as number).toFixed(0)} kg N/ha` },
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      dOpt === 0
        ? 'No fertilizar: los precios actuales no cubren el costo marginal.'
        : `Aplicar ≈ ${dOpt.toFixed(0)} kg N/ha. Relación precio grano/fert = ${relacion.toFixed(2)}.`,
  };
}
