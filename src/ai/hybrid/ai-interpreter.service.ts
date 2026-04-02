// =====================================================================
// TOLVINK — AI Interpreter Service (Lightweight LLM Layer)
// Uses cheapest model to interpret ambiguous messages into structured
// intent + data. Feeds INTO the existing deterministic system.
//
// NOT a replacement for deterministic routing — only fills the gap
// between regex-based detection and full LLM chat fallback.
//
// Cost: ~$0.0003 per call (Haiku, 150 tokens out, ~200 tokens in)
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { DetectedIntent, DetectedIntentResult } from './intent-detector.service';
import { ParsedFreightData } from './freight-parser.service';
import { MODEL_ID_FAST, URUGUAY_UTC_OFFSET_MS } from '../ai.constants';

/** Structured output from the interpreter LLM call */
export interface InterpreterResult {
  intent: string;
  confidence: number;
  data: {
    grain: string | null;
    tons: number | null;
    date: string | null;
    time: string | null;
    truckCount: number | null;
    originName: string | null;
    destName: string | null;
    freightCode: string | null;
    status: string | null;
  };
}

// Valid intents the LLM is allowed to return — anything else maps to 'unknown'
const VALID_INTENTS = new Set<string>([
  'create_freight', 'get_dashboard', 'list_freights', 'get_freight_detail',
  'confirm', 'cancel', 'greeting', 'help', 'list_trucks', 'list_drivers',
  'fleet_summary', 'assign_transport', 'switch_company', 'profile', 'unknown',
]);

// Messages that should NEVER be sent to the interpreter (handled deterministically)
const SKIP_PATTERNS = [
  /^(si|sí|dale|ok|okey|confirmar?|confirmo|listo|va|no|cancela|nada)\s*[.!]?\s*$/i,
  /^\d{1,3}([.,]\d+)?\s*$/,                // bare numbers (flow input)
  /^(hola|buenas?|hey|buen\s*dia)\b/i,     // greetings
  /\bF\d{2}-[A-Z]{2,4}[.\-]\d{2,5}\b/i,   // freight codes
];

@Injectable()
export class AiInterpreterService {
  private readonly logger = new Logger(AiInterpreterService.name);
  private client: Anthropic | null = null;
  private readonly todayUY: string;

  constructor(private config: ConfigService) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
    // Pre-compute today's date for the prompt
    const now = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS);
    this.todayUY = now.toISOString().split('T')[0];
  }

  /** Check if the message should skip the interpreter entirely */
  shouldSkip(message: string, hasActiveFlow: boolean, hasPending: boolean): boolean {
    if (!this.client) return true;
    const trimmed = message.trim();
    if (trimmed.length <= 3) return true;
    if (hasActiveFlow) return true;
    if (hasPending) return true;
    for (const p of SKIP_PATTERNS) {
      if (p.test(trimmed)) return true;
    }
    return false;
  }

  /**
   * Call the LLM interpreter to extract intent + structured data.
   * Returns null on any failure — caller falls back to regex detection.
   */
  async interpret(message: string): Promise<InterpreterResult | null> {
    if (!this.client) return null;

    const today = this.refreshToday();

    try {
      const response = await Promise.race([
        this.client.messages.create({
          model: MODEL_ID_FAST,
          max_tokens: 150,
          temperature: 0,
          system: this.buildSystemPrompt(today),
          messages: [{ role: 'user', content: message }],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('interpreter timeout')), 5000),
        ),
      ]);

      const text = (response as any).content
        ?.filter((b: any) => b.type === 'text')
        ?.map((b: any) => b.text)
        ?.join('') || '';

      return this.parseResponse(text);
    } catch (err: any) {
      this.logger.warn(`[interpreter] Failed: ${err.message}`);
      return null; // Silent fallback — deterministic system takes over
    }
  }

  /** Convert interpreter result into the existing DetectedIntentResult format */
  toDetectedIntent(result: InterpreterResult): DetectedIntentResult {
    const intent = (VALID_INTENTS.has(result.intent) ? result.intent : 'unknown') as DetectedIntent;

    const entities: Record<string, any> = {};

    // Map interpreter data into entities the router understands
    if (result.data.freightCode) entities.code = result.data.freightCode;
    if (result.data.status) entities.status = result.data.status;
    if (result.data.grain) entities.grain = result.data.grain.toLowerCase();

    return { intent, confidence: result.confidence, entities };
  }

  /** Extract ParsedFreightData from interpreter result (to merge with parser) */
  toFreightData(result: InterpreterResult): ParsedFreightData {
    const d = result.data;
    const parsed: ParsedFreightData = {};

    if (d.grain) parsed.grain = this.normalizeGrain(d.grain);
    if (d.tons && d.tons > 0) parsed.tons = d.tons;
    if (d.date) parsed.loadDate = d.date;
    if (d.time) parsed.loadTime = d.time;
    if (d.truckCount && d.truckCount > 0) parsed.truckCount = d.truckCount;
    if (d.originName) parsed.originName = d.originName;
    if (d.destName) parsed.destName = d.destName;

    return parsed;
  }

  // ======================== INTERNALS ========================

  private buildSystemPrompt(today: string): string {
    return `You are a structured data extractor for an agricultural freight logistics app in Uruguay.
Extract intent and data from Spanish user messages. Output ONLY valid JSON, no markdown, no explanation.

Today: ${today}

JSON schema:
{"intent":"create_freight|get_dashboard|list_freights|get_freight_detail|confirm|cancel|greeting|help|list_trucks|list_drivers|fleet_summary|assign_transport|switch_company|profile|unknown","confidence":0.0-1.0,"data":{"grain":null,"tons":null,"date":null,"time":null,"truckCount":null,"originName":null,"destName":null,"freightCode":null,"status":null}}

Rules:
- grain: Soja|Maíz|Trigo|Girasol|Sorgo|Cebada|Otros (capitalize)
- date: YYYY-MM-DD. "mañana"→${this.tomorrow(today)}, "hoy"→${today}
- time: HH:mm (24h)
- tons: number (quintales÷10)
- status: pending_assignment|assigned|accepted|in_progress|loaded|finished|canceled
- freightCode: preserve exact code like F26-XXX.1234
- Be tolerant to typos: "sojaa"→Soja, "maiss"→Maíz
- null for unknown fields, never invent data`;
  }

  private tomorrow(today: string): string {
    const d = new Date(today + 'T12:00:00Z');
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  private refreshToday(): string {
    const now = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS);
    return now.toISOString().split('T')[0];
  }

  private parseResponse(text: string): InterpreterResult | null {
    // Strip markdown code fences if present
    let clean = text.trim();
    if (clean.startsWith('```')) {
      clean = clean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    try {
      const parsed = JSON.parse(clean);

      // Validate minimum structure
      if (!parsed.intent || typeof parsed.confidence !== 'number') return null;
      if (parsed.confidence < 0 || parsed.confidence > 1) return null;

      return {
        intent: String(parsed.intent),
        confidence: parsed.confidence,
        data: {
          grain: parsed.data?.grain || null,
          tons: parsed.data?.tons != null ? Number(parsed.data.tons) : null,
          date: parsed.data?.date || null,
          time: parsed.data?.time || null,
          truckCount: parsed.data?.truckCount != null ? Number(parsed.data.truckCount) : null,
          originName: parsed.data?.originName || null,
          destName: parsed.data?.destName || null,
          freightCode: parsed.data?.freightCode || null,
          status: parsed.data?.status || null,
        },
      };
    } catch {
      this.logger.warn(`[interpreter] JSON parse failed: ${clean.slice(0, 100)}`);
      return null;
    }
  }

  private normalizeGrain(raw: string): string {
    const map: Record<string, string> = {
      soja: 'Soja', soya: 'Soja',
      maiz: 'Maíz', maís: 'Maíz', 'maíz': 'Maíz',
      trigo: 'Trigo', girasol: 'Girasol',
      sorgo: 'Sorgo', cebada: 'Cebada',
    };
    const lower = raw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return map[lower] || raw; // Return as-is if already capitalized correctly
  }
}
