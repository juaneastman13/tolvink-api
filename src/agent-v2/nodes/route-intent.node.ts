import { AgentState } from '../schemas/agent-state.schema';

export async function routeIntentNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.currentIntent === 'create_freight') {
    return {
      currentFlow: 'create_freight',
      currentStep: state.currentStep || 'extracting_slots',
    };
  }
  if (state.currentIntent === 'share_map') {
    return {
      currentFlow: 'share_map',
      currentStep: state.currentStep || 'resolving_freight',
    };
  }
  return {
    currentFlow: state.currentIntent || 'unknown',
    currentStep: 'ready',
  };
}
