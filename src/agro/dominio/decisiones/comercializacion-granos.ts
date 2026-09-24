/**
 * Comercialización de granos: vender ahora vs esperar N meses.
 *
 * Modelo:
 *   valorEsperado(m)  = precioEsperado(m) − costoAlmacenajeUsdT · m − CO
 *   CO(m)             = precioSpot · tasaAnual · (m/12)
 *
 * Recomienda el mes de venta cuyo valorEsperado maximiza el neto,
 * comparado con vender ya (m=0). El usuario puede pasar la serie de
 * precios esperados o dejar que se estime linealmente con `variacionMensualPct`.
 */

import { DecisionResultado, Escenario, ESCENARIOS, Punto } from './tipos';

export interface ComercializacionParams {
  precioSpotUsdT: number;
  /** Serie de precios esperados por mes futuro (mes 1..N). Si viene, tiene precedencia. */
  precioEsperadoPorMes?: number[];
  /** Sino, se genera linealmente con esta variación mensual (ej. 0.01 = +1%/mes). */
  variacionMensualPct?: number;
  costoAlmacenajeUsdT: number; // por mes
  tasaAnualCO: number;
  mesesMax: number;
  escenario?: Escenario;
}

function precioMes(m: number, p: ComercializacionParams, mult = ESCENARIOS.BASE): number {
  if (m === 0) return p.precioSpotUsdT * mult.precio;
  if (p.precioEsperadoPorMes && p.precioEsperadoPorMes[m - 1] !== undefined) {
    return p.precioEsperadoPorMes[m - 1] * mult.precio;
  }
  const dp = p.variacionMensualPct ?? 0;
  return p.precioSpotUsdT * mult.precio * Math.pow(1 + dp, m);
}

function neto(m: number, p: ComercializacionParams, mult = ESCENARIOS.BASE): number {
  const pMes = precioMes(m, p, mult);
  const co = p.precioSpotUsdT * mult.precio * p.tasaAnualCO * (m / 12);
  const almac = p.costoAlmacenajeUsdT * m * mult.costoInsumos;
  return pMes - co - almac;
}

export function calcularComercializacion(
  p: ComercializacionParams,
): DecisionResultado<ComercializacionParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const curva: Punto[] = [];
  let idxMax = 0;
  let maxN = -Infinity;
  for (let m = 0; m <= p.mesesMax; m++) {
    const n = neto(m, p, mult);
    curva.push({ x: m, y: Math.round(n * 100) / 100, meta: { precio: precioMes(m, p, mult) } });
    if (n > maxN) {
      maxN = n;
      idxMax = m;
    }
  }
  const netoSpot = neto(0, p, mult);
  const beneficioEsperar = maxN - netoSpot;

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    let mv = -Infinity;
    for (let m = 0; m <= p.mesesMax; m++) mv = Math.max(mv, neto(m, p, ESCENARIOS[e]));
    escenariosOut[e] = Math.round(mv * 100) / 100;
  }

  const alertas: string[] = [];
  if (idxMax === 0) alertas.push('Vender ya: ninguna espera mejora el neto.');
  if (idxMax === p.mesesMax) alertas.push('Óptimo en el borde de la ventana: ampliá `mesesMax`.');
  if (beneficioEsperar > 0 && beneficioEsperar < p.precioSpotUsdT * 0.02) {
    alertas.push('Beneficio de esperar < 2% del spot: puede no valer la pena por riesgo.');
  }

  return {
    parametros: p,
    resultado: {
      valorPrincipal: idxMax,
      unidad: 'meses de espera',
      interpretacion:
        idxMax === 0
          ? `Vender ya. Neto USD ${netoSpot.toFixed(2)}/t.`
          : `Esperar ${idxMax} meses. Neto máximo USD ${maxN.toFixed(2)}/t (mejora +USD ${beneficioEsperar.toFixed(2)}/t sobre el spot).`,
    },
    curva: {
      labelX: 'meses de espera',
      labelY: 'neto USD/t',
      unidadY: 'USD/t',
      puntos: curva,
      optimo: { indice: idxMax, texto: `óptimo mes ${idxMax}` },
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      idxMax === 0
        ? 'Vender la totalidad ahora.'
        : `Retener ${idxMax} meses; escalonar ventas para diluir riesgo de precio.`,
  };
}
