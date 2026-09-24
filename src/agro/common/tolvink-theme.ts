/**
 * Identidad visual Tolvink — 1:1 con las vistas públicas ya existentes en
 * el repo (`src/freight-locations/freight-locations.controller.ts` y
 * `src/whatsapp/whatsapp.controller.ts`). Cualquier ajuste al design system
 * de Tolvink se replica primero acá para que informe/decisiones queden
 * alineados.
 *
 * Ejes de la identidad:
 *   - Paleta VERDE light-only (nunca dark mode).
 *   - Tipografía Inter (fallback ui-sans-serif → system-ui → -apple-system →
 *     BlinkMacSystemFont → "Segoe UI").
 *   - Layout `main` = grid vertical 3-rows: header · body · sheet.
 *   - Header con `.brand` centrado a max-width 1040-1120px, brand-mark
 *     34×34 con la letra "T" en verde sólido.
 *   - Sheet/panel al fondo con `box-shadow: 0 -14px 30px rgba(23,33,27,.08)`
 *     — sombra ELEVADA HACIA ARRIBA, signature del sistema.
 *   - Botones 48px min-height con `font-weight: 800`.
 *   - Focus rings verdes translúcidos: `outline: 2px solid rgba(35,99,63,.2)`
 *     + border-color: green.
 *   - Radios: 8px (elementos), 999px (chips/pills), 12px (cards de segundo
 *     nivel opcional).
 *   - Transitions sutiles 150ms sobre hover/focus/toggle (coherentes con
 *     un sistema minimal — Tolvink NO usa animaciones de background, keyframes
 *     ni parallax; la interacción es tranquila).
 */

export const TOLVINK_TOKENS = /* css */ `
  :root {
    --ink: #17211b;
    --muted: #5c675f;
    --line: #d8ded5;
    --line-input: #c9d5ca;
    --bg: #f5f7f3;
    --panel: #fff;
    --panel-soft: #fbfcfa;
    --green: #23633f;
    --green-dark: #164c33;
    --green-soft: #eef6f0;
    --green-soft-border: #b8cfbf;
    --green-selected: #e8f3ec;
    --secondary: #e8eee6;
    --danger: #a24a2b;
    --red: #a33a2b;
    --amber: #b86e12;
    --blue: #2563a9;
    --violet: #7257a8;
    --shadow-up: 0 -14px 30px rgba(23, 33, 27, 0.08);
    --shadow-card: 0 2px 8px rgba(23, 33, 27, 0.05);
    --focus-ring: 0 0 0 2px rgba(35, 99, 63, 0.2);
    --radius: 8px;
    --radius-lg: 12px;
    --radius-pill: 999px;
    --transition: 150ms ease;
    --content-max: 1040px;
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
    text-rendering: optimizeLegibility;
  }

  /* ── LAYOUT ─────────────────────────────────────────────────────── */
  main {
    min-height: 100vh;
    display: grid;
    grid-template-rows: auto 1fr auto;
  }

  /* ── HEADER (patrón exacto Tolvink) ─────────────────────────────── */
  header.brand {
    padding: 16px 18px 14px;
    background: var(--panel);
    border-bottom: 1px solid var(--line);
  }
  header.brand .wrap {
    max-width: var(--content-max);
    margin: 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  header.brand .brand-left {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
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
    font-size: 15px;
    letter-spacing: 0;
    flex-shrink: 0;
  }
  header.brand h1 {
    margin: 0;
    font-size: 20px;
    line-height: 1.2;
    color: var(--ink);
    font-weight: 700;
  }
  header.brand .subtitle {
    margin: 4px 0 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.35;
  }
  header.brand .meta {
    margin-top: 4px;
    color: var(--muted);
    font-size: 13px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  /* ── PILL ───────────────────────────────────────────────────────── */
  .pill {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--green-soft-border);
    border-radius: var(--radius-pill);
    padding: 6px 10px;
    color: var(--green-dark);
    background: var(--green-soft);
    font-size: 12px;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.2px;
    white-space: nowrap;
  }
  .pill.muted {
    border-color: var(--line);
    color: var(--muted);
    background: var(--panel-soft);
  }
  .pill.warn { color: #7a4a10; border-color: #e6c48d; background: #fbf1de; }
  .pill.danger { color: #8b3d24; border-color: #e6b7a3; background: #fbe8de; }

  /* ── SHEET / PANEL ELEVADO ───────────────────────────────────────── */
  section.sheet {
    background: var(--panel);
    border-top: 1px solid var(--line);
    box-shadow: var(--shadow-up);
    padding: 14px 18px 18px;
  }
  section.sheet > .wrap {
    max-width: var(--content-max);
    margin: 0 auto;
    display: grid;
    gap: 14px;
  }

  /* ── CARDS ──────────────────────────────────────────────────────── */
  .card {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 16px 18px;
    box-shadow: var(--shadow-card);
  }
  .card + .card { margin-top: 0; }
  .card h2 {
    font-size: 12px;
    letter-spacing: 0.8px;
    color: var(--muted);
    text-transform: uppercase;
    margin: 0 0 12px;
    font-weight: 700;
  }

  /* ── KPI ───────────────────────────────────────────────────────── */
  .kpi-num {
    font-size: 34px;
    line-height: 1.1;
    font-weight: 700;
    color: var(--green-dark);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.5px;
  }
  .kpi-num .u {
    color: var(--muted);
    font-size: 14px;
    font-weight: 500;
    margin-left: 6px;
    letter-spacing: 0;
  }
  .kpi-interp {
    color: var(--muted);
    font-size: 14px;
    margin-top: 8px;
    line-height: 1.5;
  }

  /* ── RECOMENDACIÓN — ACENTO LATERAL ─────────────────────────────── */
  .rec-box {
    border-left: 3px solid var(--green);
    background: var(--green-soft);
    color: var(--green-dark);
    padding: 12px 14px;
    border-radius: 0 var(--radius) var(--radius) 0;
    font-size: 14px;
    line-height: 1.5;
  }
  .rec-box strong {
    display: block;
    font-size: 11px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    margin-bottom: 4px;
    color: var(--green);
    font-weight: 700;
  }

  /* ── ALERTAS (amber-toned) ──────────────────────────────────────── */
  ul.alertas {
    margin: 0;
    padding: 8px 12px 8px 30px;
    background: #fbf7ea;
    border: 1px solid #e6d99a;
    border-left: 3px solid var(--amber);
    border-radius: 0 var(--radius) var(--radius) 0;
    list-style: disc;
  }
  ul.alertas li { margin: 4px 0; color: #6a4d0e; font-size: 13px; line-height: 1.5; }

  /* ── TABLAS ─────────────────────────────────────────────────────── */
  table.data {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  table.data th, table.data td {
    padding: 9px 10px;
    text-align: left;
  }
  table.data thead th {
    background: var(--bg);
    color: var(--muted);
    font-weight: 700;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--line);
  }
  table.data tbody tr + tr td { border-top: 1px solid var(--line); }
  table.data td.num, table.data th.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  table.data tbody tr:hover { background: var(--panel-soft); }

  /* ── FORM CONTROLS (por si informes futuros los usan) ───────────── */
  label { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
  input, textarea, select {
    width: 100%;
    border: 1px solid var(--line-input);
    border-radius: var(--radius);
    padding: 12px 13px;
    font-size: 16px;
    color: var(--ink);
    background: #fff;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  input:focus, textarea:focus, select:focus {
    outline: none;
    border-color: var(--green);
    box-shadow: var(--focus-ring);
  }
  button {
    min-height: 48px;
    border: 0;
    border-radius: var(--radius);
    padding: 12px 14px;
    font-size: 15px;
    font-weight: 800;
    background: var(--green);
    color: #fff;
    cursor: pointer;
    transition: background var(--transition), transform var(--transition);
  }
  button:hover:not(:disabled) { background: var(--green-dark); }
  button:active:not(:disabled) { transform: translateY(1px); }
  button.secondary { background: var(--secondary); color: var(--ink); }
  button.secondary:hover:not(:disabled) { background: #dbe2d7; }
  button:disabled { opacity: 0.55; cursor: default; }

  /* ── CHIPS ──────────────────────────────────────────────────────── */
  .chips {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: thin;
  }
  .chip {
    flex: 0 0 auto;
    border: 1px solid var(--line-input);
    border-radius: var(--radius-pill);
    padding: 9px 12px;
    background: #fff;
    color: var(--ink);
    font-weight: 700;
    font-size: 14px;
    cursor: pointer;
    transition: border-color var(--transition), background var(--transition), color var(--transition);
  }
  .chip:hover { border-color: var(--green-soft-border); }
  .chip.selected {
    border-color: var(--green);
    background: var(--green-selected);
    color: var(--green-dark);
  }

  /* ── SVG CHARTS ─────────────────────────────────────────────────── */
  svg.chart {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 6px 0;
  }
  svg .grid { stroke: var(--line); stroke-width: 1; }
  svg .zero { stroke: var(--muted); stroke-dasharray: 3 3; opacity: 0.55; }
  svg .line { stroke: var(--green); stroke-width: 2; fill: none; }
  svg .axis { font-size: 10px; fill: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  svg .lbl { font-size: 11px; fill: var(--muted); font-weight: 500; }
  svg .hdr { font-size: 10px; fill: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  svg .cell { font-size: 10px; fill: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 500; }
  svg .opt { stroke: var(--green-dark); stroke-width: 1; stroke-dasharray: 3 3; }
  svg .opt-dot { fill: var(--green-dark); stroke: #fff; stroke-width: 2; }
  svg .cap { font-size: 10px; fill: var(--muted); }

  /* ── SEMÁFORO caja ───────────────────────────────────────────────── */
  .semaforo-rojo { color: var(--danger); font-weight: 700; }
  .semaforo-amarillo { color: var(--amber); font-weight: 700; }
  .semaforo-ok { color: var(--green-dark); font-weight: 700; }

  /* ── PARAMS block ───────────────────────────────────────────────── */
  pre.params {
    background: var(--panel-soft);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 10px 12px;
    overflow: auto;
    font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--ink);
    line-height: 1.5;
  }

  /* ── FOOTER NOTE ────────────────────────────────────────────────── */
  .footer-note {
    color: var(--muted);
    font-size: 12px;
    margin-top: 24px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
    text-align: center;
  }

  /* ── CONTENT WRAP (aplica dentro de body) ───────────────────────── */
  .content {
    max-width: var(--content-max);
    margin: 0 auto;
    padding: 20px 18px 40px;
    display: grid;
    gap: 14px;
  }

  /* ── RESPONSIVE (breakpoints Tolvink) ───────────────────────────── */
  @media (max-width: 680px) {
    header.brand { padding: 13px 14px 11px; }
    header.brand h1 { font-size: 18px; }
    .content { padding: 16px 14px 32px; gap: 12px; }
    .card { padding: 14px 14px; }
    .kpi-num { font-size: 28px; }
    /* Pill de contexto se oculta en mobile como en el resto de Tolvink */
    header.brand .pill.hide-mobile { display: none; }
  }

  @media (min-width: 900px) {
    /* Ligero aire extra en desktop, alineado con la home pública */
    header.brand { padding: 18px 22px 16px; }
    .content { padding: 28px 22px 48px; gap: 16px; }
  }

  /* ── PRINT ──────────────────────────────────────────────────────── */
  @page { size: A4; margin: 16mm; }
  @media print {
    :root { --shadow-up: none; --shadow-card: none; }
    body { background: #fff; }
    header.brand { background: transparent; border-bottom: 1px solid var(--line); }
    .noprint { display: none !important; }
    .content { padding: 0; max-width: none; }
    .card { break-inside: avoid; page-break-inside: avoid; box-shadow: none; }
  }
`;

/**
 * Header canónico de Tolvink: brand-mark "T" + título + subtítulo/meta
 * opcional, con pill de contexto a la derecha (opcional).
 *
 * @param title título grande (h1)
 * @param opts.subtitle línea muted debajo del h1 (una sola frase)
 * @param opts.metaPills pills en fila debajo del h1 (múltiples etiquetas)
 * @param opts.contextPill pill a la derecha (ej. "Agro", "Tolvink")
 */
export function tolvinkHeader(
  title: string,
  opts: {
    subtitle?: string;
    metaPills?: string[];
    contextPill?: string;
  } = {},
): string {
  const metaHtml =
    opts.metaPills && opts.metaPills.length
      ? `<div class="meta">${opts.metaPills
          .map((m) => `<span class="pill muted">${escapeHtml(m)}</span>`)
          .join('')}</div>`
      : '';
  const subtitleHtml = opts.subtitle
    ? `<p class="subtitle">${escapeHtml(opts.subtitle)}</p>`
    : '';
  const contextHtml = opts.contextPill
    ? `<span class="pill hide-mobile">${escapeHtml(opts.contextPill)}</span>`
    : '';
  return `
<header class="brand">
  <div class="wrap">
    <div class="brand-left">
      <span class="brand-mark" aria-hidden="true">T</span>
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitleHtml}
        ${metaHtml}
      </div>
    </div>
    ${contextHtml}
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
