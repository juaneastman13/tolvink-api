/**
 * Renta máxima que puedo pagar sin romper el margen objetivo.
 *
 *   ingresoUsdHa    = rinde · precio
 *   costoDirectoUsdHa
 *   margenObjetivoUsdHa
 *
 *   rentaMaxUsdHa   = ingresoUsdHa − costoDirectoUsdHa − margenObjetivoUsdHa
 *
 * Tabla doble entrada: renta máxima por (rinde × precio).
 */

import { DecisionResultado, Escenario, ESCENARIOS } from './tipos';
import { rango, tablaDobleEntrada } from './matriz';

export interface RentaMaxParams {
  rindeThaEsperado: number;
  precioUsdT: number;
  costoDirectoUsdHa: number;
  margenObjetivoUsdHa: number;
  escenario?: Escenario;
}

function rentaMax(p: RentaMaxParams, rinde: number, precio: number, mult = ESCENARIOS.BASE): number {
  const ingreso = rinde * mult.rinde * precio * mult.precio;
  const costo = p.costoDirectoUsdHa * mult.costoInsumos;
  return ingreso - costo - p.margenObjetivoUsdHa;
}

export function calcularRentaMax(p: RentaMaxParams): DecisionResultado<RentaMaxParams> {
  const mult = ESCENARIOS[p.escenario ?? 'BASE'];
  const base = rentaMax(p, p.rindeThaEsperado, p.precioUsdT, mult);

  const rindesY = rango(p.rindeThaEsperado * 0.7, p.rindeThaEsperado * 1.3, 5);
  const preciosX = rango(p.precioUsdT * 0.75, p.precioUsdT * 1.25, 7);
  const matriz = tablaDobleEntrada(
    'Precio USD/t',
    'Rinde t/ha',
    preciosX,
    rindesY,
    (px, ky) => rentaMax(p, ky, px, mult),
    'USD/ha',
  );

  const escenariosOut: Record<Escenario, number> = { PESIMISTA: 0, BASE: 0, OPTIMISTA: 0, SECA: 0 };
  for (const e of ['PESIMISTA', 'BASE', 'OPTIMISTA', 'SECA'] as Escenario[]) {
    escenariosOut[e] = Math.round(rentaMax(p, p.rindeThaEsperado, p.precioUsdT, ESCENARIOS[e]) * 100) / 100;
  }

  const alertas: string[] = [];
  if (base <= 0)
    alertas.push('La renta máxima queda ≤ 0: no cierra pagar ninguna renta con el margen pedido.');
  if (escenariosOut.SECA < 0 && base > 0)
    alertas.push('En escenario "seca" la renta pactada quema el margen; considerar un tope contingente.');

  return {
    parametros: p,
    resultado: {
      valorPrincipal: Math.round(base * 100) / 100,
      unidad: 'USD/ha',
      interpretacion:
        base > 0
          ? `Podés pagar hasta USD ${base.toFixed(0)}/ha de renta y mantener USD ${p.margenObjetivoUsdHa}/ha de margen.`
          : 'Los supuestos no permiten pagar renta alguna manteniendo el margen objetivo.',
    },
    matriz,
    escenarios: escenariosOut,
    alertas,
    recomendacion:
      base > 0
        ? `Fijar techo de negociación en USD ${(base * 0.9).toFixed(0)}/ha (10% de colchón sobre el máximo).`
        : 'Buscar campos con renta más baja o subir productividad esperada.',
  };
}
