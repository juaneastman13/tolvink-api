import { GeminiClient } from '../../ai/core/gemini.client';
import { INTENT_CLASSIFIER_PROMPT } from '../prompts/intent-classifier.prompt';
import { AgentState } from '../schemas/agent-state.schema';
import { AgentIntent, IntentSchema } from '../schemas/intent.schema';
import { Logger } from '@nestjs/common';

const logger = new Logger('DetectIntent');

export function makeDetectIntentNode(gemini?: GeminiClient) {
  return async function detectIntentNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow === 'create_freight' && state.currentStep) {
      return { currentIntent: 'create_freight' };
    }
    if (state.currentFlow === 'share_map' && state.currentStep === 'awaiting_freight_code') {
      return { currentIntent: 'share_map' };
    }

    const heuristic = detectIntentHeuristic(state.lastUserMessage);
    if (heuristic !== 'unknown') return { currentIntent: heuristic };

    if (gemini) {
      const llmIntent = await classifyWithGemini(gemini, state.lastUserMessage);
      if (llmIntent && llmIntent !== 'unknown') return { currentIntent: llmIntent };
    }

    return { currentIntent: 'unknown' };
  };
}

// Backwards-compatible default export (no Gemini fallback).
export const detectIntentNode = makeDetectIntentNode();

export function detectIntentHeuristic(message: string): AgentIntent {
  const text = normalize(message);
  if (!text) return 'unknown';

  if (/\b(hola|holaa+|holis|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|ola|menu|inicio|start)\b/.test(text)) return 'greet';
  if (/\b(ayuda|help|que puedo hacer|que podes hacer|opciones|comandos)\b/.test(text)) return 'help';
  if (/cambiar empresa|otra empresa|empresa activa|cambio de empresa|switch.*empresa/.test(text)) return 'switch_company';

  // query_freights: many natural variations
  if (
    /\b(mis|los|ver|listar|listame|mostrame|muestrame|dame|consultar|consulta|que|cuales|tengo)\b.*\bfletes?\b/.test(text)
    || /\bfletes?\b.*\b(pendientes?|activos?|en curso|finalizad[oa]s?|cerrad[oa]s?|hoy|manana|sin asignar)\b/.test(text)
    || /\b(estado|status)\b.*\bfletes?\b/.test(text)
    || /\bflete\s*(f-?\d+|#\d+|\d+)\b/.test(text)
  ) return 'query_freights';

  if (/\b(mapa|ubicacion|ubicaciones|geo|marcar|coordenadas|posicion|donde)\b/.test(text)) return 'share_map';
  if (/\b(adjuntar|adjunto|foto|imagen|documento|archivo|carta de porte|remito|cpe)\b/.test(text)) return 'attach_document';
  if (/cancelar (el )?flete|anular (el )?flete|dar de baja|cancela/.test(text)) return 'cancel_freight';
  if (/\b(cargue|cargado|ya cargue|confirmar carga|carga lista|termine de cargar)\b/.test(text)) return 'confirm_loaded';
  if (/\b(llegue|llegada|estoy en planta|llegamos)\b/.test(text)) return 'confirm_arrival';
  if (/\b(termine|descargue|finalizar|finalizado|completado|listo el viaje)\b/.test(text)) return 'finish_freight';
  if (/asignar transportista|transportista|empresa transportista|cambiar transportista/.test(text)) return 'assign_transport_company';
  if (/asignar camion|asignar chofer|chofer y camion|asignar conductor|asigname/.test(text)) return 'assign_driver_and_truck';
  if (
    /\b(crear|solicitar|nuevo|generar|armar|pedir|necesito)\b.*\b(flete|fletes|camion|camiones|viaje)\b/.test(text)
    || /\b(flete|viaje)\b.*\b(para|de|a|hasta|desde)\b/.test(text)
    || /\bpara\s+(soja|maiz|trigo|sorgo|girasol|cebada)\b/.test(text)
  ) return 'create_freight';

  return 'unknown';
}

async function classifyWithGemini(gemini: GeminiClient, message: string): Promise<AgentIntent | null> {
  try {
    const response = await gemini.sendMessage({
      system: INTENT_CLASSIFIER_PROMPT,
      messages: [{ role: 'user', parts: [{ text: message }] }] as any,
      tools: [],
    });
    const text = (response as any)?.text || (response as any)?.content || '';
    const match = String(text).match(/\{[\s\S]*?\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const result = IntentSchema.safeParse(parsed.intent);
    return result.success ? result.data : null;
  } catch (err: any) {
    logger.warn(`Gemini intent classification failed: ${err?.message || err}`);
    return null;
  }
}

function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\w\s#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
