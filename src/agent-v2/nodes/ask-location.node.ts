import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';

export type LocationLinkProvider = (state: AgentState, type: 'origin' | 'destination') => Promise<string | null>;

export function makeAskLocationNode(renderer: WhatsAppAgentV2Renderer, linkProvider?: LocationLinkProvider) {
  return async function askLocationNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight' || state.currentStep !== 'awaiting_location') return {};
    const type = state.locationRequestType === 'destination' ? 'destination' : 'origin';

    // Si hay matches ambiguos, ofrecer elegir antes del map picker.
    if ((state.locationChoices || []).length > 0 && state.awaitingLocationChoice === type) {
      const rendered = renderer.askLocationChoice(type, state.locationChoices);
      return {
        response: rendered.text,
        buttons: rendered.buttons,
        shouldPause: true,
        pendingLocationRequest: true,
        nodeHistory: [{ node: 'askLocation', type, mode: 'choice', count: state.locationChoices.length, at: new Date().toISOString() }],
      };
    }

    const url = linkProvider ? await linkProvider(state, type).catch(() => null) : null;
    return {
      response: url
        ? renderer.pickLocationViaLink(url, type)
        : type === 'destination'
          ? renderer.askDestinationLocation()
          : renderer.askOriginLocation(),
      shouldPause: true,
      pendingLocationRequest: true,
      nodeHistory: [{ node: 'askLocation', type, mode: 'map', at: new Date().toISOString() }],
    };
  };
}
