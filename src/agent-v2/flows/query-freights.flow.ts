import { AgentState } from '../schemas/agent-state.schema';
import { AgentV2FreightTools, QueryFreightsInput } from '../tools/freight.tools';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';

export const QUERY_FREIGHTS_FLOW = {
  name: 'query_freights',
  readonly: true,
} as const;

export function makeQueryFreightsFlow(
  freightTools: AgentV2FreightTools,
  renderer: WhatsAppAgentV2Renderer,
  userProvider: () => any,
) {
  return async function queryFreightsFlow(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'query_freights') return {};
    const input = extractQueryFreightsInput(state.lastUserMessage, state.activeFreightCode);
    if (input.freightCode) {
      const detail = await freightTools.getFreightDetail(input, userProvider());
      return {
        response: detail ? renderer.freightDetail(detail) : renderer.noFreightsFound(),
        activeFreightCode: detail?.code || state.activeFreightCode || null,
        shouldPause: false,
        nodeHistory: [{ node: 'queryFreights', mode: 'detail', at: new Date().toISOString() }],
        toolCalls: [{ tool: 'getFreightDetail', result: detail ? 'found' : 'empty', at: new Date().toISOString() }],
      };
    }
    const items = await freightTools.listFreights(input, userProvider());
    return {
      response: renderer.freightList(items),
      activeFreightCode: items.length === 1 ? items[0].code : state.activeFreightCode || null,
      shouldPause: false,
      nodeHistory: [{ node: 'queryFreights', mode: 'list', count: items.length, at: new Date().toISOString() }],
      toolCalls: [{ tool: 'listFreights', result: items.length, at: new Date().toISOString() }],
    };
  };
}

export function extractQueryFreightsInput(message: string, activeFreightCode?: string | null): QueryFreightsInput {
  const normalized = normalize(message);
  const code = message.match(/\bF[-\s]?\d+\b/i)?.[0]?.replace(/\s+/g, '').toUpperCase()
    || (/ese (flete|viaje)/.test(normalized) ? activeFreightCode || undefined : undefined);
  const statusFilter = /pendiente|sin asignar/.test(normalized)
    ? 'pending_assignment'
    : /activo|activos|en curso|a campo|a planta/.test(normalized)
      ? undefined
      : /finalizado|cerrado/.test(normalized)
        ? 'finished'
        : undefined;
  return {
    freightCode: code,
    dateFilter: /manana/.test(normalized) ? 'tomorrow' : /hoy/.test(normalized) ? 'today' : 'all',
    statusFilter,
    limit: 10,
  };
}

function normalize(value: string): string {
  return (value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}
