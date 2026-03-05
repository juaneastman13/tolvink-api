import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { DocType, OcrResult } from './ocr.dto';

const MODEL_ID = 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `Sos un asistente de OCR especializado en documentos de transporte de granos en Argentina y Uruguay.
Analizá la imagen y extraé todos los datos relevantes en formato JSON estructurado.
Respondé SOLO con JSON válido, sin texto adicional, sin markdown code fences.
Si no podés leer algún campo, poné null en su valor.
Incluí siempre un campo "confianza" de 0 a 1 indicando qué tan seguro estás de la extracción.
REGLA IMPORTANTE: Nunca agrupes varios valores en un solo campo separados por ";" o ",". Cada dato debe tener su propio campo individual. Por ejemplo, en vez de "origen": "Mercedes; Soriano" usá "origenLocalidad": "Mercedes", "origenProvincia": "Soriano". Los objetos dentro de "datos" deben ser siempre valores planos (string, number, null), nunca objetos anidados ni arrays (excepto items en remitos).`;

const DOC_PROMPTS: Record<string, string> = {
  carta_porte: `Extraé de esta carta de porte los siguientes datos en JSON.
Cada campo debe ser un valor individual (nunca agrupar varios datos en un campo):
{
  "tipoDocumento": "carta_porte",
  "datos": {
    "numero": "número de carta de porte",
    "ctg": "código de trazabilidad de granos",
    "fecha": "fecha del documento (YYYY-MM-DD)",
    "origenLocalidad": "localidad de origen",
    "origenProvincia": "provincia de origen",
    "origenEstablecimiento": "nombre del establecimiento de origen",
    "destinoPlanta": "nombre de la planta de destino",
    "destinoLocalidad": "localidad de destino",
    "destinoProvincia": "provincia de destino",
    "grano": "tipo de grano",
    "pesoNeto": 0,
    "pesoBruto": 0,
    "tara": 0,
    "patente": "patente del camión",
    "patenteAcoplado": "patente del acoplado",
    "chofer": "nombre del chofer",
    "observaciones": ""
  },
  "confianza": 0.0
}`,

  remito: `Extraé de este remito los siguientes datos en JSON:
{
  "tipoDocumento": "remito",
  "datos": {
    "numero": "número de remito",
    "fecha": "fecha (YYYY-MM-DD)",
    "proveedor": "nombre del proveedor/remitente",
    "destinatario": "nombre del destinatario",
    "items": [{ "producto": "", "cantidad": 0, "unidad": "" }],
    "observaciones": ""
  },
  "confianza": 0.0
}`,

  pesaje: `Extraé de este ticket de pesaje los siguientes datos en JSON:
{
  "tipoDocumento": "pesaje",
  "datos": {
    "pesoBruto": 0,
    "tara": 0,
    "pesoNeto": 0,
    "fecha": "fecha (YYYY-MM-DD)",
    "hora": "hora (HH:MM)",
    "patente": "patente del camión",
    "producto": "tipo de producto/grano",
    "observaciones": ""
  },
  "confianza": 0.0
}`,

  general: `Detectá qué tipo de documento es esta imagen y extraé todos los datos relevantes.
Cada dato debe tener su propio campo individual — nunca agrupes múltiples valores en un campo separados por ";" o ",".
Respondé con JSON:
{
  "tipoDocumento": "tipo detectado (carta_porte, remito, pesaje, u otro)",
  "datos": { ... un campo por cada dato extraído, valores planos (string/number/null) ... },
  "confianza": 0.0
}`,
};

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private client: Anthropic | null = null;
  private supabaseUrl: string;

  constructor(private config: ConfigService) {
    const apiKey = config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log('OCR service enabled (Claude Vision)');
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — OCR disabled');
    }
    this.supabaseUrl = config.get<string>('SUPABASE_URL') || '';
  }

  /** Analyze image buffer directly */
  async analyze(buffer: Buffer, mimeType: string, docType?: DocType): Promise<OcrResult> {
    if (!this.client) throw new BadRequestException('OCR no disponible (API key no configurada)');
    if (buffer.length > MAX_BUFFER_SIZE) throw new BadRequestException('Imagen demasiado grande (máx 10 MB)');
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(`Tipo de archivo no soportado: ${mimeType}. Soportados: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    const base64 = buffer.toString('base64');
    const prompt = DOC_PROMPTS[docType || 'general'];

    this.logger.log(`OCR analyze: type=${docType || 'general'}, size=${buffer.length}, mime=${mimeType}`);

    const apiCall = this.client.messages.create({
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType as any, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    });

    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('OCR timeout')), TIMEOUT_MS),
    );

    const response = await Promise.race([apiCall, timeout]);

    const textBlock = (response as any).content?.find((b: any) => b.type === 'text');
    const raw = textBlock?.text || '';

    this.logger.log(`OCR response: ${raw.slice(0, 200)}`);

    return this.parseResponse(raw, docType);
  }

  /** Analyze from a public Supabase URL */
  async analyzeFromUrl(url: string, docType?: DocType): Promise<OcrResult> {
    this.validateUrl(url);

    const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!res.ok) throw new BadRequestException(`No se pudo descargar la imagen (HTTP ${res.status})`);

    // Check Content-Length before buffering to prevent memory exhaustion
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BUFFER_SIZE) {
      throw new BadRequestException(`Imagen demasiado grande (${Math.round(contentLength / 1024 / 1024)}MB, máx 10MB)`);
    }

    const contentType = res.headers.get('content-type');
    if (!contentType) throw new BadRequestException('El servidor no devolvió Content-Type — no se puede determinar el tipo de archivo');
    const mimeType = contentType.split(';')[0].trim();
    const arrayBuf = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    return this.analyze(buffer, mimeType, docType);
  }

  /** Validate URL is from our Supabase instance */
  private validateUrl(url: string): void {
    if (!this.supabaseUrl) throw new BadRequestException('Configuración de storage incompleta');
    try {
      const parsed = new URL(url);
      const expected = new URL(this.supabaseUrl);
      if (parsed.hostname !== expected.hostname) {
        throw new BadRequestException('URL no permitida — solo se aceptan archivos de Tolvink');
      }
      if (parsed.protocol !== 'https:') {
        throw new BadRequestException('Solo se aceptan URLs HTTPS');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('URL inválida');
    }
  }

  /** Flatten nested objects in datos: { origen: { localidad: "X" } } → { origenLocalidad: "X" } */
  private flattenDatos(datos: Record<string, any>, prefix = '', depth = 0): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(datos)) {
      const fullKey = prefix ? `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val) && depth < 5) {
        Object.assign(result, this.flattenDatos(val, fullKey, depth + 1));
      } else {
        result[fullKey] = val;
      }
    }
    return result;
  }

  /** Parse Claude response to structured OcrResult */
  private parseResponse(raw: string, docType?: DocType): OcrResult {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    try {
      const parsed = JSON.parse(cleaned);
      const rawDatos = parsed.datos || parsed;
      return {
        tipoDocumento: parsed.tipoDocumento || docType || 'desconocido',
        datos: this.flattenDatos(rawDatos),
        confianza: typeof parsed.confianza === 'number' ? Math.min(1, Math.max(0, parsed.confianza)) : (() => { this.logger.warn('OCR response missing confianza field — defaulting to 0.5'); return 0.5; })(),
        textoOriginal: raw.slice(0, 2000),
      };
    } catch {
      this.logger.warn(`OCR: failed to parse JSON response: ${raw.slice(0, 200)}`);
      return {
        tipoDocumento: docType || 'desconocido',
        datos: { textoExtraido: raw.slice(0, 3000) },
        confianza: 0.1,
        textoOriginal: raw.slice(0, 2000),
      };
    }
  }
}
