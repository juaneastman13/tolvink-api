/**
 * Escenario dorado "Cruz Del Sur" — un ejercicio completo integrando todas
 * las reglas de §5 y §6, sin dependencia de Prisma. Los números son los
 * "esperados" que reemplazan al Excel de referencia que el brief pedía.
 *
 * Diseño del establecimiento:
 *   - 1000 ha totales: 600 ha agrícola (300 soja + 200 trigo + 100 soja 2ª),
 *     400 ha ganadería (250 cría + 150 recría).
 *   - Cría: 300 vacas + 12 toros. 80% preñez → 240 terneros/as, 220 destetes.
 *   - Recría: 200 cabezas mixtas 1-3 años.
 *   - Feedlot: 1 tanda de 100 novillos, 90 días.
 *   - Renta ficta: 250 USD/ha × 1000 ha = 250 000 USD.
 *   - Precios base fijos: carne 2.5 USD/kg vivo, soja 320 USD/t, trigo 220 USD/t.
 *
 * Este archivo NO depende de la base de datos. Prueba la cadena
 * físico→precio→económico→desvíos y las funciones de §5 con números
 * concretos y verificables a mano.
 */

import { Decimal } from '@prisma/client/runtime/library';
import { calcularAsientoFeedlot } from '../dominio/transferencia-grano';
import { calcularTanda } from '../dominio/feedlot';
import { descomponerValor, valorNetoEnCampo } from '../dominio/valuacion';
import {
  consolidarMaquinariaTarifa,
  repartirPorPorcentaje,
} from '../dominio/costos-compartidos';
import {
  clasificarCampania,
} from '../dominio/campania';
import { vistaEmpresa, vistaNegocios } from '../dominio/resultado-empresa';
import { kgCarneEquivalente, tSojaEquivalente } from '../dominio/equivalencias';
import { calcularDesvio, pasaUmbral } from '../dominio/desvio';
import { calcularEconomico, totalizarPorCentro } from '../dominio/presupuesto';
import { proyectarCaja } from '../dominio/caja';

const d = (iso: string) => new Date(iso + 'T00:00:00Z');

const CFG = {
  mesInicioEjercicio: 1, // ejercicio calendario
  cierreIntermedioMes: 6, // 30/06 DICOSE
  cierreIntermedioDia: 30,
} as const;

const PRECIOS_BASE = {
  pBaseCarne: 2.5, // USD/kg vivo
  pBaseSoja: 320, // USD/t
  pBaseTrigo: 220, // USD/t
};

describe('Escenario Cruz Del Sur — ejercicio 2025 completo', () => {
  // ── 1. AGRICULTURA — 300 ha de soja 1ª ──────────────────────────

  it('Soja 1ª: MB por ha = ingreso − costo directo', () => {
    // Rinde 2.8 t/ha × 300 ha = 840 t
    // Precio referencia 340 USD/t, flete 20, comisión 8 → neto 312 USD/t
    const neto = valorNetoEnCampo(340, 20, 8);
    expect(neto.toString()).toBe('312');
    const ingreso = new Decimal(840).mul(neto);
    // 840 × 312 = 262 080
    expect(ingreso.toString()).toBe('262080');

    // Costo directo por ha: semilla 65 + fert 90 + agroq 55 + labores 80 + cosecha 45 = 335 USD/ha
    // 335 × 300 = 100 500
    const costoDirecto = new Decimal(335).mul(300);
    // Renta ficta 250 USD/ha × 300 ha = 75 000
    const renta = new Decimal(250).mul(300);
    // MB después de tierra = 262 080 − 100 500 − 75 000 = 86 580
    const mb = ingreso.minus(costoDirecto).minus(renta);
    expect(mb.toString()).toBe('86580');
    // MB/ha = 288.60
    expect(mb.div(300).toDecimalPlaces(2).toString()).toBe('288.6');
  });

  // ── 2. §5.2 — Transferencia interna al feedlot ──────────────────

  it('Grano propio al feedlot: asiento gemelo AGR/FEED', () => {
    // 200 t de soja al feedlot, precio ref 340 − flete 20 − comisión 8 = 312 USD/t
    const asiento = calcularAsientoFeedlot({
      toneladas: 200,
      precioReferenciaUsdT: 340,
      fleteUsdT: 20,
      comisionUsdT: 8,
    });
    // Importe = 200 × 312 = 62 400
    expect(asiento.importeUsd.toString()).toBe('62400');
    expect(asiento.ingresoAgricultura.eq(asiento.costoFeedlot)).toBe(true);
  });

  // ── 3. §5.9 — Feedlot 1 tanda 100 novillos, 90 días ─────────────

  it('Tanda feedlot: GMD, conversión, breakeven', () => {
    const t = calcularTanda({
      cabezas: 100,
      fechaIngreso: d('2025-04-01'),
      fechaSalida: d('2025-06-30'),
      // Entra 280 kg × 100 = 28 000; sale 420 kg × 100 = 42 000
      kgEntradaTotal: 28000,
      kgSalidaTotal: 42000,
      // Consumo MS: 12 kg/cab/día × 100 × 90 = 108 000 kg
      kgMsConsumidos: 108000,
      // Costos: transferencia grano 62 400 + sanidad 3 000 + personal 8 000 + otros 6 000 = 79 400
      costoTotalUsd: 79400,
      // Ingreso: 420 kg × 100 × 2.30 USD/kg = 96 600
      ingresoTotalUsd: 96600,
    });
    expect(t.diasEncierre).toBe(90);
    expect(t.kgGanadosTotales.toString()).toBe('14000');
    // GMD = 14000 / 100 / 90 = 1.5555... → 1.556
    expect(t.gmdKgDia.toString()).toBe('1.556');
    // Conv = 108000 / 14000 = 7.7142857... → 7.714
    expect(t.conversion.toString()).toBe('7.714');
    // Costo/kg ganado = 79400 / 14000 = 5.671...
    expect(t.costoPorKgGanado.toString()).toBe('5.6714');
    // Margen = 96600 − 79400 = 17200; por cab = 172; por cab/día = 1.9111
    expect(t.margenTotalUsd.toString()).toBe('17200');
    expect(t.margenPorCabezaUsd.toString()).toBe('172');
    expect(t.margenPorCabezaDiaUsd.toString()).toBe('1.9111');
    // Breakeven = costo/cab / kgSalida/cab = 794 / 420 = 1.8905 USD/kg
    expect(t.precioEquilibrioUsdKg.toString()).toBe('1.8905');
  });

  // ── 4. §5.4 — Costos compartidos ────────────────────────────────

  it('Personal compartido 60/40 entre CRI y REC', () => {
    const r = repartirPorPorcentaje(48000, { CRI: 0.6, REC: 0.4 });
    expect(r.asignado.CRI!.toString()).toBe('28800');
    expect(r.asignado.REC!.toString()).toBe('19200');
  });

  it('Maquinaria modo TARIFA con sobrerrecupero', () => {
    // Labores propias facturadas a tarifa contratista: 600 ha × 80 USD/ha = 48000
    // Costo real (comb, mantenimiento, personal MAQ) = 41000
    // Sobrerrecupero = 7000 (indica que tener equipo propio salió más barato)
    const r = consolidarMaquinariaTarifa([{ ingresoTarifa: 48000, costoReal: 41000 }]);
    expect(r.diferencia.toString()).toBe('7000');
  });

  // ── 5. §5.5 — Reconocimiento por ejercicio ──────────────────────

  it('Trigo sembrado 07/2025 cosechado 12/2025 se reconoce en 2025', () => {
    const r = clasificarCampania(
      CFG,
      { fechaCosecha: d('2025-12-05'), costoAcumuladoUsd: 60000, ingresoAcumuladoUsd: 88000 },
      d('2025-12-31'),
    );
    expect(r.ejercicioReconocimiento).toBe(2025);
    expect(r.resultadoUsd.toString()).toBe('28000');
    expect(r.activoCultivosEnPieUsd.toString()).toBe('0');
  });

  it('Soja 2ª sembrada 12/2025 cosechada 04/2026 queda como activo al cierre 12/2025', () => {
    const r = clasificarCampania(
      CFG,
      { fechaCosecha: d('2026-04-15'), costoAcumuladoUsd: 15000, ingresoAcumuladoUsd: 0 },
      d('2025-12-31'),
    );
    expect(r.ejercicioReconocimiento).toBeNull();
    expect(r.activoCultivosEnPieUsd.toString()).toBe('15000');
  });

  // ── 6. §5.3 — Efecto tenencia del stock de hacienda ─────────────

  it('Stock vacas de cría: precio sube 15% en el año → efecto precio +', () => {
    // 300 vacas × 380 kg = 114000 kg (unidad: kg vivo)
    // Precio inicio 2.30 USD/kg; precio fin 2.65 USD/kg
    // Sin variación de kg (stock estable): efecto físico=0, efecto precio=+39900
    const r = descomponerValor({
      kgInicial: 114000,
      precioInicial: 2.3,
      kgFinal: 114000,
      precioFinal: 2.65,
    });
    expect(r.efectoFisico.toString()).toBe('0');
    // 114000 × (2.65 − 2.30) = 114000 × 0.35 = 39900
    expect(r.efectoPrecio.toString()).toBe('39900');
    // efectoTotal en el valor final = valorFinal − valorInicial = 302100 − 262200 = 39900
    expect(r.variacionNeta.toString()).toBe('39900');
  });

  // ── 7. §5.7 — Resultado empresa: dos vistas ─────────────────────

  it('Vista negocios + vista empresa consolidando actividades', () => {
    // Datos consolidados del ejercicio 2025:
    // AGR: ingreso 262 080 (soja) + 88 000 (trigo) + 62 400 (transf feedlot) = 412 480
    //      costo directo 100500 (soja) + 60000 (trigo) + 30000 (soja 2ª→otro año) → sólo 160 500 este año
    //      Renta 60% de 250 000 = 150 000
    // CRI: ingreso 40 000 (venta destetes)
    //      costo directo 55 000; renta 25%×250 000 = 62 500
    // REC: ingreso 65 000; costo directo 45 000; renta 15%×250 000 = 37 500
    // FEED: ingreso 96 600; costo 79 400 (incluye la transferencia interna); renta 0
    const vn = vistaNegocios([
      { centro: 'AGR', ingresosUsd: 412480, costosDirectosUsd: 160500, rentaTierraUsd: 150000 },
      { centro: 'CRI', ingresosUsd: 40000, costosDirectosUsd: 55000, rentaTierraUsd: 62500 },
      { centro: 'REC', ingresosUsd: 65000, costosDirectosUsd: 45000, rentaTierraUsd: 37500 },
      { centro: 'FEED', ingresosUsd: 96600, costosDirectosUsd: 79400, rentaTierraUsd: 0 },
    ]);
    // AGR: 412480 − 160500 − 150000 = 101 980
    // CRI: 40000 − 55000 − 62500 = −77 500  (cría subsidiada por resto)
    // REC: 65000 − 45000 − 37500 = −17 500
    // FEED: 96600 − 79400 − 0 = 17 200
    // Total = 101980 − 77500 − 17500 + 17200 = 24 180
    expect(vn.porCentro[0].mbDespuesTierra.toString()).toBe('101980');
    expect(vn.porCentro[1].mbDespuesTierra.toString()).toBe('-77500');
    expect(vn.porCentro[3].mbDespuesTierra.toString()).toBe('17200');
    expect(vn.totalMbDespuesTierra.toString()).toBe('24180');

    const ve = vistaEmpresa({
      margenes: [
        { centro: 'AGR', ingresosUsd: 412480, costosDirectosUsd: 160500, rentaTierraUsd: 150000 },
        { centro: 'CRI', ingresosUsd: 40000, costosDirectosUsd: 55000, rentaTierraUsd: 62500 },
        { centro: 'REC', ingresosUsd: 65000, costosDirectosUsd: 45000, rentaTierraUsd: 37500 },
        { centro: 'FEED', ingresosUsd: 96600, costosDirectosUsd: 79400, rentaTierraUsd: 0 },
      ],
      rentaFictaTotalUsd: 250000, // 150+62.5+37.5 = 250
      resultadoMaqUsd: 7000, // sobrerrecupero MAQ
      estructuraNoAsignadaUsd: 22000, // admin + asesor + impuestos
      amortizacionesNoAsignadasUsd: 0, // no modeladas todavía
      interesesUsd: 12000,
      diferenciaCambioUsd: -3500, // pesos que se apreciaron
      resultadoTenenciaUsd: 39900, // §5.3 hacienda + otros
    });
    // Operativo = 24180 + 250000 + 7000 − 22000 − 0 = 259 180
    expect(ve.resultadoOperativo.toString()).toBe('259180');
    // Neto = 259180 − 12000 + (−3500) = 243 680
    expect(ve.resultadoNeto.toString()).toBe('243680');
    // Tenencia se muestra APARTE
    expect(ve.resultadoTenencia.toString()).toBe('39900');
  });

  // ── 8. §5.8 — Equivalencias de empresa ─────────────────────────

  it('Equivalencias carne/soja del resultado neto operativo', () => {
    // MB total 24 180 (después de tierra, vista negocios)
    // kg carne eq = 24180 / 2.5 = 9672
    expect(kgCarneEquivalente(24180, PRECIOS_BASE).toString()).toBe('9672');
    // t soja eq = 24180 / 320 = 75.5625
    expect(tSojaEquivalente(24180, PRECIOS_BASE).toString()).toBe('75.5625');
  });

  // ── 9. §6 — Presupuesto vs Real con desvíos ────────────────────

  it('Desvío en fertilizante: 18t presupuestadas @ 800 vs 20t reales @ 900', () => {
    const d1 = calcularDesvio({
      cantidadPresupuesto: 18,
      precioPresupuesto: 800,
      cantidadReal: 20,
      precioReal: 900,
    });
    // Presup = 14400; real = 18000; total = +3600
    // Precio = (900−800)×20 = +2000; Cantidad = (20−18)×800 = +1600
    // 2000 + 1600 = 3600 ✓
    expect(d1.desvioTotalUsd.toString()).toBe('3600');
    expect(d1.desvioPrecioUsd.toString()).toBe('2000');
    expect(d1.desvioCantidadUsd.toString()).toBe('1600');
    // Con umbral 1000 USD / 10% → 25% de desvío → alerta
    expect(pasaUmbral(d1, { desvioUsd: 1000, desvioPct: 0.1 })).toBe(true);
  });

  it('Presupuesto económico soja: cantidad × precio agrupado por centro', () => {
    const rows = calcularEconomico(
      [
        { mes: 4, centro: 'AGR', productoId: 'SOJA', concepto: 'VENTA', cantidad: 500 },
        { mes: 5, centro: 'AGR', productoId: 'SOJA', concepto: 'VENTA', cantidad: 340 },
        { mes: 8, centro: 'FEED', productoId: 'RACION', concepto: 'COMPRA', cantidad: 108 },
      ],
      [
        { mes: 3, productoId: 'SOJA', precioUsd: 320 },
        { mes: 5, productoId: 'SOJA', precioUsd: 340 },
        { mes: 1, productoId: 'RACION', precioUsd: 350 },
      ],
    );
    // mes 4, SOJA → precio del mes 3 (320): 500 × 320 = 160 000
    // mes 5, SOJA → precio del mes 5 (340): 340 × 340 = 115 600
    // mes 8, RACION → precio del mes 1 (350): 108 × 350 = 37 800
    expect(rows[0].montoUsd.toString()).toBe('160000');
    expect(rows[1].montoUsd.toString()).toBe('115600');
    expect(rows[2].montoUsd.toString()).toBe('37800');
    const t = totalizarPorCentro(rows);
    expect(t['AGR'].toString()).toBe('275600');
    expect(t['FEED'].toString()).toBe('37800');
  });

  // ── 10. §6 — Flujo de caja 12 meses ────────────────────────────

  it('Caja 12 meses: mes de saldo mínimo y monto a financiar', () => {
    // Escenario simplificado: 12 meses con estacionalidad agrícola
    //  · Ene-Mar: sólo egresos (barbecho, siembra soja 2ª)
    //  · Abr-May: cosecha soja 1ª, gran ingreso
    //  · Jun-Nov: mantenimiento, siembra trigo
    //  · Dic: cosecha trigo
    const movs = [
      { ano: 2025, mes: 1, ingresosUsd: 5000, egresosUsd: 25000, origen: 'REAL' as const },
      { ano: 2025, mes: 2, ingresosUsd: 5000, egresosUsd: 30000, origen: 'REAL' as const },
      { ano: 2025, mes: 3, ingresosUsd: 6000, egresosUsd: 22000, origen: 'REAL' as const },
      { ano: 2025, mes: 4, ingresosUsd: 130000, egresosUsd: 18000, origen: 'REAL' as const },
      { ano: 2025, mes: 5, ingresosUsd: 90000, egresosUsd: 15000, origen: 'REAL' as const },
      { ano: 2025, mes: 6, ingresosUsd: 12000, egresosUsd: 25000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 7, ingresosUsd: 8000, egresosUsd: 20000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 8, ingresosUsd: 8000, egresosUsd: 22000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 9, ingresosUsd: 10000, egresosUsd: 18000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 10, ingresosUsd: 8000, egresosUsd: 15000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 11, ingresosUsd: 12000, egresosUsd: 20000, origen: 'PRESUPUESTO' as const },
      { ano: 2025, mes: 12, ingresosUsd: 88000, egresosUsd: 25000, origen: 'PRESUPUESTO' as const },
    ];
    const r = proyectarCaja(movs, 40000, 15000);
    // Saldos progresivos:
    // Ene: 40000 + (5000-25000) = 20000
    // Feb: 20000 + (5000-30000) = -5000 (ROJO)
    // Mar: -5000 + (6000-22000) = -21000 (ROJO, mínimo)
    // Abr: -21000 + (130000-18000) = 91000
    // ...
    expect(r.filas[0].saldoFinalUsd.toString()).toBe('20000'); // AMARILLO (bajo 15k? no, 20>15 = OK)
    expect(r.filas[1].saldoFinalUsd.toString()).toBe('-5000');
    expect(r.filas[1].alerta).toBe('ROJO');
    expect(r.filas[2].saldoFinalUsd.toString()).toBe('-21000');
    expect(r.mesSaldoMinimo).toEqual({ ano: 2025, mes: 3 });
    expect(r.saldoMinimoUsd.toString()).toBe('-21000');
    // Para llegar al mínimo operativo 15000 hay que financiar 36000
    expect(r.montoFinanciarUsd.toString()).toBe('36000');
  });
});
