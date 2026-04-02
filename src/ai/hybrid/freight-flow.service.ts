// =====================================================================
// TOLVINK — Freight Flow Service (Deterministic)
// Handles the create_freight multi-step flow WITHOUT LLM
// Collects data, validates, then delegates to existing toolPrepareFreight
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { FreightParserService, ParsedFreightData } from './freight-parser.service';
import { FlowService, FlowState } from './flow.service';

const FIELD_LABELS: Record<string, string> = {
  grain: '🌾 Grano',
  tons: '⚖️ Toneladas',
  loadDate: '📅 Fecha de carga',
  truckCount: '🚛 Cantidad de camiones',
  useOwnFleet: '🔧 Tipo de transporte',
  destName: '🏭 Planta destino',
  originName: '📍 Campo/lote origen',
};

const FIELD_QUESTIONS: Record<string, string> = {
  grain: '🌾 ¿Qué grano vas a cargar?\n\n• Soja\n• Maíz\n• Trigo\n• Girasol\n• Sorgo\n• Cebada\n• Otros',
  tons: '⚖️ ¿Cuántas toneladas?',
  loadDate: '📅 ¿Cuándo se carga? (hoy, mañana, o fecha DD/MM)',
  truckCount: '🚛 ¿Cuántos camiones necesitás?',
  useOwnFleet: '🔧 ¿Cómo se transporta?\n\n• *Flota propia* — tu camión\n• *Delegado a planta* — la planta asigna transporte',
  destName: '🏭 ¿A qué planta va destinado?',
  originName: '📍 ¿Desde qué campo/lote sale?',
};

@Injectable()
export class FreightFlowService {
  private readonly logger = new Logger(FreightFlowService.name);

  constructor(
    private parser: FreightParserService,
    private flowService: FlowService,
  ) {}

  /**
   * Start or continue the freight creation flow.
   * Returns { response, done, prepareInput } where:
   * - response: message to send to the user
   * - done: true ONLY after user explicitly confirms
   * - prepareInput: the collected data to pass to toolPrepareFreight (only when done=true)
   *
   * SAFETY: done=true is NEVER returned without an explicit confirmation step.
   * Flow is: collect → show summary → await confirm → done=true
   */
  processMessage(
    message: string,
    existingFlow: FlowState | null,
  ): { response: string | null; flow: FlowState; done: boolean; prepareInput?: Record<string, any> } {

    // ── CASE 1: Starting a new flow ──
    if (!existingFlow || existingFlow.flowType !== 'create_freight') {
      const parsed = this.parser.parse(message);

      // Auto truck count: if tons present but no truckCount, calculate it
      if (parsed.tons && parsed.truckCount === undefined) {
        parsed.truckCount = Math.ceil(parsed.tons / 30);
      }

      const missing = this.parser.getMissingFields(parsed);
      const flow = this.flowService.createFlow('create_freight', { ...parsed }, missing);

      if (missing.length === 0) {
        // All required fields present — show summary and AWAIT CONFIRMATION (never skip)
        const summary = this.buildCollectedSummary(parsed);
        this.flowService.setAwaitingConfirmation(flow, summary);
        return {
          response: `📋 *Nuevo flete — Confirmar datos*\n\n${summary}\n\n¿Confirmás la creación?`,
          flow,
          done: false, // NEVER done=true without explicit confirmation
        };
      }

      // Ask for first missing field
      const nextField = missing[0];
      this.flowService.setAwaitingField(flow, nextField);

      const gotParts = this.buildCollectedSummary(parsed);
      const question = FIELD_QUESTIONS[nextField] || `¿Cuál es el valor de ${nextField}?`;

      let response = '';
      if (gotParts) {
        response = `📋 *Nuevo flete*\n${gotParts}\n\n${question}`;
      } else {
        response = `📋 *Nuevo flete*\n\n${question}`;
      }

      return { response, flow, done: false };
    }

    // ── CASE 2: Continuing an existing flow ──
    const flow = existingFlow;

    // Normalize once for all checks
    const normMsg = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

    // Check if user wants to cancel — handles button text "No, cancelar." and free-form
    if (/^(no[,.]?\s*(cancelar?)?|cancela[r]?|anula[r]?|dejalo?|parar?|nada)\s*[.!]?\s*$/.test(normMsg)) {
      return { response: '❌ Creación de flete cancelada.', flow, done: false, prepareInput: undefined };
    }

    // Detect strong intent change — user wants to break out of flow
    // e.g. "mis fletes", "dashboard", "hola", "ayuda", freight code
    if (/^(hola|buenas?|mis\s+fletes|dashboard|tablero|ayuda|help)\b/.test(normMsg) ||
        /\bF\d{2}-[A-Z]/i.test(message.trim())) {
      // Signal to caller: clear flow and re-route via intent detection
      return { response: null, flow: { ...flow, flowType: null } as any, done: false };
    }

    // If awaiting confirmation — ONLY path to done=true
    if (flow.awaitingConfirmation) {
      // Strip repeated words: "dale dale" → "dale", "si si" → "si"
      const deduped = normMsg.replace(/\b(\w+)(\s+\1)+\b/g, '$1');
      if (/^(si|sí|dale|ok|okey|oka|confirmar?|confirmo|listo|va|vamos|manda(le)?|correcto|exacto|eso|claro|afirmativo|procede)\s*[.!]?\s*$/.test(deduped)) {
        return {
          response: null,
          flow,
          done: true,
          prepareInput: this.buildPrepareInput(flow.collected),
        };
      } else {
        return {
          response: '¿Confirmás la creación del flete? Respondé *sí* o *no*.',
          flow,
          done: false,
        };
      }
    }

    // Parse the answer for the awaiting field
    if (flow.awaitingField) {
      const value = this.parser.parseSingleField(message, flow.awaitingField);
      if (value !== null && value !== undefined) {
        this.flowService.updateCollected(flow, flow.awaitingField, value);
      } else {
        // Try full parse — user might have given multiple fields at once
        const parsed = this.parser.parse(message);
        let anyNew = false;
        for (const [key, val] of Object.entries(parsed)) {
          if (val !== undefined && val !== null && flow.missing.includes(key)) {
            this.flowService.updateCollected(flow, key, val);
            anyNew = true;
          }
        }
        if (!anyNew) {
          const question = FIELD_QUESTIONS[flow.awaitingField] || `¿Cuál es el valor de ${flow.awaitingField}?`;
          return { response: `No entendí. ${question}`, flow, done: false };
        }
      }
    }

    // Auto truck count after collecting tons
    if (flow.collected.tons && flow.collected.truckCount === undefined && flow.missing.includes('truckCount')) {
      const autoCount = Math.ceil(Number(flow.collected.tons) / 30);
      this.flowService.updateCollected(flow, 'truckCount', autoCount);
    }

    // Check if all required fields are collected
    const stillMissing = this.parser.getMissingFields(flow.collected as ParsedFreightData);
    flow.missing = stillMissing;

    if (stillMissing.length === 0) {
      // All fields collected — show summary and AWAIT CONFIRMATION (never skip)
      const summary = this.buildCollectedSummary(flow.collected as ParsedFreightData);
      this.flowService.setAwaitingConfirmation(flow, summary);
      return {
        response: `📋 *Nuevo flete — Confirmar datos*\n\n${summary}\n\n¿Confirmás la creación?`,
        flow,
        done: false, // NEVER done=true without explicit confirmation
      };
    }

    // Ask for next missing field
    const nextField = stillMissing[0];
    this.flowService.setAwaitingField(flow, nextField);
    const question = FIELD_QUESTIONS[nextField] || `¿Cuál es el valor de ${nextField}?`;
    const gotParts = this.buildCollectedSummary(flow.collected as ParsedFreightData);

    return {
      response: gotParts ? `${gotParts}\n\n${question}` : question,
      flow,
      done: false,
    };
  }

  /** Build human-readable summary of collected data */
  private buildCollectedSummary(data: ParsedFreightData): string {
    const parts: string[] = [];
    if (data.grain) parts.push(`${FIELD_LABELS.grain}: ${data.grain}`);
    if (data.tons) parts.push(`${FIELD_LABELS.tons}: ${data.tons}`);
    if (data.loadDate) parts.push(`${FIELD_LABELS.loadDate}: ${data.loadDate.split('-').reverse().join('/')}`);
    if (data.loadTime) parts.push(`⏰ Hora: ${data.loadTime}`);
    if (data.truckCount !== undefined) parts.push(`${FIELD_LABELS.truckCount}: ${data.truckCount}`);
    if (data.useOwnFleet !== undefined) parts.push(`${FIELD_LABELS.useOwnFleet}: ${data.useOwnFleet ? 'Flota propia' : 'Delegado a planta'}`);
    if (data.destName) parts.push(`${FIELD_LABELS.destName}: ${data.destName}`);
    if (data.originName) parts.push(`${FIELD_LABELS.originName}: ${data.originName}`);
    return parts.length > 0 ? parts.join('\n') : '';
  }

  private buildSummary(data: ParsedFreightData): string {
    return this.buildCollectedSummary(data);
  }

  /** Convert flow collected data into toolPrepareFreight input format */
  private buildPrepareInput(collected: Record<string, any>): Record<string, any> {
    const input: Record<string, any> = {};
    if (collected.grain) input.grain = collected.grain;
    if (collected.tons) input.tons = Number(collected.tons);
    if (collected.loadDate) input.loadDate = collected.loadDate;
    if (collected.loadTime) input.loadTime = collected.loadTime;
    if (collected.truckCount !== undefined) input.truckCount = Number(collected.truckCount);
    if (collected.useOwnFleet !== undefined) input.useOwnFleet = collected.useOwnFleet;
    if (collected.destName) input.destName = collected.destName;
    if (collected.originName) input.originName = collected.originName;
    if (collected.notes) input.notes = collected.notes;
    return input;
  }
}
