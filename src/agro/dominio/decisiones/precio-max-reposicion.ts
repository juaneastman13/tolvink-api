/**
 * Precio máximo de reposición.
 *
 * Pregunta: ¿cuánto puedo pagar HOY por un animal de reposición sin perder
 * plata dado un plan de venta futuro?
 *
 * Modelo:
 *   ingresoVenta   = kgVenta · precioVentaUsdKg
 *   costoGanancia  = (kgVenta − kgCompra) · costoUsdKgGanado
 *   costoOportun   = X · tasaAnual · dias/365      (X = compra máxima)
 *   margen obj.    = kgVenta · margenObjetivoUsdKg (opcional)
 *
 *   X · kgCompra + costoGanancia + margen + X·tasa·dias/365 = ingresoVenta
 *
 *   ⇒ X = (ingresoVenta − costoGanancia − margen) / (kgCompra + kgCompra·tasa·dias/365)
 *
 * Tabla de doble entrada: X en función de (precioVenta, kgVenta).
 */

import {
  Escenario,
  ESCENARIOS,
  DecisionResultado,
  n,
} from './tipos';
import { rango, tablaDobleEntrada } from './matriz';

export interface PrecioMaxParams {
  kgCompra: number;
  kgVenta: number;
  diasEngorde: number;
  precioVentaUsdKg: number;
  costoUsdKgGanado: number;
  tasaAnualCO: number;
  margenObjetivoUsdKg?: number; // USD/kg vendido que quiero de margen
  escenario?: Escenario;
}

function precioMaxUsdKg(p: PrecioMaxParams, precioVenta: number, kgVenta: number): number {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const ingreso = kgVenta * precioVenta * mult.precio;
  const costoGanancia = Math.max(0, kgVenta - p.kgCompra) * p.costoUsdKgGanado * mult.costoInsumos;
  const margen = kgVenta * (p.margenObjetivoUsdKg ?? 0);
  const factor = p.kgCompra * (1 + p.tasaAnualCO * (p.diasEngorde / 365));
  if (factor <= 0) return 0;
  return (ingreso - costoGanancia - margen) / factor;
}

export function calcularPrecioMaxReposicion(
  p: PrecioMaxParams,
): DecisionResultado<PrecioMaxParams> {
  const base = precioMaxUsdKg(p, p.precioVentaUsdKg, p.kgVenta);

  const preciosX = rango(p.precioVentaUsdKg * 0.75, p.precioVentaUsdKg * 1.25, 7);
  const kgsY = rango(p.kgVenta * 0.85, p.kgVenta * 1.15, 5);
  const matriz = tablaDobleEntrada(
    'Precio venta USD/kg',
    'Kg de venta',
    preciosX,
    kgsY,
    (px, ky) => precioMaxUsdKg(p, px, ky),
    'USD/kg compra',
  );

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = n(precioMaxUsdKg({ ...p, escenario: e }, p.precioVentaUsdKg, p.kgVenta), 4);
  }

  const alertas: string[] = [];
  if (base <= 0) alertas.push('El costo previsto supera el ingreso: no hay margen para reposición.');
  if (base > p.precioVentaUsdKg) {
    alertas.push('El precio máximo de compra excede el precio de venta: revisá kg de compra y engorde.');
  }

  return {
    parametros: p,
    resultado: {
      valorPrincipal: n(base, 4),
      unidad: 'USD/kg vivo (compra)',
      interpretacion: `Podés pagar hasta USD ${base.toFixed(3)}/kg vivo de reposición para cerrar con el margen objetivo.`,
    },
    matriz,
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      base <= 0
        ? 'Con estos supuestos no conviene reponer: bajá kg de compra o esperá mejores precios.'
        : `Fijá el techo de compra en ~USD ${base.toFixed(3)}/kg vivo.`,
  };
}
