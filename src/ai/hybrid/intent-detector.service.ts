// =====================================================================
// TOLVINK — Intent Detector Service (Deterministic)
// Detects user intent from WhatsApp messages using regex + keywords
// NO LLM — pure pattern matching
// =====================================================================

import { Injectable } from '@nestjs/common';

export type DetectedIntent =
  | 'get_dashboard'
  | 'get_freight_detail'
  | 'list_freights'
  | 'create_freight'
  | 'assign_transport'
  | 'confirm'
  | 'cancel'
  | 'greeting'
  | 'help'
  | 'list_trucks'
  | 'list_drivers'
  | 'fleet_summary'
  | 'switch_company'
  | 'profile'
  | 'unknown';

export interface DetectedIntentResult {
  intent: DetectedIntent;
  confidence: number;        // 0-1
  entities: Record<string, any>;
}

@Injectable()
export class IntentDetectorService {

  /** Normalize text: lowercase, remove accents, trim */
  private normalize(text: string): string {
    return text
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w\s.,!?@#$%&*()\-+=/]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Main detection entry point */
  detect(rawMessage: string, hasActiveFlow: boolean, hasPendingAction: boolean): DetectedIntentResult {
    const text = this.normalize(rawMessage);
    const original = rawMessage.trim();

    // 1. Confirmation — highest priority if there's a pending action
    if (hasPendingAction) {
      const confirmResult = this.detectConfirmation(text);
      if (confirmResult) return confirmResult;
      const cancelResult = this.detectCancellation(text);
      if (cancelResult) return cancelResult;
    }

    // 2. Freight code — direct lookup
    const freightCode = this.extractFreightCode(original);
    if (freightCode) {
      return { intent: 'get_freight_detail', confidence: 1.0, entities: { code: freightCode } };
    }

    // 3. Greeting
    if (this.isGreeting(text)) {
      return { intent: 'greeting', confidence: 0.95, entities: {} };
    }

    // 4. Dashboard
    if (this.isDashboard(text)) {
      return { intent: 'get_dashboard', confidence: 0.9, entities: {} };
    }

    // 5. List freights
    const listResult = this.detectListFreights(text);
    if (listResult) return listResult;

    // 6. Create freight
    const createResult = this.detectCreateFreight(text);
    if (createResult) return createResult;

    // 7. Assign transport
    if (this.isAssignTransport(text)) {
      return { intent: 'assign_transport', confidence: 0.8, entities: {} };
    }

    // 8. List trucks
    if (/\b(mis\s+camiones|camiones|flota|lista.*camion)\b/.test(text)) {
      return { intent: 'list_trucks', confidence: 0.85, entities: {} };
    }

    // 9. List drivers
    if (/\b(mis\s+choferes|choferes|conductores)\b/.test(text)) {
      return { intent: 'list_drivers', confidence: 0.85, entities: {} };
    }

    // 10. Fleet summary
    if (/\b(resumen\s*(de\s*)?(flota|camiones)|economia|gastos|ingresos)\b/.test(text)) {
      return { intent: 'fleet_summary', confidence: 0.8, entities: {} };
    }

    // 11. Switch company
    if (/\b(cambiar\s*(de\s*)?empresa|otra\s*empresa|switch)\b/.test(text)) {
      return { intent: 'switch_company', confidence: 0.85, entities: {} };
    }

    // 12. Profile
    if (/\b(mi\s*perfil|mis\s*datos|mi\s*cuenta)\b/.test(text)) {
      return { intent: 'profile', confidence: 0.85, entities: {} };
    }

    // 13. Help
    if (/\b(ayuda|help|como\s+funciona|que\s+pued[eo]s?)\b/.test(text)) {
      return { intent: 'help', confidence: 0.85, entities: {} };
    }

    // 14. Heuristic: number + grain anywhere → create_freight
    if (/\d+.*\b(soja|maiz|trigo|girasol|sorgo|cebada)\b/.test(text) ||
        /\b(soja|maiz|trigo|girasol|sorgo|cebada)\b.*\d+/.test(text)) {
      return { intent: 'create_freight', confidence: 0.85, entities: {} };
    }

    // 15. Standalone confirm/cancel (without pending action)
    const confirmResult = this.detectConfirmation(text);
    if (confirmResult && confirmResult.confidence > 0.9) return confirmResult;
    const cancelResult = this.detectCancellation(text);
    if (cancelResult && cancelResult.confidence > 0.9) return cancelResult;

    return { intent: 'unknown', confidence: 0, entities: {} };
  }

  // ======================== FREIGHT CODE ========================

  private extractFreightCode(text: string): string | null {
    // FLT-XXXX or F26-ABC.1234 patterns
    const patterns = [
      /\b(FLT-\w+)\b/i,
      /\b(F\d{2}-[A-Z]{3}\.\d{4})\b/i,
      /\b(F\d{2}-[A-Z]{2,4}[.\-]\d{2,5})\b/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  // ======================== GREETING ========================

  private isGreeting(text: string): boolean {
    const greetingPatterns = [
      /^(hola|buenas?|hey|buen\s*(dia|tarde|noche)|que\s+tal|saludos)\b/,
      /^(ey|epa|wena|wenas|opa)\b/,
      /^(buenos\s+dias?|buenas\s+tardes?|buenas\s+noches?)\b/,
    ];
    return greetingPatterns.some(p => p.test(text));
  }

  // ======================== DASHBOARD ========================

  private isDashboard(text: string): boolean {
    return /\b(dashboard|tablero|resumen|panel|inicio|estado\s+general|como\s+est[ao]y?|como\s+va(n?\s+los)?\s+fletes?)\b/.test(text);
  }

  // ======================== LIST FREIGHTS ========================

  private detectListFreights(text: string): DetectedIntentResult | null {
    const patterns = [
      /\b(mis\s+fletes|ver\s+fletes|listar\s+fletes|fletes?\s+(de\s+hoy|pendientes?|activos?|en\s+curso))\b/,
      /\b(que\s+fletes?\s+tengo|cuantos\s+fletes?|mostrar?\s+fletes?)\b/,
      /\b(fletes?\s+del?\s+dia|fletes?\s+hoy)\b/,
    ];
    if (patterns.some(p => p.test(text))) {
      const entities: Record<string, any> = {};

      // Extract status filter
      if (/\bpendient/i.test(text)) entities.status = 'pending_assignment';
      else if (/\basignad/i.test(text)) entities.status = 'assigned';
      else if (/\ben\s*(curso|camino|viaje)/i.test(text)) entities.status = 'in_progress';
      else if (/\bcargad/i.test(text)) entities.status = 'loaded';
      else if (/\bfinalizad/i.test(text)) entities.status = 'finished';
      else if (/\bactiv/i.test(text)) entities.status = 'active'; // in_progress or loaded

      // Extract grain filter
      const grainMatch = text.match(/\b(soja|maiz|trigo|girasol|cebada|arroz|sorgo|avena|lino|colza|centeno)\b/);
      if (grainMatch) entities.grain = grainMatch[1];

      return { intent: 'list_freights', confidence: 0.9, entities };
    }
    return null;
  }

  // ======================== CREATE FREIGHT ========================

  private detectCreateFreight(text: string): DetectedIntentResult | null {
    const patterns = [
      /\b(crear?\s+flete|nuevo\s+flete|mandar?|enviar?|despachar?|necesito\s+(mandar|enviar|despachar))\b/,
      /\b(quiero\s+(crear|mandar|enviar|despachar)\s+(un\s+)?flete)\b/,
      /\b(preparar?\s+flete|armar?\s+flete|hacer?\s+flete)\b/,
      /\b(mandar?\s+\d+\s*(ton|tn|t\b|quintale?s?|qq))\b/,
      /\b(enviar?\s+\d+\s*(ton|tn|t\b|quintale?s?|qq))\b/,
      /\b(\d+\s*(ton|tn|t\b)\s+de\s+\w+)/,
    ];
    if (patterns.some(p => p.test(text))) {
      return { intent: 'create_freight', confidence: 0.85, entities: {} };
    }
    return null;
  }

  // ======================== ASSIGN TRANSPORT ========================

  private isAssignTransport(text: string): boolean {
    return /\b(asignar?\s*(transporte|transportista|camion)|delegar?\s*al?\s*planta)\b/.test(text);
  }

  // ======================== CONFIRMATION ========================

  private detectConfirmation(text: string): DetectedIntentResult | null {
    const strong = /^(si|sí|dale|ok|okey|oka|confirmo?|listo|va|vamos|correcto|exacto|eso|claro|afirmativo|manda(le)?|envialo?|procede|confirmar?)\s*[.!]?\s*$/;
    const medium = /\b(si[,.]?\s*(dale|confirmo?|va|eso)|dale\s+que\s+si|confirmar?)\b/;

    if (strong.test(text)) return { intent: 'confirm', confidence: 1.0, entities: {} };
    if (medium.test(text)) return { intent: 'confirm', confidence: 0.85, entities: {} };
    return null;
  }

  // ======================== CANCELLATION ========================

  private detectCancellation(text: string): DetectedIntentResult | null {
    const strong = /^(no|cancela[r]?|anula[r]?|olvidalo?|dejalo?|nada|para|parar?)\s*[.!]?\s*$/;
    const medium = /\b(no[,.]?\s*(cancela|dejalo|parar?)|cancela[r]?\s+eso|anular?)\b/;

    if (strong.test(text)) return { intent: 'cancel', confidence: 1.0, entities: {} };
    if (medium.test(text)) return { intent: 'cancel', confidence: 0.85, entities: {} };
    return null;
  }
}
