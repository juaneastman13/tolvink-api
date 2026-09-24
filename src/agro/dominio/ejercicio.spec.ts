import {
  ejercicioDe,
  fechaCorteIntermedio,
  nombreEjercicio,
  rangoDeEjercicio,
  rangoEjercicioDe,
  validarConfig,
} from './ejercicio';

const d = (iso: string) => new Date(iso + 'T00:00:00Z');

describe('dominio/ejercicio — ejercicio calendario (mes 1)', () => {
  const cfg = { mesInicioEjercicio: 1 };

  it('ejercicioDe usa el año calendario', () => {
    expect(ejercicioDe(cfg, d('2025-01-01'))).toBe(2025);
    expect(ejercicioDe(cfg, d('2025-12-31'))).toBe(2025);
    expect(ejercicioDe(cfg, d('2026-01-01'))).toBe(2026);
  });

  it('rangoDeEjercicio cubre 1/1 → 31/12 inclusive', () => {
    const { desde, hasta } = rangoDeEjercicio(cfg, 2025);
    expect(desde.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    expect(hasta.toISOString()).toBe('2025-12-31T23:59:59.999Z');
  });

  it('nombre humano es el año', () => {
    expect(nombreEjercicio(cfg, 2025)).toBe('2025');
  });
});

describe('dominio/ejercicio — ejercicio julio–junio (mes 7)', () => {
  const cfg = { mesInicioEjercicio: 7 };

  it('ejercicioDe termina en el año siguiente', () => {
    // Ejercicio 2025 = 01/07/2024 → 30/06/2025
    expect(ejercicioDe(cfg, d('2024-07-01'))).toBe(2025);
    expect(ejercicioDe(cfg, d('2025-06-30'))).toBe(2025);
    expect(ejercicioDe(cfg, d('2025-07-01'))).toBe(2026);
  });

  it('rangoDeEjercicio para 2025 va de 01/07/2024 a 30/06/2025', () => {
    const { desde, hasta } = rangoDeEjercicio(cfg, 2025);
    expect(desde.toISOString()).toBe('2024-07-01T00:00:00.000Z');
    expect(hasta.toISOString()).toBe('2025-06-30T23:59:59.999Z');
  });

  it('rangoEjercicioDe combina ambas', () => {
    const r = rangoEjercicioDe(cfg, d('2025-03-15'));
    expect(r.ejercicio).toBe(2025);
    expect(r.hasta.toISOString()).toBe('2025-06-30T23:59:59.999Z');
  });

  it('nombre humano es "2024/25"', () => {
    expect(nombreEjercicio(cfg, 2025)).toBe('2024/25');
  });
});

describe('dominio/ejercicio — corte intermedio DICOSE (30/06 con ej. calendario)', () => {
  const cfg = { mesInicioEjercicio: 1, cierreIntermedioMes: 6, cierreIntermedioDia: 30 };

  it('cae dentro del ejercicio 2025', () => {
    const corte = fechaCorteIntermedio(cfg, 2025);
    expect(corte).not.toBeNull();
    expect(corte!.toISOString()).toBe('2025-06-30T00:00:00.000Z');
  });

  it('sin corte configurado devuelve null', () => {
    expect(fechaCorteIntermedio({ mesInicioEjercicio: 1 }, 2025)).toBeNull();
  });
});

describe('dominio/ejercicio — validaciones', () => {
  it('rechaza mes fuera de rango', () => {
    expect(() => validarConfig({ mesInicioEjercicio: 0 })).toThrow(RangeError);
    expect(() => validarConfig({ mesInicioEjercicio: 13 })).toThrow(RangeError);
  });

  it('rechaza corte intermedio incompleto', () => {
    expect(() =>
      validarConfig({ mesInicioEjercicio: 1, cierreIntermedioMes: 6 }),
    ).toThrow(RangeError);
  });
});
