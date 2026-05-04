import { END, START, StateGraph } from '@langchain/langgraph';
import { GeminiClient } from '../../ai/core/gemini.client';
import { AgentState, AgentStateAnnotation } from '../schemas/agent-state.schema';
import { loadSessionNode } from '../nodes/load-session.node';
import { detectIntentNode } from '../nodes/detect-intent.node';
import { routeIntentNode } from '../nodes/route-intent.node';
import { makeRenderResponseNode } from '../nodes/render-response.node';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentV2FreightTools } from '../tools/freight.tools';
import { AgentV2LocationTools } from '../tools/location.tools';
import { buildFreightGraph } from './freight.graph';
import { makeQueryFreightsFlow } from '../flows/query-freights.flow';
import { makeShareMapFlow } from '../flows/share-map.flow';

export function buildMainGraph(
  gemini: GeminiClient,
  renderer: WhatsAppAgentV2Renderer,
  freightTools: AgentV2FreightTools,
  locationTools: AgentV2LocationTools,
  userProvider: () => any,
  locationLinkProvider?: (state: AgentState, type: 'origin' | 'destination') => Promise<string | null>,
) {
  const freightGraph = buildFreightGraph(gemini, renderer, freightTools, userProvider, locationLinkProvider);
  const queryFreightsFlow = makeQueryFreightsFlow(freightTools, renderer, userProvider);
  const shareMapFlow = makeShareMapFlow(freightTools, locationTools, renderer, userProvider);

  const runSubgraph = async (state: AgentState): Promise<Partial<AgentState>> => {
    if (state.currentFlow === 'create_freight') {
      return await freightGraph.invoke(state) as Partial<AgentState>;
    }
    if (state.currentFlow === 'query_freights') {
      return await queryFreightsFlow(state);
    }
    if (state.currentFlow === 'share_map') {
      return await shareMapFlow(state);
    }
    return {};
  };

  return new StateGraph(AgentStateAnnotation)
    .addNode('loadSession', loadSessionNode)
    .addNode('detectIntent', detectIntentNode)
    .addNode('routeIntent', routeIntentNode)
    .addNode('runSubgraph', runSubgraph)
    .addNode('renderResponse', makeRenderResponseNode(renderer))
    .addEdge(START, 'loadSession')
    .addEdge('loadSession', 'detectIntent')
    .addEdge('detectIntent', 'routeIntent')
    .addEdge('routeIntent', 'runSubgraph')
    .addEdge('runSubgraph', 'renderResponse')
    .addEdge('renderResponse', END)
    .compile();
}
