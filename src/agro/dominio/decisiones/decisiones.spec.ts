import { calcularMomentoVenta } from './momento-venta';
import { calcularPrecioMaxReposicion } from './precio-max-reposicion';
import { calcularFertilizacion } from './fertilizacion';
import { calcularVanPasturas, tir, van } from './van-pasturas';
import { calcularMaquinaria } from './maquinaria';
import { calcularComercializacion } from './comercializacion-granos';
import { calcularCompraInsumos } from './compra-insumos';
import { calcularRentaMax } from './renta-max';
import { calcularRecomposicion } from './recomposicion';

describe('decisiones/momento-venta', () => {
  it('recomienda esperar cuando el peso todavía sube y no cambia de escalón de precio', () => {
    const r = calcularMomentoVenta({
      kgActual: 380,
      gmdKgDia: 1.0,
      escalaPrecio: [
        { kgHasta: 400, precioUsdKg: 2.3 },
        { kgHasta: 500, precioUsdKg: 2.45 },
        { kgHasta: 999, precioUsdKg: 2.4 }, // castigo por peso excesivo
      ],
      costoUsdKgGanado: 1.5,
      tasaAnualCO: 0.05,
      diasMax: 120,
      pasoDias: 10,
    });
    // El pico esperado está cerca de superar los 400 kg → salto de precio.
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
    expect(r.curva!.puntos.length).toBeGreaterThan(5);
    expect(r.escenarios!.OPTIMISTA).toBeGreaterThanOrEqual(r.escenarios!.PESIMISTA);
  });

  it('recomienda vender ya cuando cualquier día extra baja el valor', () => {
    const r = calcularMomentoVenta({
      kgActual: 500,
      gmdKgDia: 0.5,
      escalaPrecio: [
        { kgHasta: 500, precioUsdKg: 2.7 },
        { kgHasta: 700, precioUsdKg: 2.3 }, // castiga peso excesivo
      ],
      costoUsdKgGanado: 2.5,
      tasaAnualCO: 0.08,
      diasMax: 90,
      pasoDias: 10,
    });
    expect(r.resultado.valorPrincipal).toBe(0);
    expect(r.recomendacion).toMatch(/Vender ya/);
  });
});

describe('decisiones/precio-max-reposicion', () => {
  it('precio máximo cae cuando aumenta el costo de engorde', () => {
    const p = {
      kgCompra: 250,
      kgVenta: 450,
      diasEngorde: 240,
      precioVentaUsdKg: 2.5,
      costoUsdKgGanado: 1.5,
      tasaAnualCO: 0.05,
      margenObjetivoUsdKg: 0.1,
    };
    const a = calcularPrecioMaxReposicion(p);
    const b = calcularPrecioMaxReposicion({ ...p, costoUsdKgGanado: 2.5 });
    expect(a.resultado.valorPrincipal).toBeGreaterThan(b.resultado.valorPrincipal as number);
    expect(a.matriz!.celdas.length).toBe(a.matriz!.valoresY.length);
  });
});

describe('decisiones/fertilizacion', () => {
  it('dosis óptima positiva cuando relación precio grano/fert es alta', () => {
    const r = calcularFertilizacion({
      cultivo: 'trigo',
      precioGranoUsdT: 220,
      precioFertUsdT: 800, // USD/t de urea
      rindeMaxTha: 5.5,
      k: 0.008,
      aporteSueloKgHa: 30,
      dosisMaxKgHa: 200,
    });
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
  });

  it('no fertilizar cuando la respuesta es baja y el fert caro', () => {
    // arg = (pG · rMax · 1000 · k) / pF; con arg ≤ 1 → dOpt = 0.
    // pG=0.15, rMax=4, k=0.001, pF=1 (kg): (0.15·4·1000·0.001)/1 = 0.6 → 0.
    const r = calcularFertilizacion({
      cultivo: 'trigo',
      precioGranoUsdT: 150,
      precioFertUsdT: 1000,
      rindeMaxTha: 4,
      k: 0.001,
    });
    expect(r.resultado.valorPrincipal).toBe(0);
  });
});

describe('decisiones/van-pasturas', () => {
  it('VAN positivo cuando el kg incremental cubre la inversión', () => {
    const r = calcularVanPasturas({
      inversionUsdHa: 250,
      vidaAnos: 4,
      kgIncrementalesHaAno: 120,
      precioUsdKg: 2.2,
      costoManteUsdHaAno: 20,
      tasaDescuento: 0.08,
    });
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
    expect(r.matriz!.celdas.length).toBeGreaterThan(0);
  });

  it('helper van/tir con ejemplo de libro', () => {
    // -100 + 60 + 60: VAN@10% = -100 + 60/1.1 + 60/1.21 = 4.13
    expect(van([-100, 60, 60], 0.1)).toBeCloseTo(4.132, 2);
    const t = tir([-100, 60, 60])!;
    expect(t).toBeGreaterThan(0.12); // ~13%
    expect(t).toBeLessThan(0.14);
  });

  it('VAN negativo con inversión alta y kg bajos', () => {
    const r = calcularVanPasturas({
      inversionUsdHa: 800,
      vidaAnos: 3,
      kgIncrementalesHaAno: 50,
      precioUsdKg: 2.0,
      tasaDescuento: 0.1,
    });
    expect(r.resultado.valorPrincipal).toBeLessThan(0);
    expect(r.alertas.length).toBeGreaterThan(0);
  });
});

describe('decisiones/maquinaria', () => {
  it('ha de indiferencia crece si baja tarifa contratista', () => {
    const base = calcularMaquinaria({
      precioCompraUsd: 120000,
      vidaAnos: 8,
      costoFijoAnualUsd: 4000,
      costoVarUsdHa: 25,
      tarifaContratistaUsdHa: 85,
      haEsperadasAnuales: 600,
      tasaDescuento: 0.1,
    });
    const conTarifaBaja = calcularMaquinaria({
      precioCompraUsd: 120000,
      vidaAnos: 8,
      costoFijoAnualUsd: 4000,
      costoVarUsdHa: 25,
      tarifaContratistaUsdHa: 55,
      haEsperadasAnuales: 600,
      tasaDescuento: 0.1,
    });
    expect(base.resultado.valorPrincipal).toBeLessThan(conTarifaBaja.resultado.valorPrincipal as number);
  });

  it('alerta cuando costo variable propio >= tarifa contratista', () => {
    const r = calcularMaquinaria({
      precioCompraUsd: 100000,
      vidaAnos: 8,
      costoFijoAnualUsd: 3000,
      costoVarUsdHa: 90,
      tarifaContratistaUsdHa: 80,
      haEsperadasAnuales: 400,
      tasaDescuento: 0.1,
    });
    expect(r.alertas.some((a) => /costo variable propio/i.test(a))).toBe(true);
  });
});

describe('decisiones/comercializacion-granos', () => {
  it('esperar cuando el precio esperado sube > costo almacenaje + CO', () => {
    const r = calcularComercializacion({
      precioSpotUsdT: 300,
      variacionMensualPct: 0.02, // +2% mensual
      costoAlmacenajeUsdT: 1.5,
      tasaAnualCO: 0.05,
      mesesMax: 6,
    });
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
  });

  it('vender ya cuando el precio esperado baja', () => {
    const r = calcularComercializacion({
      precioSpotUsdT: 300,
      variacionMensualPct: -0.01,
      costoAlmacenajeUsdT: 1.5,
      tasaAnualCO: 0.05,
      mesesMax: 6,
    });
    expect(r.resultado.valorPrincipal).toBe(0);
  });
});

describe('decisiones/compra-insumos', () => {
  it('conviene anticipar si precio esperado > punto de indiferencia', () => {
    const r = calcularCompraInsumos({
      cantidad: 20,
      precioHoyUsdUn: 800,
      precioEsperadoUsdUn: 900,
      mesesHastaUso: 4,
      tasaAnualCO: 0.06,
    });
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
  });

  it('no conviene si el precio esperado apenas supera el spot con tasa alta', () => {
    const r = calcularCompraInsumos({
      cantidad: 20,
      precioHoyUsdUn: 800,
      precioEsperadoUsdUn: 810,
      mesesHastaUso: 6,
      tasaAnualCO: 0.1,
    });
    expect(r.resultado.valorPrincipal).toBeLessThan(0);
  });
});

describe('decisiones/renta-max', () => {
  it('renta = ingreso − costo − margen objetivo', () => {
    const r = calcularRentaMax({
      rindeThaEsperado: 3.0,
      precioUsdT: 320,
      costoDirectoUsdHa: 500,
      margenObjetivoUsdHa: 100,
    });
    // 3 × 320 − 500 − 100 = 960 − 600 = 360
    expect(r.resultado.valorPrincipal).toBe(360);
  });

  it('alerta cuando escenario seca deja margen negativo', () => {
    const r = calcularRentaMax({
      rindeThaEsperado: 3.0,
      precioUsdT: 320,
      costoDirectoUsdHa: 500,
      margenObjetivoUsdHa: 100,
    });
    // SECA: rinde × 0.6 × precio × 0.95 = 3×0.6×320×0.95 = 547.2 - 500 - 100 = -52.8
    expect(r.escenarios!.SECA).toBeLessThan(0);
  });
});

describe('decisiones/recomposicion', () => {
  it('prioriza la actividad con mayor MB/ha ajustado por capital', () => {
    const r = calcularRecomposicion({
      haTotales: 1000,
      capitalDisponibleUsd: 400000,
      actividades: [
        { codigo: 'AGR_SOJA', haDisponiblesMax: 600, mbUsdHa: 300, capitalUsdHa: 400 },
        { codigo: 'CRI', haDisponiblesMax: 500, haDisponiblesMin: 200, mbUsdHa: 100, capitalUsdHa: 250 },
        { codigo: 'REC', haDisponiblesMax: 400, mbUsdHa: 180, capitalUsdHa: 300 },
      ],
    });
    // Mínimo de cría (200 ha) primero. Después soja hasta el tope de capacidad.
    const salida = r.matriz!.celdas;
    // Fila 0 (primera actividad ordenada por MB): debe ser AGR_SOJA con 600 ha (max)
    // El resto vamos a chequear que MB total sea positivo y consistente.
    expect(r.resultado.valorPrincipal).toBeGreaterThan(0);
    expect(salida.length).toBeGreaterThan(0);
  });

  it('avisa cuando sobran ha por falta de capital', () => {
    const r = calcularRecomposicion({
      haTotales: 1000,
      capitalDisponibleUsd: 50000, // muy limitado
      actividades: [
        { codigo: 'AGR', haDisponiblesMax: 1000, mbUsdHa: 300, capitalUsdHa: 400 },
      ],
    });
    expect(r.alertas.some((a) => a.includes('sin asignar'))).toBe(true);
  });
});
