/**
 * Renderer HTML de un DecisionResultado con la identidad visual de Tolvink.
 *
 * Paleta light-only, verde primario, Inter, chips/pills. SVG inline (sin
 * dependencia externa) para la curva, heatmap y comparativa de escenarios.
 * Print-ready: "Guardar como PDF" desde el navegador da un PDF limpio.
 */

import { DecisionResultado, MatrizDobleEntrada, Punto } from '../dominio/decisiones/tipos';
import {
  escapeHtml,
  fmtN,
  TOLVINK_BASE_CSS,
  tolvinkHeader,
} from '../common/tolvink-theme';

const NOMBRES: Record<string, string> = {
  'momento-venta': 'Momento óptimo de venta',
  'precio-max-reposicion': 'Precio máximo de reposición',
  'fertilizacion': 'Fertilización óptima',
  'van-pasturas': 'VAN y TIR de pasturas',
  'maquinaria': 'Comprar vs contratar maquinaria',
  'comercializacion-granos': 'Comercialización de granos',
  'compra-insumos': 'Compra anticipada de insumos',
  'renta-max': 'Renta máxima a pagar',
  'recomposicion': 'Recomposición de negocios',
};

// ── SVG helpers ──────────────────────────────────────────────────────

function renderCurva(
  puntos: Punto[],
  labelX: string,
  labelY: string,
  optimoIdx?: number,
): string {
  if (!puntos.length) return '';
  const W = 620;
  const H = 260;
  const P = 48;
  const xs = puntos.map((p) => Number(p.x));
  const ys = puntos.map((p) => Number(p.y));
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMin = Math.min(...ys, 0);
  const yMax = Math.max(...ys);
  const dx = xMax - xMin || 1;
  const dy = yMax - yMin || 1;
  const sx = (x: number) => P + ((x - xMin) / dx) * (W - 2 * P);
  const sy = (y: number) => H - P - ((y - yMin) / dy) * (H - 2 * P);
  const d = puntos
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(Number(p.x)).toFixed(1)},${sy(Number(p.y)).toFixed(1)}`)
    .join(' ');

  const gridY = 4;
  const gridLines: string[] = [];
  for (let i = 0; i <= gridY; i++) {
    const y = yMin + (dy * i) / gridY;
    const py = sy(y);
    gridLines.push(
      `<line x1="${P}" y1="${py}" x2="${W - P}" y2="${py}" class="grid"/>` +
        `<text x="${P - 8}" y="${py + 3.5}" class="axis" text-anchor="end">${fmtN(y, 0)}</text>`,
    );
  }
  const gridXTicks = Math.min(8, puntos.length);
  const xTicks: string[] = [];
  for (let i = 0; i <= gridXTicks; i++) {
    const x = xMin + (dx * i) / gridXTicks;
    const px = sx(x);
    xTicks.push(
      `<line x1="${px}" y1="${H - P}" x2="${px}" y2="${H - P + 4}" class="grid"/>` +
        `<text x="${px}" y="${H - P + 15}" class="axis" text-anchor="middle">${fmtN(x, 0)}</text>`,
    );
  }

  const cerro = sy(0);
  const zeroLine =
    cerro >= P && cerro <= H - P
      ? `<line x1="${P}" y1="${cerro}" x2="${W - P}" y2="${cerro}" class="zero"/>`
      : '';

  let optimoMark = '';
  if (typeof optimoIdx === 'number' && optimoIdx >= 0 && optimoIdx < puntos.length) {
    const px = sx(Number(puntos[optimoIdx].x));
    const py = sy(Number(puntos[optimoIdx].y));
    optimoMark =
      `<line x1="${px}" y1="${P}" x2="${px}" y2="${H - P}" class="opt"/>` +
      `<circle cx="${px}" cy="${py}" r="5" class="opt-dot"/>`;
  }

  return `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(labelY)} vs ${escapeHtml(labelX)}" class="chart">
  ${gridLines.join('')}
  ${xTicks.join('')}
  ${zeroLine}
  <path d="${d}" class="line" fill="none"/>
  ${optimoMark}
  <text x="${W / 2}" y="${H - 6}" text-anchor="middle" class="lbl">${escapeHtml(labelX)}</text>
  <text x="14" y="${H / 2}" text-anchor="middle" transform="rotate(-90 14,${H / 2})" class="lbl">${escapeHtml(labelY)}</text>
</svg>`;
}

function renderHeatmap(m: MatrizDobleEntrada): string {
  const cellW = 60;
  const cellH = 32;
  const marginX = 100;
  const marginY = 56;
  const cols = m.valoresX.length;
  const rows = m.valoresY.length;
  const W = marginX + cols * cellW + 20;
  const H = marginY + rows * cellH + 44;
  const flat = m.celdas.flat();
  const minV = Math.min(...flat);
  const maxV = Math.max(...flat);
  const span = maxV - minV || 1;

  // Paleta acorde a Tolvink: rojo (danger) → beige → verde (green) para
  // signos mixtos; secuencial verde para positivo-monotono.
  const color = (v: number): string => {
    if (minV < 0 && maxV > 0) {
      if (v < 0) {
        const t = Math.min(1, -v / (-minV || 1));
        // beige → danger
        const l = 92 - t * 40; // 92%..52%
        return `hsl(14 55% ${l}%)`;
      } else {
        const t = Math.min(1, v / (maxV || 1));
        const l = 92 - t * 40;
        return `hsl(148 40% ${l}%)`;
      }
    }
    const t = (v - minV) / span;
    const l = 94 - t * 44; // verde secuencial
    return `hsl(148 40% ${l}%)`;
  };

  const cells: string[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = m.celdas[y][x];
      const cx = marginX + x * cellW;
      const cy = marginY + y * cellH;
      cells.push(
        `<rect x="${cx}" y="${cy}" width="${cellW}" height="${cellH}" fill="${color(v)}" stroke="#fff" stroke-width="1"/>` +
          `<text x="${cx + cellW / 2}" y="${cy + cellH / 2 + 4}" text-anchor="middle" class="cell">${fmtN(v, 0)}</text>`,
      );
    }
  }
  const headX = m.valoresX
    .map(
      (v, i) =>
        `<text x="${marginX + i * cellW + cellW / 2}" y="${marginY - 8}" text-anchor="middle" class="hdr">${fmtN(v, 2)}</text>`,
    )
    .join('');
  const headY = m.valoresY
    .map(
      (v, i) =>
        `<text x="${marginX - 8}" y="${marginY + i * cellH + cellH / 2 + 4}" text-anchor="end" class="hdr">${fmtN(v, 2)}</text>`,
    )
    .join('');

  return `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tabla ${escapeHtml(m.labelX)} vs ${escapeHtml(m.labelY)}" class="chart">
  <text x="${marginX + (cols * cellW) / 2}" y="${marginY - 30}" text-anchor="middle" class="lbl">${escapeHtml(m.labelX)}</text>
  <text x="22" y="${marginY + (rows * cellH) / 2}" text-anchor="middle" transform="rotate(-90 22,${marginY + (rows * cellH) / 2})" class="lbl">${escapeHtml(m.labelY)}</text>
  ${headX}
  ${headY}
  ${cells.join('')}
  <text x="${marginX}" y="${H - 8}" class="cap">Unidad: ${escapeHtml(m.unidad)} · Rango ${fmtN(minV, 0)} → ${fmtN(maxV, 0)}</text>
</svg>`;
}

function renderEscenariosBar(esc: Record<string, number>): string {
  const W = 620;
  const H = 160;
  const P = 44;
  const entries = Object.entries(esc);
  const bw = ((W - 2 * P) / entries.length) * 0.68;
  const gap = ((W - 2 * P) / entries.length) * 0.32;
  const vals = entries.map(([, v]) => v);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const y0 = H / 2;
  // Colores Tolvink: base = green, optimista = green claro, pesimista = amber, seca = danger.
  const colorFor = (label: string) =>
    label === 'BASE'
      ? '#23633f' // green
      : label === 'OPTIMISTA'
        ? '#4a8a5f'
        : label === 'PESIMISTA'
          ? '#b86e12' // amber
          : '#a24a2b'; // seca = danger
  const bars = entries
    .map(([label, v], i) => {
      const x = P + i * (bw + gap);
      const h = (Math.abs(v) / maxAbs) * (H / 2 - P) || 1;
      const y = v >= 0 ? y0 - h : y0;
      const fill = colorFor(label);
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${fill}" rx="3"/>
      <text x="${x + bw / 2}" y="${H - 10}" class="hdr" text-anchor="middle">${escapeHtml(label)}</text>
      <text x="${x + bw / 2}" y="${v >= 0 ? y - 5 : y + h + 13}" class="cell" text-anchor="middle">${fmtN(v, 0)}</text>`;
    })
    .join('');
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Comparativa por escenario">
  <line x1="${P}" y1="${y0}" x2="${W - P}" y2="${y0}" class="grid"/>
  ${bars}
</svg>`;
}

export function renderDecisionHtml<T>(tipo: string, r: DecisionResultado<T>): string {
  const nombre = NOMBRES[tipo] ?? tipo;
  const svgCurva = r.curva
    ? renderCurva(r.curva.puntos, r.curva.labelX, r.curva.labelY, r.curva.optimo?.indice)
    : '';
  const svgHeatmap = r.matriz ? renderHeatmap(r.matriz) : '';
  const svgEscenarios = r.escenarios
    ? renderEscenariosBar(r.escenarios as Record<string, number>)
    : '';
  const alertas = r.alertas.map((a) => `<li>${escapeHtml(a)}</li>`).join('');
  const params = JSON.stringify(r.parametros, null, 2);

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${escapeHtml(nombre)} · Tolvink</title>
<style>${TOLVINK_BASE_CSS}</style>
</head><body>
<main>
  ${tolvinkHeader(nombre, {
    subtitle: 'Modelo de decisión — cálculo con los parámetros enviados.',
    contextPill: 'Agro',
  })}
  <div class="content">
    <div class="card">
      <div class="kpi-num">${fmtN(Number(r.resultado.valorPrincipal), 2)}<span class="u">${escapeHtml(r.resultado.unidad)}</span></div>
      <div class="kpi-interp">${escapeHtml(r.resultado.interpretacion)}</div>
    </div>

    <div class="rec-box">
      <strong>Recomendación</strong>
      ${escapeHtml(r.recomendacion)}
    </div>

    ${r.alertas.length ? `<div class="card"><h2>Alertas</h2><ul class="alertas">${alertas}</ul></div>` : ''}
    ${svgCurva ? `<div class="card"><h2>Curva</h2>${svgCurva}</div>` : ''}
    ${svgHeatmap ? `<div class="card"><h2>Tabla de doble entrada</h2>${svgHeatmap}</div>` : ''}
    ${svgEscenarios ? `<div class="card"><h2>Escenarios</h2>${svgEscenarios}</div>` : ''}

    <div class="card noprint">
      <h2>Parámetros de entrada</h2>
      <pre class="params">${escapeHtml(params)}</pre>
    </div>

    <div class="footer-note noprint">
      Para guardar como PDF: Imprimir → Guardar como PDF.
    </div>
  </div>
</main>
</body></html>`;
}
