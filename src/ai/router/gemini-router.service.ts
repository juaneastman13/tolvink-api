import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { AiRouteDecision, AgentExecutionContext } from '../contracts/agent.types';

const ROUTER_MODEL = 'gemini-3.1-flash-lite-preview';

@Injectable()
export class GeminiRouterService {
  private readonly logger = new Logger(GeminiRouterService.name);
  private readonly client: GoogleGenAI | null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.client = apiKey ? new GoogleGenAI({ apiKey }) : null;
  }

  async decide(message: string, context: AgentExecutionContext): Promise<AiRouteDecision> {
    const trimmed = (message || '').trim();
    if (!trimmed) {
      return {
        mode: 'direct_response',
        intent: 'general_help',
        risk: 'low',
        toolTags: [],
        toolDomains: [],
        reason: 'empty_message',
        shouldEscalate: false,
        needsClarification: false,
        confidence: 1,
        entityHints: {},
        directReply: 'Decime que necesitas y te ayudo con fletes, estados o acciones.',
      };
    }

    const heuristic = this.heuristicDecision(trimmed, context);
    if (!this.client) {
      return heuristic;
    }

    try {
      const prompt = [
        'Clasifica el mensaje para un agente logistico de Tolvink.',
        'Responde SOLO JSON valido.',
        'Schema:',
        '{"mode":"direct_response|openai_tools","intent":"greeting|general_help|freight_query|freight_create|freight_update|confirm_pending_action|cancel_pending_action|unknown","risk":"low|medium|high","toolTags":["query"],"toolDomains":["freights"],"reason":"...","shouldEscalate":true,"needsClarification":false,"clarificationQuestion":null,"confidence":0.9,"entityHints":{"freightRef":"..."},"directReply":"... u omitido"}',
        'Usa direct_response para saludos, ayuda general, confirmaciones o cancelaciones de accion pendiente, y aclaraciones cortas.',
        'Usa openai_tools cuando haga falta consultar datos actuales o ejecutar una accion.',
        'toolTags permitidos: query, create, update, lifecycle.',
        'toolDomains permitidos: freights, logistics, admin, documents.',
        `Canal: ${context.channel}`,
        `Empresa seleccionada en sesion: ${JSON.stringify(((context.session?.flowState as any) || {}).selectedCompanyId || null)}`,
        `Ultimo flete en sesion: ${JSON.stringify(((context.session?.flowState as any) || {})._lastFreightCode || null)}`,
        `Hay accion pendiente: ${JSON.stringify(!!((context.session?.flowState as any) || {}).pendingAction)}`,
        `Mensaje: ${trimmed}`,
      ].join('\n');

      const response = await this.client.models.generateContent({
        model: ROUTER_MODEL,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseMimeType: 'application/json',
          maxOutputTokens: 300,
          temperature: 0.1,
        },
      });

      const raw = response?.text?.trim();
      if (!raw) return heuristic;

      const parsed = JSON.parse(raw);
      const mode = parsed?.mode === 'openai_tools' ? 'openai_tools' : 'direct_response';
      const intent = this.isValidIntent(parsed?.intent) ? parsed.intent : heuristic.intent;
      const risk = this.isValidRisk(parsed?.risk) ? parsed.risk : heuristic.risk;
      const toolTags = Array.isArray(parsed?.toolTags)
        ? parsed.toolTags.filter((tag: any) => typeof tag === 'string').slice(0, 4)
        : heuristic.toolTags;
      const toolDomains = Array.isArray(parsed?.toolDomains)
        ? parsed.toolDomains.filter((tag: any) => typeof tag === 'string').slice(0, 4)
        : heuristic.toolDomains;
      const directReply = typeof parsed?.directReply === 'string' ? parsed.directReply.trim() : undefined;
      const entityHints = parsed?.entityHints && typeof parsed.entityHints === 'object'
        ? this.normalizeEntityHints(parsed.entityHints)
        : heuristic.entityHints;
      const shouldEscalate = typeof parsed?.shouldEscalate === 'boolean' ? parsed.shouldEscalate : heuristic.shouldEscalate;
      const needsClarification = typeof parsed?.needsClarification === 'boolean' ? parsed.needsClarification : heuristic.needsClarification;
      const clarificationQuestion = typeof parsed?.clarificationQuestion === 'string' && parsed.clarificationQuestion.trim()
        ? parsed.clarificationQuestion.trim()
        : heuristic.clarificationQuestion;
      const confidence = typeof parsed?.confidence === 'number' ? Math.max(0, Math.min(parsed.confidence, 1)) : heuristic.confidence;

      return {
        mode,
        intent,
        risk,
        toolTags: toolTags.length > 0 ? toolTags : heuristic.toolTags,
        toolDomains: toolDomains.length > 0 ? toolDomains : heuristic.toolDomains,
        reason: typeof parsed?.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : 'gemini_router',
        shouldEscalate,
        needsClarification,
        clarificationQuestion,
        confidence,
        entityHints,
        directReply: mode === 'direct_response' ? (directReply || heuristic.directReply) : undefined,
      };
    } catch (error: any) {
      this.logger.warn(`Gemini router fallback: ${error?.message || 'unknown error'}`);
      return heuristic;
    }
  }

  private heuristicDecision(message: string, context: AgentExecutionContext): AiRouteDecision {
    const text = message.toLowerCase();
    const entityHints = this.extractEntityHints(message);
    const hasPendingAction = !!((context.session?.flowState as any) || {}).pendingAction;
    const hasFreightContext = !!entityHints.freightRef || !!((context.session?.flowState as any) || {})._lastFreightId;

    if (hasPendingAction && /^(si|sí|dale|confirmo|confirmar|ok|de acuerdo|hacelo|hace eso)[!. ]*$/i.test(text)) {
      return {
        mode: 'direct_response',
        intent: 'confirm_pending_action',
        risk: 'medium',
        toolTags: [],
        toolDomains: [],
        reason: 'heuristic_confirm_pending',
        shouldEscalate: false,
        needsClarification: false,
        confidence: 0.98,
        entityHints,
      };
    }

    if (hasPendingAction && /^(no|cancelar|cancelá|cancelalo|dejalo|anular)[!. ]*$/i.test(text)) {
      return {
        mode: 'direct_response',
        intent: 'cancel_pending_action',
        risk: 'medium',
        toolTags: [],
        toolDomains: [],
        reason: 'heuristic_cancel_pending',
        shouldEscalate: false,
        needsClarification: false,
        confidence: 0.98,
        entityHints,
      };
    }

    if (/^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|menu|inicio|gracias|ok)[!. ]*$/i.test(text)) {
      return {
        mode: 'direct_response',
        intent: 'greeting',
        risk: 'low',
        toolTags: [],
        toolDomains: [],
        reason: 'heuristic_greeting',
        shouldEscalate: false,
        needsClarification: false,
        confidence: 0.95,
        entityHints,
        directReply: 'Estoy listo para ayudarte con fletes, estados, asignaciones y creacion de viajes.',
      };
    }

    if (/(crear|crea|nuevo flete|mand[aá]|enviar una carga|cargar un flete)/i.test(text)) {
      return {
        mode: 'openai_tools',
        intent: 'freight_create',
        risk: 'high',
        toolTags: ['create', 'query'],
        toolDomains: ['freights', 'logistics'],
        reason: 'heuristic_create',
        shouldEscalate: true,
        needsClarification: false,
        confidence: 0.9,
        entityHints,
      };
    }

    if (/(cancel|rechaz|inicia|arranque|ya carg|confirm|entreg|finaliz|termin)/i.test(text)) {
      return {
        mode: 'openai_tools',
        intent: 'freight_update',
        risk: 'high',
        toolTags: ['lifecycle', 'update', 'query'],
        toolDomains: ['freights', 'logistics'],
        reason: 'heuristic_lifecycle',
        shouldEscalate: true,
        needsClarification: !hasFreightContext,
        clarificationQuestion: !hasFreightContext ? '¿Sobre qué flete querés hacer esa acción?' : undefined,
        confidence: 0.9,
        entityHints,
      };
    }

    if (/(mis fletes|flete|estado|detalle|dashboard|estadistica|estadisticas|viaje|viajes|cola|camion|chofer)/i.test(text)) {
      return {
        mode: 'openai_tools',
        intent: 'freight_query',
        risk: 'medium',
        toolTags: ['query'],
        toolDomains: ['freights', 'logistics'],
        reason: 'heuristic_query',
        shouldEscalate: false,
        needsClarification: false,
        confidence: 0.88,
        entityHints,
      };
    }

    return {
      mode: 'direct_response',
      intent: 'general_help',
      risk: 'low',
      toolTags: [],
      toolDomains: [],
      reason: 'heuristic_default',
      shouldEscalate: false,
      needsClarification: false,
      confidence: 0.6,
      entityHints,
      directReply: 'Puedo ayudarte a consultar fletes, ver detalles, obtener estadisticas y crear nuevos fletes.',
    };
  }

  private isValidIntent(intent: any): intent is AiRouteDecision['intent'] {
    return [
      'greeting',
      'general_help',
      'freight_query',
      'freight_create',
      'freight_update',
      'confirm_pending_action',
      'cancel_pending_action',
      'unknown',
    ].includes(intent);
  }

  private isValidRisk(risk: any): risk is AiRouteDecision['risk'] {
    return ['low', 'medium', 'high'].includes(risk);
  }

  private extractEntityHints(message: string): AiRouteDecision['entityHints'] {
    const trimmed = (message || '').trim();
    const contextual = /\b(ese|esa|este|esta|ultimo|último|de hoy)\b/i.exec(trimmed)?.[0];
    const codeMatch = trimmed.match(/\b([A-Z0-9.-]{4,})\b/i);
    const plantRef = this.extractAfterKeyword(trimmed, ['planta', 'a']);
    const fieldRef = this.extractAfterKeyword(trimmed, ['campo', 'desde']);
    const lotRef = this.extractAfterKeyword(trimmed, ['lote']);
    const truckRef = this.extractAfterKeyword(trimmed, ['camion', 'camión', 'matricula', 'matrícula']);
    const driverRef = this.extractAfterKeyword(trimmed, ['chofer', 'conductor']);
    return {
      freightRef: contextual || codeMatch?.[1],
      plantRef,
      fieldRef,
      lotRef,
      truckRef,
      driverRef,
    };
  }

  private normalizeEntityHints(input: any): AiRouteDecision['entityHints'] {
    const normalize = (value: any) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
    return {
      freightRef: normalize(input.freightRef),
      plantRef: normalize(input.plantRef),
      fieldRef: normalize(input.fieldRef),
      lotRef: normalize(input.lotRef),
      truckRef: normalize(input.truckRef),
      driverRef: normalize(input.driverRef),
    };
  }

  private extractAfterKeyword(message: string, keywords: string[]): string | undefined {
    for (const keyword of keywords) {
      const regex = new RegExp(`\\b${keyword}\\s+([\\p{L}0-9 .-]{2,40})`, 'iu');
      const match = regex.exec(message);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return undefined;
  }
}
