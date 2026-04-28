import { END, START, StateGraph } from '@langchain/langgraph';
import { GeminiClient } from '../../ai/core/gemini.client';
import { AgentStateAnnotation } from '../schemas/agent-state.schema';
import { makeExtractSlotsNode } from '../nodes/extract-slots.node';
import { validateSlotsNode } from '../nodes/validate-slots.node';
import { makeAskMissingSlotNode } from '../nodes/ask-missing-slot.node';
import { makeAskLocationNode } from '../nodes/ask-location.node';
import { checkPolicyNode } from '../nodes/check-policy.node';
import { makePrepareConfirmationNode } from '../nodes/prepare-confirmation.node';
import { makeExecuteActionNode } from '../nodes/execute-action.node';
import { resolveConfirmationNode } from '../nodes/resolve-confirmation.node';
import { makeCancelPendingActionNode } from '../nodes/cancel-pending-action.node';
import { askConfirmationAgainNode } from '../nodes/ask-confirmation-again.node';
import { makeRenderSuccessNode } from '../nodes/render-success.node';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentV2FreightTools } from '../tools/freight.tools';
import { AgentState } from '../schemas/agent-state.schema';

export function buildFreightGraph(
  gemini: GeminiClient,
  renderer: WhatsAppAgentV2Renderer,
  freightTools: AgentV2FreightTools,
  userProvider: () => any,
) {
  return new StateGraph(AgentStateAnnotation)
    .addNode('extractSlots', makeExtractSlotsNode(gemini))
    .addNode('validateSlots', validateSlotsNode)
    .addNode('askMissingSlot', makeAskMissingSlotNode(renderer))
    .addNode('askLocation', makeAskLocationNode(renderer))
    .addNode('checkPolicy', checkPolicyNode)
    .addNode('prepareConfirmation', makePrepareConfirmationNode(renderer))
    .addNode('resolveConfirmation', resolveConfirmationNode)
    .addNode('executeAction', makeExecuteActionNode(freightTools, renderer, userProvider))
    .addNode('renderSuccess', makeRenderSuccessNode(renderer))
    .addNode('cancelPendingAction', makeCancelPendingActionNode(renderer))
    .addNode('askConfirmationAgain', askConfirmationAgainNode)
    .addConditionalEdges(START, routeFreightStart, {
      extractSlots: 'extractSlots',
      resolveConfirmation: 'resolveConfirmation',
    })
    .addEdge('extractSlots', 'validateSlots')
    .addConditionalEdges('validateSlots', routeAfterValidation, {
      askMissingSlot: 'askMissingSlot',
      askLocation: 'askLocation',
      checkPolicy: 'checkPolicy',
    })
    .addEdge('askMissingSlot', END)
    .addEdge('askLocation', END)
    .addConditionalEdges('checkPolicy', routeAfterPolicy, {
      prepareConfirmation: 'prepareConfirmation',
      end: END,
    })
    .addEdge('prepareConfirmation', END)
    .addConditionalEdges('resolveConfirmation', routeAfterConfirmation, {
      executeAction: 'executeAction',
      cancelPendingAction: 'cancelPendingAction',
      askConfirmationAgain: 'askConfirmationAgain',
    })
    .addEdge('executeAction', 'renderSuccess')
    .addEdge('renderSuccess', END)
    .addEdge('cancelPendingAction', END)
    .addEdge('askConfirmationAgain', END)
    .compile();
}

function routeFreightStart(state: AgentState): 'extractSlots' | 'resolveConfirmation' {
  if (state.currentStep === 'awaiting_confirmation' || state.pendingConfirmation) {
    return 'resolveConfirmation';
  }
  return 'extractSlots';
}

function routeAfterValidation(state: AgentState): 'askMissingSlot' | 'askLocation' | 'checkPolicy' {
  if (state.currentStep === 'awaiting_slot') return 'askMissingSlot';
  if (state.currentStep === 'awaiting_location') return 'askLocation';
  return 'checkPolicy';
}

function routeAfterPolicy(state: AgentState): 'prepareConfirmation' | 'end' {
  return state.currentStep === 'policy_ok' ? 'prepareConfirmation' : 'end';
}

function routeAfterConfirmation(state: AgentState): 'executeAction' | 'cancelPendingAction' | 'askConfirmationAgain' {
  if (state.currentStep === 'confirmed') return 'executeAction';
  if (state.currentStep === 'cancelled') return 'cancelPendingAction';
  return 'askConfirmationAgain';
}
