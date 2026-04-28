import { AgentState } from '../schemas/agent-state.schema';

export async function askConfirmationAgainNode(_state: AgentState): Promise<Partial<AgentState>> {
  return {
    currentStep: 'awaiting_confirmation',
    response: 'Necesito que confirmes con "si" o canceles con "no".',
    shouldPause: true,
  };
}

