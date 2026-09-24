import { calcularVanPasturas } from '../dominio/decisiones/van-pasturas';
import { calcularMomentoVenta } from '../dominio/decisiones/momento-venta';
import { calcularRentaMax } from '../dominio/decisiones/renta-max';
import { renderDecisionHtml } from './render-html';

describe('decisiones/render-html', () => {
  it('renderiza VAN-pasturas con SVG de curva y heatmap', () => {
    const r = calcularVanPasturas({
      inversionUsdHa: 250,
      vidaAnos: 4,
      kgIncrementalesHaAno: 120,
      precioUsdKg: 2.2,
      costoManteUsdHaAno: 20,
      tasaDescuento: 0.08,
    });
    const html = renderDecisionHtml('van-pasturas', r);
    expect(html).toContain('<svg');
    expect(html).toContain('VAN y TIR de pasturas');
    expect(html).toContain('Curva');
    expect(html).toContain('Tabla de doble entrada');
    // Sin errores de escape
    expect(html).not.toMatch(/<script[^>]*>/i);
  });

  it('renderiza momento-venta con óptimo marcado', () => {
    const r = calcularMomentoVenta({
      kgActual: 380,
      gmdKgDia: 1.0,
      escalaPrecio: [
        { kgHasta: 400, precioUsdKg: 2.3 },
        { kgHasta: 500, precioUsdKg: 2.45 },
      ],
      costoUsdKgGanado: 1.5,
      tasaAnualCO: 0.05,
      diasMax: 120,
      pasoDias: 10,
    });
    const html = renderDecisionHtml('momento-venta', r);
    expect(html).toContain('Momento óptimo de venta');
    // Marca de óptimo (línea + circle)
    expect(html).toMatch(/opt-dot/);
    // Comparativa por escenario
    expect(html).toContain('BASE');
    expect(html).toContain('SECA');
  });

  it('renderiza sin curva ni matriz si el resultado no las trae', () => {
    const r = calcularRentaMax({
      rindeThaEsperado: 3.0,
      precioUsdT: 320,
      costoDirectoUsdHa: 500,
      margenObjetivoUsdHa: 100,
    });
    // renta-max SÍ tiene matriz pero NO curva
    const html = renderDecisionHtml('renta-max', r);
    expect(html).toContain('Tabla de doble entrada');
    expect(html).not.toContain('<h2>Curva</h2>');
  });

  it('escapa HTML en interpretación y recomendación', () => {
    const r = calcularRentaMax({
      rindeThaEsperado: 3.0,
      precioUsdT: 320,
      costoDirectoUsdHa: 500,
      margenObjetivoUsdHa: 100,
    });
    // El texto de interpretación no debería tener < ni > sin escapar.
    r.recomendacion = '<script>alert(1)</script>';
    r.resultado.interpretacion = 'a > b < c';
    const html = renderDecisionHtml('renta-max', r);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a &gt; b &lt; c');
  });
});
