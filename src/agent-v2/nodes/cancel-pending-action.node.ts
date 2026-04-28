import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeCancelPendingActionNode(renderer: WhatsAppAgentV2Renderer) {
  return async function cancelPendingActionNode(_state: AgentState): Promise<Partial<AgentState>> {
    return {
      currentFlow: null,
      currentStep: null,
      pendingAction: null,
      pendingConfirmation: false,
      response: renderer.canceled(),
      shouldPause: false,
    };
  };
}

