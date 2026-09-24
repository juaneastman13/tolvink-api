import { Decimal } from '@prisma/client/runtime/library';
import { descomponerValor, valorNetoEnCampo } from './valuacion';
import {
  consolidarMaquinariaTarifa,
  repartirPorPorcentaje,
  repartirPorUg,
} from './costos-compartidos';
import { clasificarCampania } from './campania';
import { costoOportunidad, fraccionAno } from './costo-oportunidad';
import { vistaEmpresa, vistaNegocios } from './resultado-empresa';
import { kgCarneEquivalente, tSojaEquivalente } from './equivalencias';
import { calcularTanda } from './feedlot';

const d = (iso: string) => new Date(iso + 'T00:00:00Z');

// ── §5.3 valuación ────────────────────────────────────────────────────

describe('§5.3 — valorNetoEnCampo', () => {
  it('bruto − flete − comisión', () => {
    expect(valorNetoEnCampo(300, 15, 5).toString()).toBe('280');
  });
  it('rechaza neto ≤ 0', () => {
    expect(() => valorNetoEnCampo(100, 60, 50)).toThrow(RangeError);
  });
});

describe('§5.3 — descomponerValor', () => {
  it('efecto físico = ΔKg × precioInicial; efecto precio = kgFinal × ΔPrecio', () => {
    // Ejemplo agricultura:
    //   inicio ejercicio: 0 kg (no había stock)
    //   fin ejercicio: 100 t (100 000 kg) a USD 300/t = 30 000
    //   ventas: 0
    //   ΔKg productivo = 100 000 kg (cosechado en el año)
    //   efectoFísico = 100 000 × 300 / 1000 (usamos t)
    // Usemos toneladas: kg = t para simplificar el test.
    const r = descomponerValor({
      kgInicial: 0,
      precioInicial: 300,
      kgFinal: 100,
      precioFinal: 320,
    });
    // valorFinal 100×320 = 32000
    expect(r.valorFinal.toString()).toBe('32000');
    // efectoFísico: (100 − 0 + 0 − 0) × 300 = 30000
    expect(r.efectoFisico.toString()).toBe('30000');
    // efectoPrecio: 100 × (320 − 300) = 2000
    expect(r.efectoPrecio.toString()).toBe('2000');
    // variaciónNeta = 32000 − 0 = 32000 = efectoFísico + efectoPrecio
    expect(r.variacionNeta.toString()).toBe('32000');
    expect(
      r.efectoFisico.plus(r.efectoPrecio).eq(r.variacionNeta),
    ).toBe(true);
  });

  it('sin cambio de kg → sólo efectoPrecio', () => {
    const r = descomponerValor({
      kgInicial: 100,
      precioInicial: 300,
      kgFinal: 100,
      precioFinal: 350,
    });
    expect(r.efectoFisico.toString()).toBe('0');
    expect(r.efectoPrecio.toString()).toBe('5000');
  });
});

// ── §5.4 asignación ───────────────────────────────────────────────────

describe('§5.4 — repartirPorPorcentaje', () => {
  it('reparte exacto cuando % suma 1', () => {
    const r = repartirPorPorcentaje(10000, { CRI: 0.5, REC: 0.3, FEED: 0.2 });
    expect(r.asignado.CRI!.toString()).toBe('5000');
    expect(r.asignado.REC!.toString()).toBe('3000');
    expect(r.asignado.FEED!.toString()).toBe('2000');
  });

  it('el residuo por redondeo se acumula en el centro de mayor peso', () => {
    const r = repartirPorPorcentaje(100, { CRI: 0.333, REC: 0.333, FEED: 0.334 });
    // 100×0.333 = 33.30 (×2) + 33.40 = 100
    const sum = new Decimal(r.asignado.CRI!)
      .plus(r.asignado.REC!)
      .plus(r.asignado.FEED!);
    expect(sum.toString()).toBe('100');
  });

  it('rechaza si % no suman 1', () => {
    expect(() => repartirPorPorcentaje(1000, { CRI: 0.5, REC: 0.3 })).toThrow();
  });
});

describe('§5.4 — repartirPorUg', () => {
  it('reparte proporcional a UG', () => {
    const r = repartirPorUg(1000, 300, 700);
    expect(r.asignado.CRI!.toString()).toBe('300');
    expect(r.asignado.REC!.toString()).toBe('700');
  });
});

describe('§5.4 — consolidarMaquinariaTarifa', () => {
  it('sobrerrecupero cuando tarifa cobrada > costo real', () => {
    const r = consolidarMaquinariaTarifa([
      { ingresoTarifa: 15000, costoReal: 12000 },
      { ingresoTarifa: 8000, costoReal: 6500 },
    ]);
    expect(r.ingresoTotal.toString()).toBe('23000');
    expect(r.costoTotal.toString()).toBe('18500');
    expect(r.diferencia.toString()).toBe('4500'); // positivo
  });
  it('subrecupero cuando costo real > tarifa (indicio comprar-vs-contratar)', () => {
    const r = consolidarMaquinariaTarifa([{ ingresoTarifa: 5000, costoReal: 8000 }]);
    expect(r.diferencia.toString()).toBe('-3000'); // negativo
  });
});

// ── §5.5 campaña ──────────────────────────────────────────────────────

describe('§5.5 — clasificarCampania', () => {
  const cfg = { mesInicioEjercicio: 1 }; // ejercicio calendario

  it('cosecha dentro del ejercicio → reconoce resultado', () => {
    const r = clasificarCampania(
      cfg,
      { fechaCosecha: d('2025-04-15'), costoAcumuladoUsd: 30000, ingresoAcumuladoUsd: 50000 },
      d('2025-12-31'),
    );
    expect(r.ejercicioReconocimiento).toBe(2025);
    expect(r.resultadoUsd.toString()).toBe('20000');
    expect(r.activoCultivosEnPieUsd.toString()).toBe('0');
  });

  it('cosecha en ejercicio siguiente → costos como activo', () => {
    const r = clasificarCampania(
      cfg,
      { fechaCosecha: d('2026-04-15'), costoAcumuladoUsd: 12000, ingresoAcumuladoUsd: 0 },
      d('2025-12-31'),
    );
    expect(r.ejercicioReconocimiento).toBeNull();
    expect(r.resultadoUsd.toString()).toBe('0');
    expect(r.activoCultivosEnPieUsd.toString()).toBe('12000');
  });

  it('sin fecha de cosecha → activo', () => {
    const r = clasificarCampania(
      cfg,
      { fechaCosecha: null, costoAcumuladoUsd: 8000, ingresoAcumuladoUsd: 0 },
      d('2025-12-31'),
    );
    expect(r.activoCultivosEnPieUsd.toString()).toBe('8000');
  });
});

// ── §5.6 costo de oportunidad ─────────────────────────────────────────

describe('§5.6 — costoOportunidad', () => {
  it('CO = capital × tasa × fracción año', () => {
    expect(costoOportunidad({ capitalUsd: 100000, tasaAnual: 0.05, fraccionAno: 1 }).toString()).toBe(
      '5000',
    );
    expect(costoOportunidad({ capitalUsd: 100000, tasaAnual: 0.05, fraccionAno: 0.5 }).toString()).toBe(
      '2500',
    );
  });

  it('fraccionAno entre dos fechas', () => {
    const f = fraccionAno(d('2025-01-01'), d('2025-07-02'));
    // 182 días / 365 ≈ 0.498630
    expect(f.toString()).toBe('0.49863');
  });
});

// ── §5.7 resultado empresa ────────────────────────────────────────────

describe('§5.7 — vistaNegocios', () => {
  it('MB por centro = ingresos − directos − renta ficta', () => {
    const r = vistaNegocios([
      { centro: 'CRI', ingresosUsd: 80000, costosDirectosUsd: 40000, rentaTierraUsd: 10000 },
      { centro: 'AGR', ingresosUsd: 120000, costosDirectosUsd: 60000, rentaTierraUsd: 25000 },
    ]);
    expect(r.porCentro[0].mbDespuesTierra.toString()).toBe('30000');
    expect(r.porCentro[1].mbDespuesTierra.toString()).toBe('35000');
    expect(r.totalMbDespuesTierra.toString()).toBe('65000');
  });
});

describe('§5.7 — vistaEmpresa', () => {
  it('operativo = Σ MB + reversión ± MAQ − estructura − amortizaciones', () => {
    const r = vistaEmpresa({
      margenes: [
        { centro: 'CRI', ingresosUsd: 80000, costosDirectosUsd: 40000, rentaTierraUsd: 10000 },
        { centro: 'AGR', ingresosUsd: 120000, costosDirectosUsd: 60000, rentaTierraUsd: 25000 },
      ],
      rentaFictaTotalUsd: 35000, // 10000 + 25000
      resultadoMaqUsd: 3000, // sobrerrecupero
      estructuraNoAsignadaUsd: 12000,
      amortizacionesNoAsignadasUsd: 8000,
      interesesUsd: 5000,
      diferenciaCambioUsd: -1000,
      resultadoTenenciaUsd: 4000,
    });
    // Σ MB = 65000, + reversión 35000 + MAQ 3000 − 12000 − 8000 = 83000
    expect(r.resultadoOperativo.toString()).toBe('83000');
    // neto = 83000 − 5000 − 1000 = 77000
    expect(r.resultadoNeto.toString()).toBe('77000');
    // tenencia se muestra aparte
    expect(r.resultadoTenencia.toString()).toBe('4000');
  });
});

// ── §5.8 equivalencias ────────────────────────────────────────────────

describe('§5.8 — equivalencias', () => {
  it('kg carne eq usa precio base fijo', () => {
    // 50 000 USD a base 3 USD/kg → 16 666.67 kg
    expect(
      kgCarneEquivalente(50000, { pBaseCarne: 3, pBaseSoja: 300 }).toString(),
    ).toBe('16666.67');
  });

  it('t soja eq usa precio base fijo', () => {
    // 12 000 USD a base 300 USD/t → 40 t
    expect(tSojaEquivalente(12000, { pBaseCarne: 3, pBaseSoja: 300 }).toString()).toBe(
      '40',
    );
  });

  it('rechaza precio base 0', () => {
    expect(() =>
      kgCarneEquivalente(1000, { pBaseCarne: 0, pBaseSoja: 300 }),
    ).toThrow(RangeError);
  });
});

// ── §5.9 feedlot ──────────────────────────────────────────────────────

describe('§5.9 — feedlot', () => {
  it('calcula GMD, conversión, breakeven, margen por cabeza', () => {
    // Tanda de 100 cabezas, 90 días, entra 300 kg/cab, sale 420 kg/cab
    // Consumo 90 kg MS/día × 100 cab × 90 días = 81 000 kg? Uso más simple:
    // ganancia total = 12 000 kg, MS consumido 90 000 kg → conv = 7.5
    // costoTotal = 30 000 USD, ingreso = 40 000
    const r = calcularTanda({
      cabezas: 100,
      fechaIngreso: d('2025-04-01'),
      fechaSalida: d('2025-06-30'), // 90 días
      kgEntradaTotal: 30000, // 300 kg × 100
      kgSalidaTotal: 42000, // 420 kg × 100
      kgMsConsumidos: 90000,
      costoTotalUsd: 30000,
      ingresoTotalUsd: 40000,
    });
    expect(r.diasEncierre).toBe(90);
    expect(r.kgGanadosTotales.toString()).toBe('12000');
    // GMD = 12000 / 100 / 90 = 1.333...
    expect(r.gmdKgDia.toString()).toBe('1.333');
    // conv = 90000 / 12000 = 7.5
    expect(r.conversion.toString()).toBe('7.5');
    // costo/kg ganado = 30000 / 12000 = 2.5
    expect(r.costoPorKgGanado.toString()).toBe('2.5');
    expect(r.margenTotalUsd.toString()).toBe('10000');
    expect(r.margenPorCabezaUsd.toString()).toBe('100');
    // breakeven = 300 USD/cab / 420 kg/cab = 0.7143 USD/kg
    expect(r.precioEquilibrioUsdKg.toString()).toBe('0.7143');
  });

  it('rechaza kg ganados ≤ 0', () => {
    expect(() =>
      calcularTanda({
        cabezas: 10,
        fechaIngreso: d('2025-01-01'),
        fechaSalida: d('2025-02-01'),
        kgEntradaTotal: 5000,
        kgSalidaTotal: 5000,
        kgMsConsumidos: 100,
        costoTotalUsd: 1000,
        ingresoTotalUsd: 1000,
      }),
    ).toThrow(RangeError);
  });
});
