import { AgentState } from '../schemas/agent-state.schema';
import { isGlobalCancelMessage } from './cancel-intent';

export async function resolveConfirmationNode(state: AgentState): Promise<Partial<AgentState>> {
  const answer = normalize(state.lastUserMessage);
  if (/^(si|sí|ok|dale|va|confirmo|confirmar)$/.test(answer)) {
    return {
      currentStep: 'confirmed',
      pendingConfirmation: false,
      shouldPause: false,
    };
  }
  if (/^no$/.test(answer) || isGlobalCancelMessage(state.lastUserMessage)) {
    return {
      currentStep: 'cancelled',
      shouldPause: false,
    };
  }
  return {
    currentStep: 'confirmation_unclear',
    shouldPause: true,
  };
}

function normalize(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
