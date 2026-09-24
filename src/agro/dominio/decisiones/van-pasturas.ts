/**
 * Inversión en pasturas — VAN y TIR.
 *
 * Modelo:
 *   Año 0: pago de siembra (implantación) = `inversionUsdHa` (con signo −).
 *   Años 1..vidaAnos: ingreso extra = `kgIncrementalesHaAno · precioUsdKg`.
 *   Costos anuales de mantenimiento opcional.
 *
 *   VAN = Σ FF_t / (1+r)^t
 *   TIR = raíz de VAN(r) = 0 (bisección)
 *   Recupero descontado: primer año en que Σ FF_desc ≥ 0
 *
 * Tabla de doble entrada (§6.2): VAN por (kg incrementales × precio).
 */

import { DecisionResultado, Escenario, ESCENARIOS, Punto } from './tipos';
import { rango, tablaDobleEntrada } from './matriz';

export interface VanPasturasParams {
  inversionUsdHa: number;
  vidaAnos: number; // ej. 4
  kgIncrementalesHaAno: number; // kg carne extra por ha por año
  precioUsdKg: number; // USD/kg carne
  costoManteUsdHaAno?: number;
  tasaDescuento: number; // 0.08 = 8%
  escenario?: Escenario;
}

function flujosAnuales(p: VanPasturasParams, mult = ESCENARIOS.BASE): number[] {
  const flujos: number[] = [-p.inversionUsdHa];
  for (let y = 1; y <= p.vidaAnos; y++) {
    const ingreso = p.kgIncrementalesHaAno * mult.rinde * p.precioUsdKg * mult.precio;
    const costo = (p.costoManteUsdHaAno ?? 0) * mult.costoInsumos;
    flujos.push(ingreso - costo);
  }
  return flujos;
}

export function van(flujos: number[], r: number): number {
  let v = 0;
  for (let t = 0; t < flujos.length; t++) v += flujos[t] / Math.pow(1 + r, t);
  return v;
}

export function tir(flujos: number[]): number | null {
  // Bisección; buscamos raíz en [-0.9, 5].
  let lo = -0.9;
  let hi = 5.0;
  const fLo = van(flujos, lo);
  const fHi = van(flujos, hi);
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;
  if (fLo * fHi > 0) {
    // Sin cambio de signo en el intervalo estándar: puede no existir TIR.
    return null;
  }
  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    const fm = van(flujos, mid);
    if (Math.abs(fm) < 1e-6) return mid;
    if (fLo * fm < 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

function recuperoDescontado(flujos: number[], r: number): number | null {
  let acum = 0;
  for (let t = 0; t < flujos.length; t++) {
    acum += flujos[t] / Math.pow(1 + r, t);
    if (acum >= 0 && t > 0) return t;
  }
  return null;
}

export function calcularVanPasturas(
  p: VanPasturasParams,
): DecisionResultado<VanPasturasParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const flujos = flujosAnuales(p, mult);
  const vanBase = van(flujos, p.tasaDescuento);
  const tirBase = tir(flujos);
  const recupero = recuperoDescontado(flujos, p.tasaDescuento);

  // Curva de VAN vs tasa (interesante visualmente y para intuir la TIR).
  const curva: Punto[] = [];
  for (let r = 0; r <= 0.4; r += 0.01) {
    curva.push({ x: Math.round(r * 1000) / 1000, y: Math.round(van(flujos, r) * 100) / 100 });
  }

  // Tabla doble entrada: VAN por (kg incrementales × precio).
  const kgs = rango(p.kgIncrementalesHaAno * 0.6, p.kgIncrementalesHaAno * 1.4, 5);
  const precios = rango(p.precioUsdKg * 0.75, p.precioUsdKg * 1.25, 5);
  const matriz = tablaDobleEntrada(
    'Precio USD/kg',
    'kg incrementales/ha/año',
    precios,
    kgs,
    (px, ky) => van(flujosAnuales({ ...p, kgIncrementalesHaAno: ky, precioUsdKg: px }, mult), p.tasaDescuento),
    'VAN USD/ha',
  );

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = Math.round(van(flujosAnuales(p, ESCENARIOS[e]), p.tasaDescuento) * 100) / 100;
  }

  const alertas: string[] = [];
  if (vanBase < 0) alertas.push('VAN negativo: la inversión no se paga a la tasa de descuento indicada.');
  if (tirBase !== null && tirBase < p.tasaDescuento) {
    alertas.push('TIR por debajo de la tasa de descuento.');
  }
  if (!recupero) alertas.push('No hay período de recupero dentro de la vida útil.');

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(vanBase * 100) / 100,
      unidad: 'USD/ha',
      interpretacion:
        vanBase >= 0
          ? `Invertir CONVIENE. VAN USD ${vanBase.toFixed(0)}/ha; TIR ${tirBase !== null ? (tirBase * 100).toFixed(1) + '%' : 'n/a'}${recupero ? `; recupero año ${recupero}` : ''}.`
          : `Invertir NO conviene a esta tasa. VAN USD ${vanBase.toFixed(0)}/ha.`,
    },
    curva: {
      labelX: 'tasa descuento',
      labelY: 'VAN USD/ha',
      unidadY: 'USD/ha',
      puntos: curva,
      optimo: tirBase !== null ? { indice: Math.round(tirBase * 100), texto: `TIR ${(tirBase * 100).toFixed(1)}%` } : null,
    },
    matriz,
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      vanBase >= 0
        ? `Adelante: VAN positivo (${vanBase.toFixed(0)} USD/ha) con TIR ${tirBase !== null ? (tirBase * 100).toFixed(1) + '%' : 'n/a'}.`
        : 'Postergar la inversión o buscar mejor precio de implantación.',
  };
}
