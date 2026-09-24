/**
 * Comprar vs contratar maquinaria (§5.4 y §6.2).
 *
 * Modelo:
 *   costoPropioAnual  = amortización + costo fijo + costo variable · ha
 *                     = precioCompra/vidaAnos + costoFijoAnual + costoVarUsdHa · ha
 *   costoContratado   = tarifaContratistaUsdHa · ha
 *
 *   diferencia(ha)    = costoPropioAnual − costoContratado
 *   ha_indiferencia   = (precioCompra/vidaAnos + costoFijo) / (tarifaContratista − costoVarUsdHa)
 *
 * Se compara además el VAN de la compra contra pagar contratista año a año
 * durante la vida útil, todo descontado a `tasaDescuento`.
 */

import { DecisionResultado, Escenario, ESCENARIOS, Punto } from './tipos';
import { van } from './van-pasturas';

export interface MaquinariaParams {
  precioCompraUsd: number;
  vidaAnos: number;
  valorResidualUsd?: number; // por default 15% de la compra
  costoFijoAnualUsd: number; // mant., seguros, cochera
  costoVarUsdHa: number; // combustible, aceite, filtro, reparaciones ordinarias
  tarifaContratistaUsdHa: number;
  haEsperadasAnuales: number;
  tasaDescuento: number;
  escenario?: Escenario;
}

function residual(p: MaquinariaParams): number {
  return p.valorResidualUsd ?? p.precioCompraUsd * 0.15;
}

function haIndiferencia(p: MaquinariaParams): number {
  const amort = (p.precioCompraUsd - residual(p)) / p.vidaAnos;
  const denom = p.tarifaContratistaUsdHa - p.costoVarUsdHa;
  if (denom <= 0) return Infinity;
  return (amort + p.costoFijoAnualUsd) / denom;
}

function flujosPropio(p: MaquinariaParams, mult = ESCENARIOS.BASE): number[] {
  const flujos: number[] = [-p.precioCompraUsd];
  for (let y = 1; y <= p.vidaAnos; y++) {
    const costo = p.costoFijoAnualUsd * mult.costoInsumos
      + p.costoVarUsdHa * p.haEsperadasAnuales * mult.costoInsumos;
    let ingresoAhorro = p.tarifaContratistaUsdHa * p.haEsperadasAnuales * mult.precio;
    // Últ año: recupero residual
    if (y === p.vidaAnos) ingresoAhorro += residual(p);
    flujos.push(ingresoAhorro - costo);
  }
  return flujos;
}

export function calcularMaquinaria(p: MaquinariaParams): DecisionResultado<MaquinariaParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const flujos = flujosPropio(p, mult);
  const vanCompra = van(flujos, p.tasaDescuento);
  const haInd = haIndiferencia(p);

  // Curva costo/ha propio vs contratado en función de ha anuales.
  const curva: Punto[] = [];
  const haIndFinito = Number.isFinite(haInd) ? haInd : 0;
  const haMax = Math.max(haIndFinito * 2, p.haEsperadasAnuales * 2, 100);
  const step = Math.max(5, haMax / 40);
  const amort = (p.precioCompraUsd - residual(p)) / p.vidaAnos;
  for (let ha = 10; ha <= haMax; ha += step) {
    const costoPropio = (amort + p.costoFijoAnualUsd) / ha + p.costoVarUsdHa;
    const costoContrat = p.tarifaContratistaUsdHa;
    curva.push({
      x: Math.round(ha),
      y: Math.round(costoPropio * 100) / 100,
      meta: { contratista: costoContrat },
    });
  }

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = Math.round(van(flujosPropio(p, ESCENARIOS[e]), p.tasaDescuento) * 100) / 100;
  }

  const alertas: string[] = [];
  if (haInd === Infinity) {
    alertas.push('Costo variable propio ≥ tarifa contratista: comprar no baja el costo variable.');
  }
  if (p.haEsperadasAnuales < haInd) {
    alertas.push(
      `Ha esperadas (${p.haEsperadasAnuales}) por debajo del punto de indiferencia (${haInd.toFixed(0)} ha).`,
    );
  }
  if (vanCompra < 0) alertas.push('VAN de compra negativo a la tasa indicada.');

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(haInd),
      unidad: 'ha/año (indiferencia)',
      interpretacion:
        haInd === Infinity
          ? 'Comprar no baja el costo por ha (var. propio ≥ tarifa).'
          : `A partir de ${haInd.toFixed(0)} ha/año conviene la máquina propia. VAN de compra: USD ${vanCompra.toFixed(0)}.`,
    },
    curva: {
      labelX: 'hectáreas/año',
      labelY: 'costo por ha',
      unidadY: 'USD/ha',
      puntos: curva,
      optimo: null,
    },
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      p.haEsperadasAnuales >= haInd && vanCompra >= 0
        ? 'Comprar: opera por encima del punto de indiferencia y el VAN es positivo.'
        : 'Contratar: el volumen anual esperado no justifica la inversión.',
  };
}
