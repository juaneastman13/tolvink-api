import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeAskMissingSlotNode(renderer: WhatsAppAgentV2Renderer) {
  return async function askMissingSlotNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight') return {};
    if (state.currentStep !== 'awaiting_slot') return {};
    const missing = state.missingSlots && state.missingSlots.length > 0
      ? state.missingSlots
      : state.awaitingSlot
        ? [state.awaitingSlot]
        : [];
    if (!missing.length) return {};
    return {
      response: renderer.askMissingSlots(missing),
      shouldPause: true,
    };
  };
}
