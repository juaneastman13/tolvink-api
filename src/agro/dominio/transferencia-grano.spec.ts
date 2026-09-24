import { calcularAsientoFeedlot } from './transferencia-grano';

describe('dominio/transferencia-grano — §5.2', () => {
  it('calcula valor neto = precio referencia − flete − comisión', () => {
    const a = calcularAsientoFeedlot({
      toneladas: 100,
      precioReferenciaUsdT: 300,
      fleteUsdT: 15,
      comisionUsdT: 5,
    });
    expect(a.precioNetoUsdT.toString()).toBe('280');
    expect(a.importeUsd.toString()).toBe('28000');
  });

  it('ingreso agricultura = costo feedlot (asiento gemelo)', () => {
    const a = calcularAsientoFeedlot({
      toneladas: 42,
      precioReferenciaUsdT: 300,
    });
    expect(a.ingresoAgricultura.eq(a.costoFeedlot)).toBe(true);
    expect(a.importeUsd.toString()).toBe('12600');
  });

  it('sin flete ni comisión usa precio referencia como neto', () => {
    const a = calcularAsientoFeedlot({ toneladas: 10, precioReferenciaUsdT: 250 });
    expect(a.precioNetoUsdT.toString()).toBe('250');
  });

  it('rechaza toneladas 0 o negativas', () => {
    expect(() => calcularAsientoFeedlot({ toneladas: 0, precioReferenciaUsdT: 300 })).toThrow(
      RangeError,
    );
  });

  it('rechaza neto ≤ 0 (flete + comisión mayores que el precio)', () => {
    expect(() =>
      calcularAsientoFeedlot({
        toneladas: 10,
        precioReferenciaUsdT: 100,
        fleteUsdT: 60,
        comisionUsdT: 50,
      }),
    ).toThrow(RangeError);
  });
});
