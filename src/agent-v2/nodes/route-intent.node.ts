import { AgentState } from '../schemas/agent-state.schema';

export async function routeIntentNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.currentIntent === 'create_freight') {
    return {
      currentFlow: 'create_freight',
      currentStep: state.currentStep || 'extracting_slots',
    };
  }
  return {
    currentFlow: state.currentIntent || 'unknown',
    currentStep: 'ready',
  };
}

