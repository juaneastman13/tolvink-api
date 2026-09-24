/**
 * Estrategia de compra anticipada de insumos.
 *
 * Modelo: comparar el "todo-in" hoy contra el "todo-in" al momento de uso,
 * ponderando por el costo de oportunidad del dinero inmovilizado.
 *
 *   costoHoy(qty)    = qty · precioHoy
 *   costoDespues(qty)= qty · precioEsperado
 *   penalidad_CO     = costoHoy · tasaAnual · (mesesHastaUso / 12)
 *
 *   Δahorro          = costoDespues − (costoHoy + penalidad_CO)
 *
 *   Δahorro > 0 → conviene anticipar. Ratio de ahorro por peso invertido:
 *   `roiAnticipar = Δahorro / costoHoy`.
 *
 * Escenarios variando el precio esperado (0.85..1.15 del spot).
 */

import { DecisionResultado, Escenario, ESCENARIOS, Punto } from './tipos';

export interface CompraInsumosParams {
  cantidad: number; // unidades a comprar (t, kg, dosis, según el insumo)
  precioHoyUsdUn: number;
  precioEsperadoUsdUn: number; // proyección
  mesesHastaUso: number;
  tasaAnualCO: number;
  escenario?: Escenario;
}

function ahorroNeto(p: CompraInsumosParams, precioEsperado: number, mult = ESCENARIOS.BASE): number {
  const costoHoy = p.cantidad * p.precioHoyUsdUn * mult.costoInsumos;
  const costoDespues = p.cantidad * precioEsperado * mult.costoInsumos;
  const co = costoHoy * p.tasaAnualCO * (p.mesesHastaUso / 12);
  return costoDespues - (costoHoy + co);
}

export function calcularCompraInsumos(
  p: CompraInsumosParams,
): DecisionResultado<CompraInsumosParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const delta = ahorroNeto(p, p.precioEsperadoUsdUn, mult);
  const costoHoy = p.cantidad * p.precioHoyUsdUn * mult.costoInsumos;
  const roi = costoHoy > 0 ? delta / costoHoy : 0;

  // Curva del ahorro neto por precio esperado (útil para intuir el punto de indiferencia).
  const curva: Punto[] = [];
  const min = p.precioHoyUsdUn * 0.8;
  const max = p.precioHoyUsdUn * 1.25;
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const pe = min + ((max - min) * i) / steps;
    curva.push({
      x: Math.round(pe * 10000) / 10000,
      y: Math.round(ahorroNeto(p, pe, mult) * 100) / 100,
    });
  }
  // Precio de indiferencia (Δ=0): p_esperado_ind = precioHoy · (1 + tasa · meses/12)
  const precioIndiferencia = p.precioHoyUsdUn * (1 + p.tasaAnualCO * (p.mesesHastaUso / 12));

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = Math.round(ahorroNeto(p, p.precioEsperadoUsdUn, ESCENARIOS[e]) * 100) / 100;
  }

  const alertas: string[] = [];
  if (delta <= 0)
    alertas.push('El ahorro esperado no supera el costo de oportunidad: mejor esperar.');
  if (p.mesesHastaUso > 6)
    alertas.push('Anticipar más de 6 meses tiene alto riesgo de sesgo de precio.');
  if (p.precioEsperadoUsdUn <= p.precioHoyUsdUn)
    alertas.push('Estás asumiendo que el precio va a BAJAR o quedar igual: revisá la lógica.');

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(delta * 100) / 100,
      unidad: 'USD ahorro neto',
      interpretacion:
        delta > 0
          ? `Anticipar la compra ahorra USD ${delta.toFixed(2)} (ROI ${(roi * 100).toFixed(1)}%). Indiferencia: precio esperado ≥ ${precioIndiferencia.toFixed(3)} USD/un.`
          : `NO conviene anticipar: el precio esperado (${p.precioEsperadoUsdUn}) está por debajo del punto de indiferencia (${precioIndiferencia.toFixed(3)}).`,
    },
    curva: {
      labelX: 'precio esperado',
      labelY: 'ahorro neto USD',
      unidadY: 'USD',
      puntos: curva,
      optimo: null,
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      delta > 0
        ? `Comprar ahora ${p.cantidad} u. Indiferencia: precio ≥ ${precioIndiferencia.toFixed(3)}.`
        : `Esperar. Reevaluar cuando el precio spot supere ${precioIndiferencia.toFixed(3)}.`,
  };
}
