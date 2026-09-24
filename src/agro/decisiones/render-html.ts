/**
 * Renderer HTML print-friendly de un DecisionResultado.
 *
 * SVG inline (sin dependencia externa): línea para `curva` y heatmap para
 * `matriz`. Paleta accesible en claro y oscuro, tabular numérico, tipografía
 * de sistema. Botón de imprimir. Auto-contenido en un solo archivo.
 */

import { DecisionResultado, MatrizDobleEntrada, Punto } from '../dominio/decisiones/tipos';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtN(n: number, decimals = 2): string {
  return n.toLocaleString('es-UY', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

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
  const P = 44;
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
        `<text x="${P - 6}" y="${py + 3.5}" class="axis" text-anchor="end">${fmtN(y, 0)}</text>`,
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

  // Línea Y=0
  const cerro = sy(0);
  const zeroLine = cerro >= P && cerro <= H - P
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
  <rect x="0" y="0" width="${W}" height="${H}" class="bg"/>
  ${gridLines.join('')}
  ${xTicks.join('')}
  ${zeroLine}
  <path d="${d}" class="line" fill="none"/>
  ${optimoMark}
  <text x="${W / 2}" y="${H - 6}" text-anchor="middle" class="lbl">${escapeHtml(labelX)}</text>
  <text x="12" y="${H / 2}" text-anchor="middle" transform="rotate(-90 12,${H / 2})" class="lbl">${escapeHtml(labelY)}</text>
</svg>`;
}

function renderHeatmap(m: MatrizDobleEntrada): string {
  const cellW = 56;
  const cellH = 30;
  const marginX = 90;
  const marginY = 50;
  const cols = m.valoresX.length;
  const rows = m.valoresY.length;
  const W = marginX + cols * cellW + 20;
  const H = marginY + rows * cellH + 40;
  const flat = m.celdas.flat();
  const minV = Math.min(...flat);
  const maxV = Math.max(...flat);
  const span = maxV - minV || 1;

  const color = (v: number): string => {
    const t = (v - minV) / span; // 0..1
    // Divergente si min<0<max, sino secuencial.
    if (minV < 0 && maxV > 0) {
      // Rojo → gris → verde
      if (v < 0) {
        const t2 = 1 - v / minV;
        const l = 90 - t2 * 50;
        return `hsl(10 70% ${l}%)`;
      } else {
        const t2 = v / maxV;
        const l = 90 - t2 * 50;
        return `hsl(140 55% ${l}%)`;
      }
    }
    const l = 90 - t * 50;
    return `hsl(200 60% ${l}%)`;
  };

  const cells: string[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const v = m.celdas[y][x];
      const cx = marginX + x * cellW;
      const cy = marginY + y * cellH;
      cells.push(
        `<rect x="${cx}" y="${cy}" width="${cellW}" height="${cellH}" fill="${color(v)}" stroke="#fff"/>` +
          `<text x="${cx + cellW / 2}" y="${cy + cellH / 2 + 4}" text-anchor="middle" class="cell">${fmtN(v, 0)}</text>`,
      );
    }
  }
  // Headers X e Y
  const headX = m.valoresX
    .map(
      (v, i) =>
        `<text x="${marginX + i * cellW + cellW / 2}" y="${marginY - 8}" text-anchor="middle" class="hdr">${fmtN(v, 2)}</text>`,
    )
    .join('');
  const headY = m.valoresY
    .map(
      (v, i) =>
        `<text x="${marginX - 6}" y="${marginY + i * cellH + cellH / 2 + 4}" text-anchor="end" class="hdr">${fmtN(v, 2)}</text>`,
    )
    .join('');

  return `
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Heatmap ${escapeHtml(m.labelX)} vs ${escapeHtml(m.labelY)}" class="chart">
  <rect x="0" y="0" width="${W}" height="${H}" class="bg"/>
  <text x="${marginX + (cols * cellW) / 2}" y="${marginY - 26}" text-anchor="middle" class="lbl">${escapeHtml(m.labelX)}</text>
  <text x="18" y="${marginY + (rows * cellH) / 2}" text-anchor="middle" transform="rotate(-90 18,${marginY + (rows * cellH) / 2})" class="lbl">${escapeHtml(m.labelY)}</text>
  ${headX}
  ${headY}
  ${cells.join('')}
  <text x="${marginX}" y="${H - 8}" class="cap">Unidad: ${escapeHtml(m.unidad)} · Rango ${fmtN(minV, 0)} → ${fmtN(maxV, 0)}</text>
</svg>`;
}

function renderEscenariosBar(esc: Record<string, number>): string {
  const W = 620;
  const H = 140;
  const P = 40;
  const entries = Object.entries(esc);
  const bw = ((W - 2 * P) / entries.length) * 0.7;
  const gap = ((W - 2 * P) / entries.length) * 0.3;
  const vals = entries.map(([, v]) => v);
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const y0 = H / 2;
  const bars = entries
    .map(([label, v], i) => {
      const x = P + i * (bw + gap);
      const h = ((Math.abs(v) / maxAbs) * (H / 2 - P)) || 1;
      const y = v >= 0 ? y0 - h : y0;
      const fill =
        label === 'BASE'
          ? '#334'
          : label === 'PESIMISTA'
            ? '#c85'
            : label === 'OPTIMISTA'
              ? '#4a7'
              : '#a44';
      return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="${fill}"/>
      <text x="${x + bw / 2}" y="${H - 8}" class="hdr" text-anchor="middle">${escapeHtml(label)}</text>
      <text x="${x + bw / 2}" y="${v >= 0 ? y - 4 : y + h + 12}" class="cell" text-anchor="middle">${fmtN(v, 0)}</text>`;
    })
    .join('');
  return `
<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Comparativa por escenario">
  <rect x="0" y="0" width="${W}" height="${H}" class="bg"/>
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
  const svgEscenarios = r.escenarios ? renderEscenariosBar(r.escenarios as Record<string, number>) : '';
  const alertas = r.alertas
    .map((a) => `<li>${escapeHtml(a)}</li>`)
    .join('');
  const params = JSON.stringify(r.parametros, null, 2);

  return `<!doctype html>
<html lang="es"><head>
<meta charset="utf-8">
<title>${escapeHtml(nombre)}</title>
<style>
  :root {
    --bg: #fff; --fg: #222; --muted: #666; --acc: #0a58ff; --pos: #2a8f3a; --neg: #b13a3a;
    --card: #fafafa; --border: #e5e5e5; --grid: #eaeaea; --zero: #bbb;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111; --fg: #eee; --muted: #999; --acc: #6bf; --pos: #6f9; --neg: #f66;
            --card: #1a1a1a; --border: #2a2a2a; --grid: #333; --zero: #666; }
  }
  html, body { background: var(--bg); color: var(--fg); }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 20px; max-width: 900px; margin: auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .kpi { border: 1px solid var(--border); background: var(--card); padding: 16px 20px; border-radius: 10px; margin-bottom: 16px; }
  .kpi .num { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; }
  .kpi .u { color: var(--muted); font-size: 13px; margin-left: 6px; }
  .kpi .interp { color: var(--muted); margin-top: 6px; }
  .rec { border-left: 3px solid var(--acc); padding: 8px 14px; margin: 10px 0 16px; }
  .alertas { border: 1px dashed var(--border); padding: 8px 12px; border-radius: 6px; background: var(--card); }
  .alertas li { margin: 4px 0; }
  .section { margin: 22px 0; }
  .section h2 { font-size: 14px; margin: 0 0 6px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); }
  svg.chart { max-width: 100%; height: auto; display: block; }
  svg .bg { fill: var(--card); }
  svg .grid { stroke: var(--grid); stroke-width: 1; }
  svg .zero { stroke: var(--zero); stroke-dasharray: 3 3; }
  svg .line { stroke: var(--acc); stroke-width: 2; }
  svg .axis { font-size: 10px; fill: var(--muted); font-family: monospace; }
  svg .lbl { font-size: 11px; fill: var(--muted); }
  svg .hdr { font-size: 10px; fill: var(--fg); font-family: monospace; }
  svg .cell { font-size: 10px; fill: var(--fg); font-family: monospace; }
  svg .opt { stroke: var(--pos); stroke-width: 1; stroke-dasharray: 3 3; }
  svg .opt-dot { fill: var(--pos); }
  svg .cap { font-size: 10px; fill: var(--muted); }
  pre { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px; overflow: auto; font-size: 11px; }
  @media print {
    .noprint { display: none; }
    body { max-width: none; padding: 0; }
  }
</style>
</head><body>
<h1>${escapeHtml(nombre)}</h1>
<div class="meta">Modelo de decisión — cálculo actual con los parámetros enviados</div>

<div class="kpi">
  <div class="num">${fmtN(Number(r.resultado.valorPrincipal), 2)}<span class="u">${escapeHtml(r.resultado.unidad)}</span></div>
  <div class="interp">${escapeHtml(r.resultado.interpretacion)}</div>
</div>

<div class="rec"><strong>Recomendación:</strong> ${escapeHtml(r.recomendacion)}</div>

${r.alertas.length ? `<div class="section"><h2>Alertas</h2><ul class="alertas">${alertas}</ul></div>` : ''}
${svgCurva ? `<div class="section"><h2>Curva</h2>${svgCurva}</div>` : ''}
${svgHeatmap ? `<div class="section"><h2>Tabla de doble entrada</h2>${svgHeatmap}</div>` : ''}
${svgEscenarios ? `<div class="section"><h2>Escenarios</h2>${svgEscenarios}</div>` : ''}

<div class="section noprint">
  <h2>Parámetros de entrada</h2>
  <pre>${escapeHtml(params)}</pre>
</div>

<div class="noprint" style="margin-top:24px;color:var(--muted);font-size:12px">
  Para guardar como PDF: Imprimir → Guardar como PDF.
</div>
</body></html>`;
}
