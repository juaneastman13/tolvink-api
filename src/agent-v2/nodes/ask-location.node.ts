import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeAskLocationNode(renderer: WhatsAppAgentV2Renderer) {
  return async function askLocationNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight' || state.currentStep !== 'awaiting_location') return {};
    const type = state.locationRequestType || 'origin';
    return {
      response: type === 'destination'
        ? renderer.askDestinationLocation()
        : renderer.askOriginLocation(),
      shouldPause: true,
      pendingLocationRequest: true,
      nodeHistory: [{ node: 'askLocation', type, at: new Date().toISOString() }],
    };
  };
}

