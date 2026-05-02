import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeCancelPendingActionNode(renderer: WhatsAppAgentV2Renderer) {
  return async function cancelPendingActionNode(state: AgentState): Promise<Partial<AgentState>> {
    return {
      currentIntent: undefined,
      currentFlow: null,
      currentStep: null,
      awaitingSlot: null,
      slots: {},
      originText: null,
      destinationText: null,
      originLocation: null,
      destinationLocation: null,
      pendingLocationRequest: false,
      locationRequestToken: null,
      locationRequestType: null,
      pendingAction: null,
      pendingConfirmation: false,
      response: renderer.canceled(),
      shouldPause: false,
      auditTrail: [{ node: 'cancelPendingAction', flow: state.currentFlow || null, step: state.currentStep || null, at: new Date().toISOString() }],
      nodeHistory: [{ node: 'cancelPendingAction', at: new Date().toISOString() }],
    };
  };
}
