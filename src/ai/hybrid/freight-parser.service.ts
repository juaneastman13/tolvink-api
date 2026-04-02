// =====================================================================
// TOLVINK — Freight Parser Service (Deterministic)
// Extracts freight creation data from natural language WITHOUT LLM
// Uses regex, keyword detection, and Spanish number normalization
// =====================================================================

import { Injectable } from '@nestjs/common';

export interface ParsedFreightData {
  grain?: string;
  tons?: number;
  loadDate?: string;       // YYYY-MM-DD
  loadTime?: string;       // HH:mm
  truckCount?: number;
  useOwnFleet?: boolean;
  destName?: string;
  originName?: string;
  notes?: string;
}

const GRAIN_MAP: Record<string, string> = {
  soja: 'Soja',
  soya: 'Soja',
  maiz: 'Maíz',
  maís: 'Maíz',
  trigo: 'Trigo',
  girasol: 'Girasol',
  sorgo: 'Sorgo',
  cebada: 'Cebada',
  arroz: 'Otros',
  avena: 'Otros',
  lino: 'Otros',
  colza: 'Otros',
  centeno: 'Otros',
};

// Fuzzy grain variants: common typos and voice-to-text errors
const GRAIN_FUZZY: Record<string, string> = {
  sojaa: 'Soja', sojia: 'Soja', zoja: 'Soja', soj: 'Soja',
  maizz: 'Maíz', maiss: 'Maíz', mais: 'Maíz', maíz: 'Maíz', maíss: 'Maíz',
  trigoo: 'Trigo', trgo: 'Trigo',
  jirasol: 'Girasol', girazol: 'Girasol',
  sorgoo: 'Sorgo',
  sebada: 'Cebada', cevada: 'Cebada',
};

const NUMBER_WORDS: Record<string, number> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5,
  seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintidos: 22, veinticinco: 25,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60,
  setenta: 70, ochenta: 80, noventa: 90, cien: 100,
};

@Injectable()
export class FreightParserService {

  /** Normalize text: lowercase, strip accents */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Replace Spanish number words with digits */
  private normalizeNumbers(text: string): string {
    let result = text;
    for (const [word, num] of Object.entries(NUMBER_WORDS)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), String(num));
    }
    // "X y cinco" → X+5
    result = result.replace(/\b(\d+)\s+y\s+(\d+)\b/g, (_, a, b) => String(Number(a) + Number(b)));
    // "X y medio" → X.5
    result = result.replace(/\b(\d+)\s+y\s+medi[oa]\b/gi, (_, n) => String(Number(n) + 0.5));
    result = result.replace(/\bmedia\s+tonelada\b/gi, '0.5');
    result = result.replace(/\btonelada\s+y\s+media\b/gi, '1.5');
    return result;
  }

  /** Parse a message for freight creation data. Returns partial data — missing fields will be asked. */
  parse(rawMessage: string): ParsedFreightData {
    const text = this.normalize(rawMessage);
    const numText = this.normalizeNumbers(text);
    const result: ParsedFreightData = {};

    // ---- GRAIN ----
    for (const [key, value] of Object.entries(GRAIN_MAP)) {
      if (new RegExp(`\\b${key}\\b`).test(text)) {
        result.grain = value;
        break;
      }
    }
    // Fuzzy grain matching: typos and voice-to-text errors
    if (!result.grain) {
      for (const [key, value] of Object.entries(GRAIN_FUZZY)) {
        if (new RegExp(`\\b${key}\\b`).test(text)) {
          result.grain = value;
          break;
        }
      }
    }

    // ---- TONS ----
    // "30 toneladas", "30 tn", "30 ton", "30t"
    const tonsPatterns = [
      /(\d+(?:[.,]\d+)?)\s*(?:toneladas?|tn|ton)\b/,
      /(\d+(?:[.,]\d+)?)\s*t\b/,
      // "300 quintales" → /10
      /(\d+(?:[.,]\d+)?)\s*(?:quintales?|qq)\b/,
    ];
    for (const p of tonsPatterns) {
      const m = numText.match(p);
      if (m) {
        let val = parseFloat(m[1].replace(',', '.'));
        if (p.source.includes('quintal')) val = val / 10; // quintales to tons
        if (val > 0 && val < 10000) {
          result.tons = val;
          break;
        }
      }
    }

    // If no tons unit found, look for standalone number after grain (e.g., "30 de soja")
    if (!result.tons && result.grain) {
      const numBeforeGrain = numText.match(/(\d+(?:[.,]\d+)?)\s+(?:de\s+)?\w+/);
      if (numBeforeGrain) {
        const val = parseFloat(numBeforeGrain[1].replace(',', '.'));
        if (val > 0 && val <= 5000) result.tons = val;
      }
    }

    // ---- TRUCK COUNT ----
    const truckCountPatterns = [
      /(\d+)\s*(?:camion(?:es)?|camión(?:es)?)/,
      /(?:camion(?:es)?|camión(?:es)?)\s*[:\s]*(\d+)/,
      /(\d+)\s*(?:viajes?)/,
    ];
    for (const p of truckCountPatterns) {
      const m = numText.match(p);
      if (m) {
        // Capture could be in group 1 or 2 depending on the pattern
        const raw = m[1] ?? m[2];
        if (!raw) continue;
        const count = parseInt(raw, 10);
        if (count > 0 && count <= 50) {
          result.truckCount = count;
          break;
        }
      }
    }

    // ---- DATE ----
    const now = new Date();
    const uyOffset = -3 * 60 * 60 * 1000;
    const uyNow = new Date(now.getTime() + uyOffset);

    if (/\b(hoy|ahora|ya)\b/.test(text)) {
      result.loadDate = this.formatDate(uyNow);
    } else if (/\bmanana\b/.test(text)) {
      const tomorrow = new Date(uyNow.getTime() + 86400000);
      result.loadDate = this.formatDate(tomorrow);
    } else if (/\bpasado\s*manana\b/.test(text)) {
      const dayAfter = new Date(uyNow.getTime() + 2 * 86400000);
      result.loadDate = this.formatDate(dayAfter);
    } else {
      // "lunes", "martes", etc.
      const dayOfWeek = this.parseDayOfWeek(text);
      if (dayOfWeek !== null) {
        result.loadDate = this.nextDayOfWeek(uyNow, dayOfWeek);
      }
      // YYYY-MM-DD or DD/MM
      const dateMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/) || text.match(/\b(\d{1,2})[/\-](\d{1,2})\b/);
      if (dateMatch) {
        if (dateMatch[0].includes('-') && dateMatch[0].length === 10) {
          result.loadDate = dateMatch[1];
        } else if (dateMatch[2]) {
          const day = parseInt(dateMatch[1], 10);
          const month = parseInt(dateMatch[2], 10);
          const year = uyNow.getFullYear();
          if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
            result.loadDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          }
        }
      }
    }

    // ---- TIME ----
    const timeMatch = numText.match(/\b(\d{1,2})[:\.](\d{2})\s*(?:hs?|hrs?)?\b/);
    if (timeMatch) {
      const h = parseInt(timeMatch[1], 10);
      const m = parseInt(timeMatch[2], 10);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        result.loadTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      }
    } else {
      // "a las 8", "8am", "3pm", "8 hs", "8 de la mañana"
      const hourPatterns = [
        /(?:a\s+las?\s+)(\d{1,2})\b/,
        /\b(\d{1,2})\s*(?:am)\b/,
        /\b(\d{1,2})\s*(?:pm)\b/,
        /\b(\d{1,2})\s*(?:hs?|hrs?|horas?)\b/,
        /\b(\d{1,2})\s+de\s+la\s+(?:manana|tarde|noche)\b/,
      ];
      for (const hp of hourPatterns) {
        const hm = numText.match(hp);
        if (hm) {
          let h = parseInt(hm[1], 10);
          // PM adjustment
          if (hp.source.includes('pm') && h < 12) h += 12;
          if (hp.source.includes('tarde') && h < 12) h += 12;
          if (hp.source.includes('noche') && h < 18) h += 12;
          if (h >= 0 && h <= 23) {
            result.loadTime = `${String(h).padStart(2, '0')}:00`;
            break;
          }
        }
      }
    }

    // ---- TRANSPORT TYPE ----
    if (/\b(flota\s*propia|mi\s*camion|mis?\s*camiones?|con\s+mi\s+camion)\b/.test(text)) {
      result.useOwnFleet = true;
    } else if (/\b(externo|tercero|delegar?\s*(al?\s*planta)?|que\s+(la\s+)?planta\s+asigne)\b/.test(text)) {
      result.useOwnFleet = false;
    }

    // ---- DESTINATION (plant name) ----
    // "a PlantaX", "destino PlantaX", "para PlantaX"
    const destPatterns = [
      /(?:a|hacia|para|destino)\s+(?:la\s+)?(?:planta\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ][\w\s]{2,30}?)(?:\s*[,.]|\s+(?:de|con|desde|el|la|los|las|hoy|manana|\d))/i,
      /(?:a|hacia|para|destino)\s+(?:la\s+)?(?:planta\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ][\w\s]{2,30})$/i,
    ];
    for (const p of destPatterns) {
      const m = rawMessage.match(p);
      if (m) {
        const name = m[1].trim();
        // Skip common non-plant words
        if (!/^(hoy|manana|campo|lote|el|la|un|una)$/i.test(name)) {
          result.destName = name;
          break;
        }
      }
    }

    // ---- ORIGIN (field/lot name) ----
    const originPatterns = [
      /(?:desde|de|origen|campo|lote)\s+(?:el\s+)?([A-ZÁÉÍÓÚÑa-záéíóúñ][\w\s]{2,30}?)(?:\s*[,.]|\s+(?:a|hacia|para|de|con|hoy|manana|\d))/i,
    ];
    for (const p of originPatterns) {
      const m = rawMessage.match(p);
      if (m) {
        const name = m[1].trim();
        if (!/^(hoy|manana|planta|el|la|un|una)$/i.test(name)) {
          result.originName = name;
          break;
        }
      }
    }

    return result;
  }

  /** Get list of missing required fields */
  getMissingFields(data: ParsedFreightData): string[] {
    const missing: string[] = [];
    if (!data.grain) missing.push('grain');
    if (!data.tons) missing.push('tons');
    if (!data.loadDate) missing.push('loadDate');
    if (data.truckCount === undefined) missing.push('truckCount');
    return missing;
  }

  /** Parse a single field answer from a short response */
  parseSingleField(text: string, field: string): any {
    const norm = this.normalize(text);
    const numNorm = this.normalizeNumbers(norm);

    switch (field) {
      case 'grain': {
        for (const [key, value] of Object.entries(GRAIN_MAP)) {
          if (new RegExp(`\\b${key}\\b`).test(norm)) return value;
        }
        // Fuzzy match: typos and voice-to-text
        for (const [key, value] of Object.entries(GRAIN_FUZZY)) {
          if (new RegExp(`\\b${key}\\b`).test(norm)) return value;
        }
        // If user just sent a single word, try it
        const words = norm.split(/\s+/);
        if (words.length === 1) {
          if (GRAIN_MAP[words[0]]) return GRAIN_MAP[words[0]];
          if (GRAIN_FUZZY[words[0]]) return GRAIN_FUZZY[words[0]];
        }
        return null;
      }
      case 'tons': {
        const m = numNorm.match(/(\d+(?:[.,]\d+)?)/);
        if (m) {
          const val = parseFloat(m[1].replace(',', '.'));
          if (val > 0 && val < 10000) return val;
        }
        return null;
      }
      case 'truckCount': {
        const m = numNorm.match(/(\d+)/);
        if (m) {
          const val = parseInt(m[1], 10);
          if (val > 0 && val <= 50) return val;
        }
        return null;
      }
      case 'loadDate': {
        const uyNow = new Date(Date.now() + (-3 * 60 * 60 * 1000));
        if (/\b(hoy|ahora)\b/.test(norm)) return this.formatDate(uyNow);
        if (/\bmanana\b/.test(norm)) return this.formatDate(new Date(uyNow.getTime() + 86400000));
        const dayOfWeek = this.parseDayOfWeek(norm);
        if (dayOfWeek !== null) return this.nextDayOfWeek(uyNow, dayOfWeek);
        const dateMatch = norm.match(/\b(\d{4}-\d{2}-\d{2})\b/) || norm.match(/\b(\d{1,2})[/\-](\d{1,2})\b/);
        if (dateMatch) {
          if (dateMatch[0].length === 10) return dateMatch[1];
          const day = parseInt(dateMatch[1], 10), month = parseInt(dateMatch[2], 10);
          if (day >= 1 && day <= 31 && month >= 1 && month <= 12)
            return `${uyNow.getFullYear()}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }
        return null;
      }
      case 'useOwnFleet': {
        if (/\b(propia|mi\s*camion|si|sí)\b/.test(norm)) return true;
        if (/\b(no|externo|planta|delegar)\b/.test(norm)) return false;
        return null;
      }
      default:
        return text.trim() || null;
    }
  }

  // ======================== HELPERS ========================

  private formatDate(d: Date): string {
    return d.toISOString().split('T')[0];
  }

  private parseDayOfWeek(text: string): number | null {
    const days: Record<string, number> = {
      domingo: 0, lunes: 1, martes: 2, miercoles: 3,
      jueves: 4, viernes: 5, sabado: 6,
    };
    for (const [name, dow] of Object.entries(days)) {
      if (new RegExp(`\\b${name}\\b`).test(text)) return dow;
    }
    return null;
  }

  private nextDayOfWeek(from: Date, targetDow: number): string {
    const current = from.getDay();
    let diff = targetDow - current;
    if (diff <= 0) diff += 7;
    const target = new Date(from.getTime() + diff * 86400000);
    return this.formatDate(target);
  }
}
