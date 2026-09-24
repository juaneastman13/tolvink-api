/**
 * §5.3 — Valuación de inventarios y separación de efectos.
 *
 * Reglas:
 *   - "Valor de mercado" = **valor neto en campo** (precio referencia
 *     − flete − comisión). Nunca precio bruto.
 *   - Toda variación de valor de inventario se separa en:
 *       · **Efecto físico / productivo**: kg producidos por mérito productivo.
 *         Va al resultado operativo.
 *       · **Efecto precio / tenencia**: variación de mercado.
 *         Se muestra APARTE del resultado operativo.
 *   - Cultivos en pie al cierre: activo "Cultivos en crecimiento" a **costo incurrido**
 *     (no a valor de mercado).
 *   - Grano cosechado en stock al cierre: valuado a valor neto en campo a la fecha
 *     de cierre. Si se vende después, la diferencia entre precio de venta y valor
 *     al cierre va a **tenencia del ejercicio siguiente**.
 *
 * Fórmula de la separación:
 *   ΔValor  = ValorFinal − ValorInicial + Ventas − Compras
 *   EfectoFísico  = (KgFinal − KgInicial + KgVendido − KgComprado) × PrecioInicial
 *   EfectoPrecio  = KgFinal × (PrecioFinal − PrecioInicial)
 *   (con la convención de que Δ Valor = EfectoFísico + EfectoPrecio, salvo
 *    redondeos)
 *
 * Notas:
 *   - Estas funciones trabajan con "kg" pero la unidad puede ser cualquier
 *     magnitud homogénea (cabezas, toneladas): el consumidor decide.
 */

import { Decimal } from '@prisma/client/runtime/library';

const toDec = (x: Decimal | number | undefined): Decimal =>
  x === undefined ? new Decimal(0) : x instanceof Decimal ? x : new Decimal(x);

export interface PosicionInventario {
  /** Cantidad al inicio del período. */
  kgInicial: Decimal | number;
  /** Precio unitario al inicio (USD/kg o USD/t). Valor neto en campo. */
  precioInicial: Decimal | number;
  /** Cantidad al final del período. */
  kgFinal: Decimal | number;
  /** Precio unitario al final (valor neto en campo a la fecha de cierre). */
  precioFinal: Decimal | number;
  /** Kg comprados durante el período (compras y nacimientos). */
  kgComprado?: Decimal | number;
  /** Kg vendidos durante el período (ventas y muertes). */
  kgVendido?: Decimal | number;
  /** Costo total de las compras (para bookkeeping; no afecta descomposición). */
  costoCompras?: Decimal | number;
  /** Ingresos totales por ventas (idem). */
  ingresoVentas?: Decimal | number;
}

export interface DescomposicionValor {
  valorInicial: Decimal;
  valorFinal: Decimal;
  /** Cambio total de valor + ventas − compras (variación neta de inventario). */
  variacionNeta: Decimal;
  /** Va al resultado operativo. */
  efectoFisico: Decimal;
  /** Se muestra aparte (§5.3). */
  efectoPrecio: Decimal;
}

/**
 * Separa la variación de valor en efecto físico y efecto precio.
 *
 * `variacionNeta = valorFinal − valorInicial + ingresoVentas − costoCompras`
 * (cuando `ingresoVentas`/`costoCompras` no se pasan, se computa
 *  `variacionNeta = valorFinal − valorInicial`).
 *
 * `efectoFisico = ΔKg × precioInicial`  con ΔKg = kgFinal − kgInicial + kgVendido − kgComprado
 * `efectoPrecio = kgFinal × (precioFinal − precioInicial)`
 */
export function descomponerValor(p: PosicionInventario): DescomposicionValor {
  const kgI = toDec(p.kgInicial);
  const pI = toDec(p.precioInicial);
  const kgF = toDec(p.kgFinal);
  const pF = toDec(p.precioFinal);
  const kgC = toDec(p.kgComprado);
  const kgV = toDec(p.kgVendido);
  const costoC = toDec(p.costoCompras);
  const ingresoV = toDec(p.ingresoVentas);

  const valorInicial = kgI.mul(pI);
  const valorFinal = kgF.mul(pF);

  const variacionNeta = valorFinal.minus(valorInicial).plus(ingresoV).minus(costoC);

  // ΔKg productivo = (final − inicial) + vendido − comprado
  //   (kg que la unidad "produjo" internamente: nacimientos, ganancia de peso,
  //    o cosecha, netos de compras)
  const deltaKgProd = kgF.minus(kgI).plus(kgV).minus(kgC);
  const efectoFisico = deltaKgProd.mul(pI);

  const efectoPrecio = kgF.mul(pF.minus(pI));

  const round = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_EVEN);

  return {
    valorInicial: round(valorInicial),
    valorFinal: round(valorFinal),
    variacionNeta: round(variacionNeta),
    efectoFisico: round(efectoFisico),
    efectoPrecio: round(efectoPrecio),
  };
}

/**
 * Valor de mercado = precio bruto − flete − comisión. Nunca el bruto.
 */
export function valorNetoEnCampo(
  precioReferencia: Decimal | number,
  flete: Decimal | number = 0,
  comision: Decimal | number = 0,
): Decimal {
  const bruto = toDec(precioReferencia);
  const f = toDec(flete);
  const c = toDec(comision);
  if (bruto.lte(0)) throw new RangeError('precioReferencia debe ser > 0');
  const neto = bruto.minus(f).minus(c);
  if (neto.lte(0)) {
    throw new RangeError(
      `Neto en campo ≤ 0 (bruto ${bruto} − flete ${f} − comisión ${c})`,
    );
  }
  return neto.toDecimalPlaces(4, Decimal.ROUND_HALF_EVEN);
}
