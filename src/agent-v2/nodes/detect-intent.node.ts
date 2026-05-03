import { AgentState } from '../schemas/agent-state.schema';
import { AgentIntent } from '../schemas/intent.schema';

export async function detectIntentNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.currentFlow === 'create_freight' && state.currentStep) {
    return { currentIntent: 'create_freight' };
  }
  if (state.currentFlow === 'share_map' && state.currentStep === 'awaiting_freight_code') {
    return { currentIntent: 'share_map' };
  }
  return { currentIntent: detectIntentHeuristic(state.lastUserMessage) };
}

export function detectIntentHeuristic(message: string): AgentIntent {
  const text = normalize(message);
  if (/^(hola|buenas|menu|inicio)$/.test(text)) return 'greet';
  if (/^(ayuda|help)$/.test(text)) return 'help';
  if (/cambiar empresa|otra empresa|empresa activa/.test(text)) return 'switch_company';
  if (/mis fletes|fletes activos|estado de fletes|ver fletes/.test(text)) return 'query_freights';
  if (/mapa|ubicacion|ubicaciones|marcar/.test(text)) return 'share_map';
  if (/adjuntar|foto|documento|archivo/.test(text)) return 'attach_document';
  if (/cancelar flete|anular flete/.test(text)) return 'cancel_freight';
  if (/cargue|cargado|confirmar carga/.test(text)) return 'confirm_loaded';
  if (/llegue|llegada/.test(text)) return 'confirm_arrival';
  if (/termine|descargue|finalizar/.test(text)) return 'finish_freight';
  if (/asignar transportista|transportista/.test(text)) return 'assign_transport_company';
  if (/asignar camion|asignar chofer|chofer y camion/.test(text)) return 'assign_driver_and_truck';
  if (/crear flete|solicitar flete|necesito .*camion|necesito .*camiones|pedido.*flete|para .*soja|para .*maiz|para .*trigo/.test(text)) return 'create_freight';
  return 'unknown';
}

function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
