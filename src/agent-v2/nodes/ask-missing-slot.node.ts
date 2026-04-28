import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeAskMissingSlotNode(renderer: WhatsAppAgentV2Renderer) {
  return async function askMissingSlotNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight') return {};
    if (state.currentStep !== 'awaiting_slot' || !state.awaitingSlot) return {};
    return {
      response: renderer.askMissingSlot(state.awaitingSlot),
      shouldPause: true,
    };
  };
}

