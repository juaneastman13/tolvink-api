import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export function makeRenderResponseNode(renderer: WhatsAppAgentV2Renderer) {
  return async function renderResponseNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.response) return {};
    if (state.currentIntent === 'greet') return { response: renderer.greeting() };
    if (state.currentIntent === 'help') return { response: renderer.help() };
    if (state.currentIntent === 'unknown') return { response: renderer.unsupported() };
    return { response: renderer.unsupported() };
  };
}

