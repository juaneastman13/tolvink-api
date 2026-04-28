import { AgentState } from '../schemas/agent-state.schema';

export async function loadSessionNode(state: AgentState): Promise<Partial<AgentState>> {
  return {
    channel: state.channel || 'whatsapp',
    slots: state.slots || {},
    pendingConfirmation: !!state.pendingConfirmation,
    shouldPause: false,
    shouldPersist: true,
    audit: [...(state.audit || []), { node: 'loadSession', at: new Date().toISOString() }],
  };
}

