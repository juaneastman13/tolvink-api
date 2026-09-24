/**
 * Momento óptimo de venta (hacienda).
 *
 * Modelo: valor de un animal al día `t` desde hoy
 *   kg(t)          = kgActual + gmd · t
 *   ingreso(t)     = kg(t) · precio(kg(t))
 *   costoAcum(t)   = kgGanado(t) · costoUsdKgGanado
 *   costoOportun(t)= valorActual · tasaAnual · (t / 365)
 *   valor(t)       = ingreso(t) − costoAcum(t) − costoOportun(t)
 *
 * El óptimo es el `t` que maximiza `valor(t)` en la ventana [0, díasMax].
 *
 * Precio por kg puede depender del peso (escalones típicos gordo/rechazo/
 * novillo mayor). Se pasa como función escalonada.
 */

import { EscenarioMult, ESCENARIOS, Escenario, DecisionResultado, Punto } from './tipos';

export interface MomentoVentaParams {
  kgActual: number;
  gmdKgDia: number;
  /** Precio USD/kg vivo por tramo: [{kgHasta, precio}, ...] ordenado ascendente. */
  escalaPrecio: Array<{ kgHasta: number; precioUsdKg: number }>;
  costoUsdKgGanado: number;
  tasaAnualCO: number; // 0.05 = 5%
  diasMax: number; // ventana de análisis (ej. 240)
  pasoDias: number; // ej. 7 → puntos cada 7 días
  escenario?: Escenario;
}

const clampPrecio = (kg: number, escala: MomentoVentaParams['escalaPrecio']): number => {
  // Ordenamos y elegimos el primer tramo cuyo kgHasta >= kg.
  const ordenada = [...escala].sort((a, b) => a.kgHasta - b.kgHasta);
  for (const t of ordenada) {
    if (kg <= t.kgHasta) return t.precioUsdKg;
  }
  return ordenada[ordenada.length - 1]?.precioUsdKg ?? 0;
};

function valorDia(t: number, p: MomentoVentaParams, mult: EscenarioMult): number {
  const gmd = p.gmdKgDia * mult.gmd;
  const kg = p.kgActual + gmd * t;
  const precio = clampPrecio(kg, p.escalaPrecio) * mult.precio;
  const ingreso = kg * precio;
  const kgGan = Math.max(0, kg - p.kgActual);
  const costo = kgGan * p.costoUsdKgGanado * mult.costoInsumos;
  const valorHoy = p.kgActual * clampPrecio(p.kgActual, p.escalaPrecio);
  const co = valorHoy * p.tasaAnualCO * (t / 365);
  return ingreso - costo - co;
}

export function calcularMomentoVenta(p: MomentoVentaParams): DecisionResultado<MomentoVentaParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const puntos: Punto[] = [];
  let maxV = -Infinity;
  let idxMax = 0;
  for (let t = 0; t <= p.diasMax; t += p.pasoDias) {
    const v = valorDia(t, p, mult);
    puntos.push({
      x: t,
      y: Math.round(v * 100) / 100,
      meta: {
        kg: Math.round((p.kgActual + p.gmdKgDia * mult.gmd * t) * 10) / 10,
      },
    });
    if (v > maxV) {
      maxV = v;
      idxMax = puntos.length - 1;
    }
  }

  // Corrida por escenario para comparar el pico.
  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    let mv = -Infinity;
    for (let t = 0; t <= p.diasMax; t += p.pasoDias) {
      const v = valorDia(t, p, ESCENARIOS[e]);
      if (v > mv) mv = v;
    }
    escenariosOut[e] = Math.round(mv * 100) / 100;
  }

  const diasOptimo = puntos[idxMax].x as number;
  const alertas: string[] = [];
  if (diasOptimo === 0) alertas.push('El óptimo es HOY: cualquier día extra reduce el valor.');
  if (diasOptimo >= p.diasMax) {
    alertas.push('El óptimo cae en el borde de la ventana; ampliá `diasMax` para verificar.');
  }
  const kgOptimo = p.kgActual + p.gmdKgDia * mult.gmd * diasOptimo;

  return {
    parametros: p,
    resultado: {
      valorPrincipal: diasOptimo,
      unidad: 'días',
      interpretacion: `Vender en ~${diasOptimo} días (peso estimado ${kgOptimo.toFixed(0)} kg) maximiza el valor por cabeza en USD ${maxV.toFixed(2)}.`,
    },
    curva: {
      labelX: 'días desde hoy',
      labelY: 'valor por cabeza (USD)',
      unidadY: 'USD/cab',
      puntos,
      optimo: { indice: idxMax, texto: `óptimo día ${diasOptimo}` },
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      diasOptimo === 0
        ? 'Vender ya: seguir engordando destruye valor.'
        : `Retener ~${diasOptimo} días más y vender a ${kgOptimo.toFixed(0)} kg.`,
  };
}
