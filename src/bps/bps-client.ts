import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as cheerio from 'cheerio';

// =====================================================================
// Cliente HTTP hacia BPS (serviciosenlinea.bps.gub.uy).
// Los servicios de BPS son páginas web (no API JSON): este cliente scriptea
// la sesión y parsea HTML. Los marcadores de texto y paths son configurables
// por env para poder recalibrarlos sin redeploy si BPS cambia el markup.
// Ante cualquier ambigüedad los parsers devuelven DESCONOCIDO — nunca
// inventan estado.
// =====================================================================

export type BpsEstadoCertificado = 'VIGENTE' | 'NO_VIGENTE' | 'EN_TRAMITE' | 'DESCONOCIDO';
export type BpsEstadoDato = 'OK' | 'ATENCION' | 'DESCONOCIDO';

export interface BpsResultadoVigencia {
  estado: BpsEstadoCertificado;
  razonSocial?: string;
  vigenteHasta?: Date;
  rawExtracto: string;
}

export interface BpsDato {
  estado: BpsEstadoDato;
  resumen: string;
  detalle?: any;
}

export interface BpsSesion {
  cookies: string;
}

export class BpsLoginError extends Error {}
export class BpsCaptchaError extends Error {
  constructor() { super('BPS solicitó un captcha — la consulta automática no puede continuar'); }
}
export class BpsUnavailableError extends Error {}

const MAX_BODY_BYTES = 1_500_000;
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000];

// ── Normalización: minúsculas, sin tildes, espacios colapsados ──
export function normalizarTexto(html: string): string {
  const $ = cheerio.load(html);
  return $('body').text()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

function extraerFecha(texto: string, despuesDe: RegExp): Date | undefined {
  const m = texto.match(despuesDe);
  if (!m) return undefined;
  const f = m[1].match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!f) return undefined;
  const d = new Date(Date.UTC(+f[3], +f[2] - 1, +f[1]));
  return isNaN(d.getTime()) ? undefined : d;
}

// ── Parsers puros (testeables sin red) ──

export function parseVigencia(html: string): BpsResultadoVigencia {
  const t = normalizarTexto(html);
  const rawExtracto = t.slice(0, 500);
  // La negación se evalúa primero: "no posee certificado" contiene "posee certificado"
  if (/no (posee|registra|cuenta con) certificado/.test(t) || /certificado (comun )?(no vigente|vencido)/.test(t)) {
    return { estado: 'NO_VIGENTE', rawExtracto };
  }
  if (/en tramite|solicitud (en proceso|pendiente)/.test(t)) {
    return { estado: 'EN_TRAMITE', rawExtracto };
  }
  if (/(posee|cuenta con|registra) certificado (comun )?vigente|certificado (comun )?vigente/.test(t)) {
    return {
      estado: 'VIGENTE',
      vigenteHasta: extraerFecha(t, /(?:vigente hasta|vencimiento|valido hasta)[:\s]*([\d/]+)/),
      rawExtracto,
    };
  }
  return { estado: 'DESCONOCIDO', rawExtracto };
}

export function parseObservaciones(html: string): BpsDato {
  const t = normalizarTexto(html);
  if (/sin observaciones|no (registra|presenta|posee) observaciones/.test(t)) {
    return { estado: 'OK', resumen: 'Sin observaciones que traben la emisión del certificado' };
  }
  const $ = cheerio.load(html);
  const filas = $('table tr').slice(1).map((_, el) => cheerio.load(el).text().replace(/\s+/g, ' ').trim()).get()
    .filter((x) => x.length > 3).slice(0, 20);
  if (/observacion(es)?/.test(t) && filas.length > 0) {
    return { estado: 'ATENCION', resumen: `${filas.length} observación(es) pendiente(s)`, detalle: { items: filas } };
  }
  if (/observacion(es)? pendiente/.test(t)) {
    return { estado: 'ATENCION', resumen: 'Observaciones pendientes (ver portal BPS)' };
  }
  return { estado: 'DESCONOCIDO', resumen: 'No se pudo interpretar la respuesta de BPS' };
}

export function parseObligaciones(html: string): BpsDato {
  const t = normalizarTexto(html);
  if (/no (registra|posee|tiene) (obligaciones|deudas?|facturas?) (pendientes|impagas)|al dia con (sus )?obligaciones/.test(t)) {
    return { estado: 'OK', resumen: 'Sin obligaciones pendientes' };
  }
  const $ = cheerio.load(html);
  const filas = $('table tr').slice(1).map((_, el) => cheerio.load(el).text().replace(/\s+/g, ' ').trim()).get()
    .filter((x) => /\d/.test(x)).slice(0, 20);
  if (/(deuda|vencid|pendiente de pago|obligacion(es)? pendiente)/.test(t)) {
    return {
      estado: 'ATENCION',
      resumen: filas.length ? `${filas.length} obligación(es) pendiente(s) o vencida(s)` : 'Obligaciones pendientes (ver portal BPS)',
      detalle: filas.length ? { items: filas } : undefined,
    };
  }
  if (filas.length > 0 && /(vencimiento|importe|factura)/.test(t)) {
    return { estado: 'ATENCION', resumen: `${filas.length} obligación(es) próximas a vencer`, detalle: { items: filas } };
  }
  return { estado: 'DESCONOCIDO', resumen: 'No se pudo interpretar la respuesta de BPS' };
}

export function parseNomina(html: string): BpsDato {
  const t = normalizarTexto(html);
  if (/(declaracion(es)?|nomina(s)?) (presentada|procesada|aceptada)(s)? (correctamente|sin errores)?|sin declaraciones pendientes/.test(t)) {
    return { estado: 'OK', resumen: 'Declaraciones de nómina al día' };
  }
  if (/(declaracion|nomina).*(pendiente|rechazada|observada|con errores)|(pendiente|rechazada|observada).*(declaracion|nomina)/.test(t)) {
    return { estado: 'ATENCION', resumen: 'Declaraciones de nómina pendientes u observadas (ver portal BPS)' };
  }
  return { estado: 'DESCONOCIDO', resumen: 'No se pudo interpretar la respuesta de BPS' };
}

export function detectarCaptcha(html: string): boolean {
  return /captcha|recaptcha|g-recaptcha|hcaptcha/i.test(html);
}

// ── Cliente ──

@Injectable()
export class BpsClient {
  private readonly logger = new Logger(BpsClient.name);
  private lastRequestAt = 0;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl() { return this.config.get<string>('BPS_BASE_URL') || 'https://serviciosenlinea.bps.gub.uy'; }
  private get rateLimitMs() { return parseInt(this.config.get<string>('BPS_RATE_LIMIT_MS') || '1200', 10); }
  private path(key: string, def: string) { return this.config.get<string>(key) || def; }

  /** Espera para respetar el rate limit saliente hacia BPS (con jitter). */
  private async gate() {
    const wait = this.lastRequestAt + this.rateLimitMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 300)));
    this.lastRequestAt = Date.now();
  }

  private async fetchBps(url: string, init: RequestInit, cookies?: string): Promise<{ res: Response; body: string; setCookies: string[] }> {
    await this.gate();
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, {
          ...init,
          redirect: 'manual',
          headers: {
            'User-Agent': 'Tolvink/4.x (+https://tolvink.com)',
            'Accept': 'text/html,application/xhtml+xml',
            ...(cookies ? { Cookie: cookies } : {}),
            ...(init.headers || {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
        const len = parseInt(res.headers.get('content-length') || '0', 10);
        if (len > MAX_BODY_BYTES) throw new BpsUnavailableError('Respuesta de BPS demasiado grande');
        if (res.status >= 500 || res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS[attempt];
          lastErr = new BpsUnavailableError(`BPS respondió ${res.status}`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const body = (await res.text()).slice(0, MAX_BODY_BYTES);
        const setCookies = res.headers.getSetCookie?.() || [];
        return { res, body, setCookies };
      } catch (e: any) {
        if (e instanceof BpsUnavailableError) throw e;
        lastErr = e;
        if (attempt < MAX_RETRIES - 1) await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }
    }
    throw new BpsUnavailableError(`No se pudo conectar con BPS: ${lastErr?.message || 'error desconocido'}`);
  }

  private mergeCookies(existing: string, setCookies: string[]): string {
    const jar = new Map<string, string>();
    for (const c of existing.split('; ').filter(Boolean)) {
      const i = c.indexOf('=');
      if (i > 0) jar.set(c.slice(0, i), c.slice(i + 1));
    }
    for (const sc of setCookies) {
      const first = sc.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1));
    }
    return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Sigue redirects manualmente acumulando cookies (máx. 5 saltos). */
  private async followRedirects(start: { res: Response; body: string; setCookies: string[] }, cookies: string) {
    let cur = start;
    let jar = this.mergeCookies(cookies, cur.setCookies);
    for (let hop = 0; hop < 5 && cur.res.status >= 300 && cur.res.status < 400; hop++) {
      const loc = cur.res.headers.get('location');
      if (!loc) break;
      const url = new URL(loc, this.baseUrl).toString();
      if (!url.startsWith(this.baseUrl)) throw new BpsUnavailableError('Redirect fuera del dominio BPS');
      cur = await this.fetchBps(url, { method: 'GET' }, jar);
      jar = this.mergeCookies(jar, cur.setCookies);
    }
    return { ...cur, cookies: jar };
  }

  private hiddenFields(html: string): Record<string, string> {
    const $ = cheerio.load(html);
    const out: Record<string, string> = {};
    $('input[type="hidden"]').each((_, el) => {
      const name = $(el).attr('name');
      if (name) out[name] = $(el).attr('value') || '';
    });
    return out;
  }

  // ── Consulta pública de vigencia (sin usuario) ──
  async consultarVigencia(rut: string): Promise<BpsResultadoVigencia> {
    const pagePath = this.path('BPS_VIGENCIA_PATH', '/ServiciosEnLineaWeb/consultaVigenciaCertificado');
    const page = await this.fetchBps(`${this.baseUrl}${pagePath}`, { method: 'GET' });
    const landed = await this.followRedirects(page, '');
    if (detectarCaptcha(landed.body)) throw new BpsCaptchaError();

    const form = new URLSearchParams({
      ...this.hiddenFields(landed.body),
      [this.path('BPS_VIGENCIA_RUT_FIELD', 'rut')]: rut,
    });
    const post = await this.fetchBps(`${this.baseUrl}${pagePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, landed.cookies);
    const result = await this.followRedirects(post, landed.cookies);
    if (detectarCaptcha(result.body)) throw new BpsCaptchaError();
    return parseVigencia(result.body);
  }

  // ── Sesión autenticada (usuario BPS directo) ──
  async login(usuario: string, password: string): Promise<BpsSesion> {
    const loginPath = this.path('BPS_LOGIN_PATH', '/ServiciosEnLineaWeb/login');
    const page = await this.fetchBps(`${this.baseUrl}${loginPath}`, { method: 'GET' });
    const landed = await this.followRedirects(page, '');
    if (detectarCaptcha(landed.body)) throw new BpsCaptchaError();

    const form = new URLSearchParams({
      ...this.hiddenFields(landed.body),
      [this.path('BPS_LOGIN_USER_FIELD', 'usuario')]: usuario,
      [this.path('BPS_LOGIN_PASS_FIELD', 'password')]: password,
    });
    const post = await this.fetchBps(`${this.baseUrl}${loginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }, landed.cookies);
    const result = await this.followRedirects(post, landed.cookies);

    if (detectarCaptcha(result.body)) throw new BpsCaptchaError();
    const t = normalizarTexto(result.body);
    const failMarker = (this.config.get<string>('BPS_LOGIN_FAIL_MARKER') || 'usuario o contrasena|credenciales invalidas|datos incorrectos').toLowerCase();
    if (new RegExp(failMarker).test(t)) throw new BpsLoginError('BPS rechazó el usuario o la contraseña');
    const okMarker = (this.config.get<string>('BPS_LOGIN_OK_MARKER') || 'cerrar sesion|salir|mis servicios').toLowerCase();
    if (!new RegExp(okMarker).test(t)) {
      this.logger.warn('Login BPS: no se detectó el marcador de sesión iniciada — markup posiblemente cambiado');
      throw new BpsLoginError('No se pudo verificar el inicio de sesión en BPS (posible cambio en el portal)');
    }
    return { cookies: result.cookies };
  }

  private async consultaAutenticada(sesion: BpsSesion, pathKey: string, defPath: string, parser: (html: string) => BpsDato): Promise<BpsDato> {
    const page = await this.fetchBps(`${this.baseUrl}${this.path(pathKey, defPath)}`, { method: 'GET' }, sesion.cookies);
    const landed = await this.followRedirects(page, sesion.cookies);
    if (detectarCaptcha(landed.body)) throw new BpsCaptchaError();
    return parser(landed.body);
  }

  obtenerObservaciones(sesion: BpsSesion) {
    return this.consultaAutenticada(sesion, 'BPS_OBSERVACIONES_PATH', '/ServiciosEnLineaWeb/certificados/observaciones', parseObservaciones);
  }
  obtenerObligaciones(sesion: BpsSesion) {
    return this.consultaAutenticada(sesion, 'BPS_OBLIGACIONES_PATH', '/ServiciosEnLineaWeb/pagos/obligaciones', parseObligaciones);
  }
  obtenerNomina(sesion: BpsSesion) {
    return this.consultaAutenticada(sesion, 'BPS_NOMINA_PATH', '/ServiciosEnLineaWeb/nomina/estado', parseNomina);
  }
}
