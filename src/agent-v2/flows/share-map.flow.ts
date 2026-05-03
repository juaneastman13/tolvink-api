import { AgentState } from '../schemas/agent-state.schema';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentV2FreightTools } from '../tools/freight.tools';
import { AgentV2LocationTools } from '../tools/location.tools';

export const SHARE_MAP_FLOW = {
  name: 'share_map',
  readonly: true,
} as const;

export function makeShareMapFlow(
  freightTools: AgentV2FreightTools,
  locationTools: AgentV2LocationTools,
  renderer: WhatsAppAgentV2Renderer,
  userProvider: () => any,
) {
  return async function shareMapFlow(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'share_map') return {};

    const freightCode = extractMapFreightCode(state.lastUserMessage, state.activeFreightCode);
    if (!freightCode) {
      return {
        response: renderer.askFreightCodeForMap(),
        currentStep: 'awaiting_freight_code',
        shouldPause: true,
        nodeHistory: [{ node: 'shareMap', mode: 'awaiting_freight_code', at: new Date().toISOString() }],
      };
    }

    const user = userProvider();
    const freight = await freightTools.getFreightDetail({ freightCode }, user);
    if (!freight) {
      return {
        response: renderer.noFreightsFound(),
        currentStep: 'ready',
        shouldPause: false,
        nodeHistory: [{ node: 'shareMap', mode: 'not_found', freightCode, at: new Date().toISOString() }],
        toolCalls: [{ tool: 'getFreightDetail', result: 'empty', at: new Date().toISOString() }],
      };
    }

    const link = await locationTools.generatePublicMapLink(freight.id, {
      allowedTypes: ['ORIGIN', 'DESTINATION', 'POINT_OF_INTEREST'],
      ttlMinutes: 24 * 60,
      purpose: 'agent_v2_share_map',
      createdByUserId: user?.id || user?.sub,
    });

    return {
      response: renderer.publicMapLink(link.url, link.ttlMinutes, link.allowedTypes),
      activeFreightCode: freight.code,
      currentStep: 'ready',
      shouldPause: false,
      nodeHistory: [{ node: 'shareMap', mode: 'generated', freightCode: freight.code, at: new Date().toISOString() }],
      toolCalls: [
        { tool: 'getFreightDetail', result: 'found', at: new Date().toISOString() },
        { tool: 'generatePublicMapLink', result: 'created', allowedTypes: link.allowedTypes, at: new Date().toISOString() },
      ],
    };
  };
}

export function extractMapFreightCode(message: string, activeFreightCode?: string | null): string | undefined {
  const direct = message.match(/\bF[-\s]?\d+\b/i)?.[0]?.replace(/\s+/g, '').toUpperCase();
  if (direct) return direct;
  const normalized = normalize(message);
  if (/ese (flete|viaje)|este (flete|viaje)|el mismo/.test(normalized)) return activeFreightCode || undefined;
  if (/^\s*F[-\s]?\d+\s*$/i.test(message || '')) return (message || '').replace(/\s+/g, '').toUpperCase();
  return undefined;
}

function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
