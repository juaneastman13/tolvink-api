import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState, parseCreateFreightSlots } from '../schemas/agent-state.schema';
import * as crypto from 'crypto';

export function makePrepareConfirmationNode(renderer: WhatsAppAgentV2Renderer) {
  return async function prepareConfirmationNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight') return {};
    if (state.currentStep !== 'policy_ok') return {};

    const slots = parseCreateFreightSlots(state.slots);
    const actionId = crypto.randomUUID();
    const confirmationId = crypto.randomUUID();
    const summary = renderer.createFreightConfirmation(slots, {
      originLocation: state.originLocation,
      destinationLocation: state.destinationLocation,
    });
    return {
      currentStep: 'awaiting_confirmation',
      pendingConfirmation: true,
      pendingAction: {
        action: 'create_freight',
        payload: {
          ...slots,
          originLocation: state.originLocation || null,
          destinationLocation: state.destinationLocation || null,
          actionId,
          confirmationId,
          idempotencyKey: `agent-v2:create_freight:${state.sessionId || state.userId}:${confirmationId}`,
        },
        summary,
        requiresConfirmation: true,
        auditId: actionId,
        createdAt: new Date().toISOString(),
      },
      response: summary,
      shouldPause: true,
      auditTrail: [{ node: 'prepareConfirmation', actionId, confirmationId, at: new Date().toISOString() }],
      nodeHistory: [{ node: 'prepareConfirmation', at: new Date().toISOString() }],
    };
  };
}
