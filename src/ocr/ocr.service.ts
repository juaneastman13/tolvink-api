import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// TODO: OCR service needs refactoring to use Anthropic SDK in Etapa 1+ (was using Gemini + GoogleGenAI)
// import { GoogleGenAI } from '@google/genai';
import { DocType, OcrResult } from './ocr.dto';

const MAX_TOKENS = 2000;
const MAX_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT = `Sos un asistente de OCR especializado en documentos de transporte de granos en Argentina y Uruguay.
Analizá la imagen y extraé todos los datos relevantes en formato JSON estructurado.
Respondé SOLO con JSON válido, sin texto adicional, sin markdown code fences.
Si no podés leer algún campo, poné null en su valor.
REGLA IMPORTANTE: Nunca agrupes varios valores en un solo campo separados por ";" o ",". Cada dato debe tener su propio campo individual. Por ejemplo, en vez de "origen": "Mercedes; Soriano" usá "origenLocalidad": "Mercedes", "origenProvincia": "Soriano". Los objetos dentro de "datos" deben ser siempre valores planos (string, number, null), nunca objetos anidados ni arrays (excepto items en remitos).`;

// Phase 1: Structured extraction — attempts to extract known fields
const STRUCTURED_PROMPT = `Analizá este documento de logística agrícola. Extraé los siguientes campos en formato JSON.
Si un campo no está presente en el documento, poné null.

Campos a extraer:
- documentNumber: número de documento, remito, carta de porte, o referencia principal
- date: fecha del documento en formato DD/MM/AAAA. Si la fecha aparece separada (día, mes, año en campos distintos), unificarla en DD/MM/AAAA
- origin: lugar de origen, procedencia, o punto de carga
- destination: lugar de destino o punto de descarga
- product: producto, grano, o tipo de mercadería
- quantity: cantidad o peso neto como número
- quantityUnit: unidad de la cantidad (kg, tn, toneladas, quintales, etc.)
- producer: nombre del productor, remitente, o titular de la carga
- transporter: nombre de la empresa transportista
- grossWeight: peso bruto como número (si aplica)
- tareWeight: tara como número (si aplica)
- netWeight: peso neto como número (si aplica)
- truckPlate: patente o matrícula del camión
- driverName: nombre del conductor/chofer

Respondé SOLO con el JSON, sin explicaciones ni markdown.`;

// Phase 2: Free extraction — fallback when structured extraction yields mostly nulls
const FREE_PROMPT = `No se pudieron extraer los campos estándar de este documento.
Extraé TODOS los campos de texto que puedas identificar en formato JSON.
Cada key debe ser el nombre del campo como aparece en el documento y cada value su valor.
Incluí también:
- documentType: qué tipo de documento es (ticket de pesaje, remito, carta de porte, factura, análisis, etc.)
- summary: resumen de una línea del documento

Respondé SOLO con el JSON, sin explicaciones ni markdown.`;

// Legacy document-type-specific prompts (used when docType is explicitly provided)
const DOC_PROMPTS: Record<string, string> = {
  carta_porte: `Extraé de esta carta de porte los siguientes datos en JSON.
Cada campo debe ser un valor individual (nunca agrupar varios datos en un campo):
{
  "tipoDocumento": "carta_porte",
  "datos": {
    "numero": "número de carta de porte",
    "ctg": "código de trazabilidad de granos",
    "fecha": "fecha del documento (DD/MM/AAAA)",
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
    "fecha": "fecha (DD/MM/AAAA)",
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
    "fecha": "fecha (DD/MM/AAAA)",
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

// Structured fields that we check for null
const STRUCTURED_FIELDS = [
  'documentNumber', 'date', 'origin', 'destination', 'product',
  'quantity', 'quantityUnit', 'producer', 'transporter',
  'grossWeight', 'tareWeight', 'netWeight', 'truckPlate', 'driverName',
];

@Injectable()
export class OcrService {
  private readonly logger = new Logger(OcrService.name);
  private client: any | null = null; // TODO: GoogleGenAI removed - replace with Anthropic SDK
  private supabaseUrl: string;
  private readonly model: string;

  constructor(private config: ConfigService) {
    // TODO: Etapa 0 - GEMINI_* removed. OCR service disabled during rebuild
    // this.model = (config.get<string>('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL).trim();
    this.model = 'disabled-in-etapa-0';
    const apiKey = config.get<string>('GEMINI_API_KEY');
    if (apiKey && false) { // Disabled in Etapa 0
      // this.client = new GoogleGenAI({ apiKey });
      // this.logger.log(`OCR service enabled (Gemini Vision, model: ${this.model})`);
    } else {
      this.logger.warn('OCR service disabled during agent rebuild (Etapa 0). Will be restored in Etapa 1');
    }
    this.supabaseUrl = (config.get<string>('SUPABASE_URL') || '').trim();
  }

  /** Analyze image buffer — uses two-phase extraction when no docType specified */
  async analyze(buffer: Buffer, mimeType: string, docType?: DocType): Promise<OcrResult> {
    if (!this.client) throw new BadRequestException('OCR no disponible (API key no configurada)');
    if (buffer.length > MAX_BUFFER_SIZE) throw new BadRequestException('Imagen demasiado grande (máx 10 MB)');
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new BadRequestException(`Tipo de archivo no soportado: ${mimeType}. Soportados: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    const base64 = buffer.toString('base64');

    try {
      // If a specific docType is provided, use legacy prompts directly
      if (docType && DOC_PROMPTS[docType]) {
        this.logger.log(`OCR analyze (legacy): type=${docType}, size=${buffer.length}`);
        const raw = await this.callGeminiVision(base64, mimeType, DOC_PROMPTS[docType]);
        const result = this.parseResponse(raw, docType);
        result.datos._processedAt = new Date().toISOString();
        result.datos._model = this.model;
        return result;
      }

      // Phase 1: Structured extraction
      this.logger.log(`OCR analyze (structured phase 1): size=${buffer.length}, mime=${mimeType}`);
      const raw1 = await this.callGeminiVision(base64, mimeType, STRUCTURED_PROMPT);
      const parsed1 = this.parseStructuredResponse(raw1);

      // Count non-null structured fields
      const nonNullCount = STRUCTURED_FIELDS.filter(f => parsed1[f] != null && parsed1[f] !== '').length;
      const fillRate = nonNullCount / STRUCTURED_FIELDS.length;
      this.logger.log(`OCR phase 1: ${nonNullCount}/${STRUCTURED_FIELDS.length} fields filled (${Math.round(fillRate * 100)}%)`);

      // If >20% fields filled, use structured result
      if (fillRate > 0.2) {
        // Normalize date field
        if (parsed1.date) parsed1.date = this.normalizeDate(parsed1.date);

        const confidence = Math.round(fillRate * 100);
        return {
          tipoDocumento: this.inferDocType(parsed1),
          datos: parsed1,
          confianza: confidence / 100,
          textoOriginal: raw1.slice(0, 2000),
          structured: true,
          ...(fillRate < 0.15 ? { lowConfidence: true } : {}),
          processedAt: new Date().toISOString(),
          model: this.model,
        } as any;
      }

      // Phase 2: Free extraction (fallback)
      this.logger.log(`OCR analyze (free phase 2): structured yielded <20% fields, retrying with free extraction`);
      const raw2 = await this.callGeminiVision(base64, mimeType, FREE_PROMPT);
      const parsed2 = this.parseFreeResponse(raw2);

      return {
        tipoDocumento: parsed2.documentType || 'desconocido',
        datos: parsed2,
        confianza: 0,
        textoOriginal: raw2.slice(0, 2000),
        structured: false,
        lowConfidence: true, // Phase 2 fallback always flags low confidence
        processedAt: new Date().toISOString(),
        model: this.model,
      } as any;
    } catch (err) {
      this.logger.error(`OCR analyze failed: ${err.message}`);
      throw new BadRequestException(`OCR falló: ${err.message?.includes('timeout') ? 'timeout — intentá de nuevo' : 'error procesando imagen'}`);
    }
  }

  /** Call Gemini Vision API with timeout */
  private async callGeminiVision(base64: string, mimeType: string, prompt: string): Promise<string> {
    const apiCall = this.client!.models.generateContent({
      model: this.model,
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64 } },
          { text: prompt },
        ],
      }],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        maxOutputTokens: MAX_TOKENS,
      },
    });

    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error('OCR timeout')), TIMEOUT_MS);
    });

    let response: any;
    try {
      response = await Promise.race([apiCall, timeout]);
    } finally {
      clearTimeout(timeoutHandle!);
    }

    const candidate = response?.candidates?.[0];
    const textPart = candidate?.content?.parts?.find((p: any) => p.text);
    return textPart?.text || '';
  }

  /** Analyze from a public Supabase URL */
  async analyzeFromUrl(url: string, docType?: DocType): Promise<OcrResult> {
    const normalizedUrl = this.normalizeUrl(url);
    this.validateUrl(normalizedUrl);

    const res = await fetch(normalizedUrl, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!res.ok) throw new BadRequestException(`No se pudo descargar la imagen (HTTP ${res.status})`);

    // Check Content-Length before buffering to prevent memory exhaustion
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BUFFER_SIZE) {
      throw new BadRequestException(`Imagen demasiado grande (${Math.round(contentLength / 1024 / 1024)}MB, máx 10MB)`);
    }

    const contentType = res.headers.get('content-type');
    if (!contentType) throw new BadRequestException('El servidor no devolvió Content-Type — no se puede determinar el tipo de archivo');
    const mimeType = contentType.split(';')[0].trim();

    // Stream response body and abort if accumulated bytes exceed MAX_BUFFER_SIZE
    const reader = res.body?.getReader();
    if (!reader) throw new BadRequestException('No se pudo leer la respuesta');
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_BUFFER_SIZE) {
        reader.cancel();
        throw new BadRequestException('Imagen demasiado grande (máx 10 MB)');
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);

    return this.analyze(buffer, mimeType, docType);
  }

  /** Validate URL is from our Supabase instance (SSRF protection) */
  private validateUrl(url: string): void {
    if (!this.supabaseUrl) throw new BadRequestException('Configuración de storage incompleta');
    try {
      const parsed = new URL(this.normalizeUrl(url));
      const expected = new URL(this.supabaseUrl);
      // Compare full origin (protocol + hostname + port) — not just hostname
      if (parsed.origin !== expected.origin) {
        throw new BadRequestException('URL no permitida — solo se aceptan archivos de Tolvink');
      }
      if (parsed.protocol !== 'https:') {
        throw new BadRequestException('Solo se aceptan URLs HTTPS');
      }
      const isObjectPath = parsed.pathname.startsWith('/storage/v1/object/');
      const isRenderPath = parsed.pathname.startsWith('/storage/v1/render/image/');
      if (!isObjectPath && !isRenderPath) {
        throw new BadRequestException('URL no permitida — solo se aceptan archivos de storage');
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException('URL inválida');
    }
  }

  /** Flatten nested objects in datos: { origen: { localidad: "X" } } → { origenLocalidad: "X" } */
  private normalizeUrl(url: string): string {
    return typeof url === 'string' ? url.replace(/[\r\n\t]+/g, '').trim() : '';
  }

  private flattenDatos(datos: Record<string, any>, prefix = '', depth = 0): Record<string, any> {
    if (depth > 3 || Object.keys(datos).length > 100) return datos;
    const result: Record<string, any> = {};
    for (const [key, val] of Object.entries(datos)) {
      const fullKey = prefix ? `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val) && depth < 3) {
        Object.assign(result, this.flattenDatos(val, fullKey, depth + 1));
      } else {
        result[fullKey] = val;
      }
    }
    return result;
  }

  /** Parse structured phase 1 response */
  private parseStructuredResponse(raw: string): Record<string, any> {
    const cleaned = this.stripMarkdownFences(raw);
    try {
      const parsed = JSON.parse(cleaned);
      // Could be flat or nested under "data"/"datos"
      return parsed.data || parsed.datos || parsed;
    } catch {
      this.logger.warn(`OCR: failed to parse structured response (${raw.length} chars)`);
      return {};
    }
  }

  /** Parse free phase 2 response */
  private parseFreeResponse(raw: string): Record<string, any> {
    const cleaned = this.stripMarkdownFences(raw);
    try {
      const parsed = JSON.parse(cleaned);
      const result: Record<string, any> = {};
      // Extract documentType and summary
      if (parsed.documentType) result.documentType = parsed.documentType;
      if (parsed.summary) result.summary = parsed.summary;
      // Flatten all other fields into rawFields
      const rawFields: Record<string, any> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (k === 'documentType' || k === 'summary') continue;
        if (v != null && v !== '') rawFields[k] = v;
      }
      if (Object.keys(rawFields).length > 0) result.rawFields = rawFields;
      return result;
    } catch {
      this.logger.warn(`OCR: failed to parse free response (${raw.length} chars)`);
      return { textoExtraido: raw.slice(0, 3000), _parseError: true };
    }
  }

  /** Strip markdown fences from response */
  private stripMarkdownFences(raw: string): string {
    let cleaned = raw.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    return cleaned;
  }

  /** Normalize date to DD/MM/AAAA format */
  private normalizeDate(dateStr: string): string {
    if (!dateStr || typeof dateStr !== 'string') return dateStr;
    const s = dateStr.trim();

    // Already DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(s)) return s;

    // YYYY-MM-DD → DD/MM/YYYY
    const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[3]}/${isoMatch[2]}/${isoMatch[1]}`;

    // MM/DD/YYYY → DD/MM/YYYY (if month > 12 it's already DD/MM)
    const usMatch = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (usMatch) {
      const first = parseInt(usMatch[1], 10);
      const second = parseInt(usMatch[2], 10);
      // If first > 12, it's DD/MM/YYYY already
      if (first > 12) return s;
      // If second > 12, it's MM/DD/YYYY
      if (second > 12) return `${usMatch[2]}/${usMatch[1]}/${usMatch[3]}`;
      // Ambiguous — assume DD/MM (South American convention)
      return s;
    }

    return s;
  }

  /** Infer document type from structured data */
  private inferDocType(data: Record<string, any>): string {
    if (data.grossWeight != null || data.tareWeight != null || data.netWeight != null) return 'pesaje';
    if (data.documentNumber && (data.origin || data.destination)) return 'carta_porte';
    if (data.producer && data.product) return 'remito';
    return 'general';
  }

  /** Parse model response to structured OcrResult (legacy) */
  private parseResponse(raw: string, docType?: DocType): OcrResult {
    const cleaned = this.stripMarkdownFences(raw);
    try {
      const parsed = JSON.parse(cleaned);
      const rawDatos = parsed.datos || parsed;
      const confianza = typeof parsed.confianza === 'number' ? Math.min(1, Math.max(0, parsed.confianza)) : 0.5;
      return {
        tipoDocumento: parsed.tipoDocumento || docType || 'desconocido',
        datos: this.flattenDatos(rawDatos),
        confianza,
        textoOriginal: raw.slice(0, 2000),
        ...(confianza < 0.15 ? { lowConfidence: true } : {}),
      };
    } catch {
      this.logger.warn(`OCR: failed to parse JSON response (${raw.length} chars)`);
      return {
        tipoDocumento: docType || 'desconocido',
        datos: { textoExtraido: raw.slice(0, 3000), _parseError: true },
        confianza: 0.05,
        lowConfidence: true,
        textoOriginal: raw.slice(0, 2000),
      };
    }
  }
}
