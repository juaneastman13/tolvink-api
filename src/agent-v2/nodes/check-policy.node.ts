import { checkActionPolicy } from '../policies/action-policy';
import { AgentState } from '../schemas/agent-state.schema';

export async function checkPolicyNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.currentFlow !== 'create_freight' || state.currentStep !== 'slots_valid') return {};
  const decision = checkActionPolicy(state, 'create_freight');
  if (!decision.allowed) {
    return {
      response: decision.reason,
      currentStep: 'policy_denied',
      shouldPause: true,
    };
  }
  return {
    currentStep: 'policy_ok',
  };
}

