import { Decimal } from '@prisma/client/runtime/library';
import {
  calcularEconomico,
  FisicoRow,
  PrecioRow,
  resolverPrecio,
  totalizarPorCentro,
} from './presupuesto';
import { calcularDesvio, pasaUmbral } from './desvio';
import { proyectarCaja } from './caja';

describe('§4.4 — presupuesto físico × precio', () => {
  const precios: PrecioRow[] = [
    { mes: 3, productoId: 'SOJA', precioUsd: 300 },
    { mes: 6, productoId: 'SOJA', precioUsd: 350 }, // sube en junio
    { mes: 1, categoriaCod: 'N23', precioUsd: 2.5 }, // USD/kg vivo
  ];

  it('resolverPrecio prefiere el mes más cercano hacia atrás', () => {
    expect(
      resolverPrecio(
        { mes: 5, productoId: 'SOJA', concepto: 'VENTA', cantidad: 100 },
        precios,
      )!.toString(),
    ).toBe('300');
    expect(
      resolverPrecio(
        { mes: 8, productoId: 'SOJA', concepto: 'VENTA', cantidad: 100 },
        precios,
      )!.toString(),
    ).toBe('350');
  });

  it('sin precio disponible devuelve null', () => {
    expect(
      resolverPrecio(
        { mes: 2, productoId: 'SOJA', concepto: 'VENTA', cantidad: 100 },
        precios,
      ),
    ).toBeNull();
  });

  it('calcularEconomico multiplica y agrupa por centro', () => {
    const fisico: FisicoRow[] = [
      { mes: 4, centro: 'AGR', productoId: 'SOJA', concepto: 'VENTA', cantidad: 200 },
      { mes: 6, centro: 'AGR', productoId: 'SOJA', concepto: 'VENTA', cantidad: 100 },
      { mes: 2, centro: 'REC', categoriaCod: 'N23', concepto: 'VENTA', cantidad: 15000 }, // 15 000 kg
    ];
    const rows = calcularEconomico(fisico, precios);
    expect(rows[0].montoUsd.toString()).toBe('60000'); // 200 × 300
    expect(rows[1].montoUsd.toString()).toBe('35000'); // 100 × 350
    expect(rows[2].montoUsd.toString()).toBe('37500'); // 15 000 × 2.5

    const tot = totalizarPorCentro(rows);
    expect(tot['AGR'].toString()).toBe('95000');
    expect(tot['REC'].toString()).toBe('37500');
  });
});

describe('§6 — desvíos precio vs cantidad', () => {
  it('identidad Δtotal = Δprecio + Δcantidad', () => {
    // Presupuestado: 100 u × 10 = 1000
    // Real: 120 u × 12 = 1440
    // Δtotal = 440
    // Δprecio = (12-10) × 120 = 240
    // Δcantidad = (120-100) × 10 = 200
    // 240 + 200 = 440 ✓
    const r = calcularDesvio({
      cantidadPresupuesto: 100,
      precioPresupuesto: 10,
      cantidadReal: 120,
      precioReal: 12,
    });
    expect(r.desvioTotalUsd.toString()).toBe('440');
    expect(r.desvioPrecioUsd.toString()).toBe('240');
    expect(r.desvioCantidadUsd.toString()).toBe('200');
    expect(r.desvioPrecioUsd.plus(r.desvioCantidadUsd).eq(r.desvioTotalUsd)).toBe(true);
  });

  it('desvío 0 cuando real = presupuesto', () => {
    const r = calcularDesvio({
      cantidadPresupuesto: 50,
      precioPresupuesto: 8,
      cantidadReal: 50,
      precioReal: 8,
    });
    expect(r.desvioTotalUsd.toString()).toBe('0');
  });

  it('pasaUmbral por USD absoluto', () => {
    const r = calcularDesvio({
      cantidadPresupuesto: 1000,
      precioPresupuesto: 1,
      cantidadReal: 1050,
      precioReal: 1,
    });
    // Δtotal = 50
    expect(pasaUmbral(r, { desvioUsd: 40, desvioPct: 0.5 })).toBe(true);
    expect(pasaUmbral(r, { desvioUsd: 100, desvioPct: 0.5 })).toBe(false);
  });

  it('pasaUmbral por %', () => {
    const r = calcularDesvio({
      cantidadPresupuesto: 100,
      precioPresupuesto: 100,
      cantidadReal: 100,
      precioReal: 115,
    });
    // presupuestado 10000, real 11500, Δ=1500 (=15%)
    expect(pasaUmbral(r, { desvioUsd: 5000, desvioPct: 0.1 })).toBe(true); // 10% umbral
    expect(pasaUmbral(r, { desvioUsd: 5000, desvioPct: 0.2 })).toBe(false); // 20% umbral
  });
});

describe('§6 — flujo de caja rolling 12 meses', () => {
  it('acumula saldo y marca ROJO cuando queda negativo', () => {
    const r = proyectarCaja(
      [
        { ano: 2025, mes: 1, ingresosUsd: 10000, egresosUsd: 12000, origen: 'REAL' },
        { ano: 2025, mes: 2, ingresosUsd: 5000, egresosUsd: 8000, origen: 'PRESUPUESTO' },
      ],
      new Decimal(3000),
      new Decimal(5000),
    );
    // Mes 1: saldo inicial 3000 + (10000-12000)=1000 → alerta AMARILLO
    expect(r.filas[0].saldoFinalUsd.toString()).toBe('1000');
    expect(r.filas[0].alerta).toBe('AMARILLO');
    // Mes 2: 1000 + (5000-8000) = -2000 → ROJO
    expect(r.filas[1].saldoFinalUsd.toString()).toBe('-2000');
    expect(r.filas[1].alerta).toBe('ROJO');
    // Saldo mínimo = -2000 en mes 2; para llegar al mínimo operativo 5000 hay que financiar 7000
    expect(r.saldoMinimoUsd.toString()).toBe('-2000');
    expect(r.montoFinanciarUsd.toString()).toBe('7000');
    expect(r.mesSaldoMinimo).toEqual({ ano: 2025, mes: 2 });
  });

  it('no financia si saldo mínimo > operativo', () => {
    const r = proyectarCaja(
      [
        { ano: 2025, mes: 1, ingresosUsd: 20000, egresosUsd: 5000, origen: 'PRESUPUESTO' },
      ],
      new Decimal(10000),
      new Decimal(5000),
    );
    expect(r.filas[0].saldoFinalUsd.toString()).toBe('25000');
    expect(r.filas[0].alerta).toBe('OK');
    expect(r.montoFinanciarUsd.toString()).toBe('0');
  });
});
