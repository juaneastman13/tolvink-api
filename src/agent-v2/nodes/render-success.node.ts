import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeRenderSuccessNode(renderer: WhatsAppAgentV2Renderer) {
  return async function renderSuccessNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.response) return {};
    return {
      response: renderer.created(String(state.pendingAction?.payload?.code || 'pendiente')),
      shouldPause: false,
    };
  };
}

