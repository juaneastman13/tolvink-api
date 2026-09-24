import {
  aplicar,
  MovHacienda,
  proyectarStock,
  stockKey,
  validar,
} from './stock-hacienda';

const mov = (m: Partial<MovHacienda>): MovHacienda => ({
  tipo: 'COMPRA',
  centro: 'CRI',
  categoriaCod: 'VC',
  cabezas: 1,
  ...m,
});

describe('dominio/stock-hacienda — aplicar', () => {
  it('COMPRA suma cabezas', () => {
    const s = new Map<string, number>();
    aplicar(s, mov({ tipo: 'COMPRA', cabezas: 50 }));
    expect(s.get(stockKey('CRI', 'VC'))).toBe(50);
  });

  it('VENTA resta', () => {
    const s = new Map([[stockKey('CRI', 'VC'), 50]]);
    aplicar(s, mov({ tipo: 'VENTA', cabezas: 10 }));
    expect(s.get(stockKey('CRI', 'VC'))).toBe(40);
  });

  it('TRANSF mueve de origen a destino', () => {
    const s = new Map([[stockKey('CRI', 'N12'), 20]]);
    aplicar(
      s,
      mov({
        tipo: 'TRANSF',
        centro: 'CRI',
        categoriaCod: 'N12',
        centroDestino: 'REC',
        categoriaDestino: 'N12',
        cabezas: 15,
      }),
    );
    expect(s.get(stockKey('CRI', 'N12'))).toBe(5);
    expect(s.get(stockKey('REC', 'N12'))).toBe(15);
  });

  it('RECATEG mueve entre categorías', () => {
    const s = new Map([[stockKey('REC', 'N12'), 30]]);
    aplicar(
      s,
      mov({
        tipo: 'RECATEG',
        centro: 'REC',
        categoriaCod: 'N12',
        categoriaDestino: 'N23',
        cabezas: 30,
      }),
    );
    expect(s.get(stockKey('REC', 'N12'))).toBe(0);
    expect(s.get(stockKey('REC', 'N23'))).toBe(30);
  });

  it('PESADA/DICOSE/TACTO no mueven stock', () => {
    const s = new Map([[stockKey('FEED', 'N23'), 100]]);
    for (const t of ['PESADA', 'DICOSE', 'TACTO'] as const) {
      aplicar(s, mov({ tipo: t, centro: 'FEED', categoriaCod: 'N23', cabezas: 100 }));
    }
    expect(s.get(stockKey('FEED', 'N23'))).toBe(100);
  });

  it('INVENTARIO setea saldo absoluto', () => {
    const s = new Map([[stockKey('CRI', 'VC'), 150]]);
    aplicar(s, mov({ tipo: 'INVENTARIO', centro: 'CRI', categoriaCod: 'VC', cabezas: 200 }));
    expect(s.get(stockKey('CRI', 'VC'))).toBe(200);
  });
});

describe('dominio/stock-hacienda — validar', () => {
  it('VENTA sin stock suficiente falla', () => {
    const s = new Map([[stockKey('CRI', 'VC'), 5]]);
    const errs = validar(mov({ tipo: 'VENTA', cabezas: 10 }), s);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/Stock insuficiente/);
  });

  it('VENTA con stock exacto pasa', () => {
    const s = new Map([[stockKey('CRI', 'VC'), 10]]);
    expect(validar(mov({ tipo: 'VENTA', cabezas: 10 }), s)).toEqual([]);
  });

  it('TRANSF sin centroDestino falla', () => {
    expect(
      validar(mov({ tipo: 'TRANSF', cabezas: 1 }), new Map()),
    ).toContain('TRANSF requiere centroDestino');
  });

  it('TRANSF a mismo centro y misma categoría es no-op', () => {
    const errs = validar(
      mov({ tipo: 'TRANSF', centroDestino: 'CRI', categoriaDestino: 'VC', cabezas: 1 }),
      new Map([[stockKey('CRI', 'VC'), 10]]),
    );
    expect(errs.some((e) => e.includes('distinta'))).toBe(true);
  });

  it('RECATEG requiere categoriaDestino', () => {
    expect(validar(mov({ tipo: 'RECATEG', cabezas: 1 }), new Map())).toContain(
      'RECATEG requiere categoriaDestino',
    );
  });

  it('cabezas debe ser > 0', () => {
    expect(validar(mov({ tipo: 'COMPRA', cabezas: 0 }), new Map())).toContain(
      'cabezas debe ser > 0 para tipo COMPRA',
    );
  });
});

describe('dominio/stock-hacienda — proyectarStock', () => {
  it('recorre una serie de movimientos y devuelve el stock final', () => {
    const s = proyectarStock([
      mov({ tipo: 'COMPRA', centro: 'CRI', categoriaCod: 'VC', cabezas: 100 }),
      mov({ tipo: 'NACIMIENTO', centro: 'CRI', categoriaCod: 'TH', cabezas: 40 }),
      mov({
        tipo: 'TRANSF',
        centro: 'CRI',
        categoriaCod: 'VC',
        centroDestino: 'REC',
        categoriaDestino: 'VE',
        cabezas: 10,
      }),
      mov({ tipo: 'MUERTE', centro: 'CRI', categoriaCod: 'TH', cabezas: 2 }),
      mov({ tipo: 'VENTA', centro: 'REC', categoriaCod: 'VE', cabezas: 5 }),
    ]);
    expect(s.get(stockKey('CRI', 'VC'))).toBe(90);
    expect(s.get(stockKey('CRI', 'TH'))).toBe(38);
    expect(s.get(stockKey('REC', 'VE'))).toBe(5);
  });
});
