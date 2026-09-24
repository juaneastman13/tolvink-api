/**
 * Identidad visual Tolvink — tokens y layout base para las vistas HTML del
 * módulo agro (informe de socios y modelos de decisión).
 *
 * Se toma directo de la home pública que ya existía en el repo
 * (`src/freight-locations/freight-locations.controller.ts`): paleta verde
 * light-only, Inter, chips y pills redondeados, sombra suave, sin dark
 * mode automático (Tolvink es un producto claro).
 */

export const TOLVINK_TOKENS = /* css */ `
  :root {
    --ink: #17211b;
    --muted: #5c675f;
    --line: #d8ded5;
    --bg: #f5f7f3;
    --panel: #fff;
    --green: #23633f;
    --green-dark: #164c33;
    --green-soft: #eef6f0;
    --green-soft-border: #b8cfbf;
    --danger: #a24a2b;
    --amber: #b86e12;
    --blue: #2563a9;
    --violet: #7257a8;
    --shadow: 0 -14px 30px rgba(23, 33, 27, 0.08);
    --shadow-card: 0 2px 8px rgba(23, 33, 27, 0.05);
    --radius: 8px;
    --radius-lg: 12px;
  }
`;

export const TOLVINK_BASE_CSS = /* css */ `
  ${TOLVINK_TOKENS}
  * { box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--ink); }
  body {
    margin: 0;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 900px; margin: 0 auto; padding: 20px 18px 40px; }
  header.brand {
    background: var(--panel);
    border-bottom: 1px solid var(--line);
    padding: 14px 18px;
    margin: -20px -18px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brand-mark {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 8px;
    background: var(--green);
    color: #fff;
    font-weight: 800;
    font-size: 14px;
    letter-spacing: 0.5px;
  }
  header.brand h1 {
    margin: 0;
    font-size: 18px;
    line-height: 1.2;
    color: var(--ink);
    font-weight: 700;
  }
  header.brand .meta {
    color: var(--muted);
    font-size: 12px;
    margin-top: 2px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  header.brand .title-block { flex: 1; }
  .pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--green-soft-border);
    border-radius: 999px;
    padding: 4px 10px;
    color: var(--green-dark);
    background: var(--green-soft);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }
  .pill.warn { color: #7a4a10; border-color: #e6c48d; background: #fbf1de; }
  .pill.danger { color: #8b3d24; border-color: #e6b7a3; background: #fbe8de; }
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 16px 18px;
    margin-bottom: 14px;
    box-shadow: var(--shadow-card);
  }
  h2 {
    font-size: 12px;
    letter-spacing: 0.8px;
    color: var(--muted);
    text-transform: uppercase;
    margin: 0 0 10px;
    font-weight: 700;
  }
  .kpi-num {
    font-size: 32px;
    line-height: 1.1;
    font-weight: 700;
    color: var(--green-dark);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.5px;
  }
  .kpi-num .u { color: var(--muted); font-size: 14px; font-weight: 500; margin-left: 6px; }
  .kpi-interp { color: var(--muted); font-size: 14px; margin-top: 6px; line-height: 1.4; }
  .rec-box {
    border-left: 3px solid var(--green);
    background: var(--green-soft);
    color: var(--green-dark);
    padding: 12px 14px;
    border-radius: 0 var(--radius) var(--radius) 0;
    margin: 12px 0 14px;
    font-size: 14px;
  }
  .rec-box strong { display: block; font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 3px; color: var(--green); }
  ul.alertas { margin: 0; padding: 8px 12px 8px 26px; background: #fbf7ea; border: 1px solid #e6d99a; border-radius: var(--radius); }
  ul.alertas li { margin: 4px 0; color: #6a4d0e; font-size: 13px; }
  table.data { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.data th, table.data td { padding: 8px 10px; text-align: left; }
  table.data thead th { background: var(--bg); color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--line); }
  table.data tbody tr + tr td { border-top: 1px solid var(--line); }
  table.data td.num, table.data th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  @media (max-width: 640px) { .grid-2 { grid-template-columns: 1fr; } }
  svg.chart { max-width: 100%; height: auto; display: block; margin: 6px 0; }
  svg .grid { stroke: var(--line); stroke-width: 1; }
  svg .zero { stroke: var(--muted); stroke-dasharray: 3 3; opacity: 0.6; }
  svg .line { stroke: var(--green); stroke-width: 2; }
  svg .axis { font-size: 10px; fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  svg .lbl { font-size: 11px; fill: var(--muted); }
  svg .hdr { font-size: 10px; fill: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  svg .cell { font-size: 10px; fill: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  svg .opt { stroke: var(--green-dark); stroke-width: 1; stroke-dasharray: 3 3; }
  svg .opt-dot { fill: var(--green-dark); }
  svg .cap { font-size: 10px; fill: var(--muted); }
  .footer-note { color: var(--muted); font-size: 12px; margin-top: 24px; padding-top: 12px; border-top: 1px solid var(--line); }
  pre.params { background: var(--bg); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px 12px; overflow: auto; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  @media print {
    header.brand { background: transparent; border: none; padding-left: 0; padding-right: 0; }
    .noprint { display: none; }
    main { max-width: none; padding: 0; }
    .card { box-shadow: none; page-break-inside: avoid; }
    body { background: #fff; }
  }
`;

/** Fragmento reutilizable con logo + título + metadata. */
export function tolvinkHeader(title: string, meta: string[] = []): string {
  const metaHtml = meta
    .map((m) => `<span class="pill">${escapeHtml(m)}</span>`)
    .join('');
  return `
<header class="brand">
  <div class="brand-mark" aria-hidden="true">TV</div>
  <div class="title-block">
    <h1>${escapeHtml(title)}</h1>
    ${meta.length ? `<div class="meta">${metaHtml}</div>` : ''}
  </div>
</header>`;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtN(n: number, decimals = 2): string {
  return n.toLocaleString('es-UY', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
