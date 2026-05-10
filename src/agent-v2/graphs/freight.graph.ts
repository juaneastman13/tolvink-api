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
import { isGlobalCancelMessage } from '../nodes/cancel-intent';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentV2FreightTools } from '../tools/freight.tools';
import { AgentState } from '../schemas/agent-state.schema';

export function buildFreightGraph(
  gemini: GeminiClient,
  renderer: WhatsAppAgentV2Renderer,
  freightTools: AgentV2FreightTools,
  userProvider: () => any,
  locationLinkProvider?: (state: AgentState, type: 'origin' | 'destination') => Promise<string | null>,
) {
  return new StateGraph(AgentStateAnnotation)
    .addNode('extractSlots', makeExtractSlotsNode(gemini))
    .addNode('validateSlots', validateSlotsNode)
    .addNode('askMissingSlot', makeAskMissingSlotNode(renderer))
    .addNode('askLocation', makeAskLocationNode(renderer, locationLinkProvider))
    .addNode('checkPolicy', checkPolicyNode)
    .addNode('prepareConfirmation', makePrepareConfirmationNode(renderer))
    .addNode('resolveConfirmation', resolveConfirmationNode)
    .addNode('executeAction', makeExecuteActionNode(freightTools, renderer, userProvider))
    .addNode('renderSuccess', makeRenderSuccessNode(renderer))
    .addNode('cancelPendingAction', makeCancelPendingActionNode(renderer))
    .addNode('askConfirmationAgain', askConfirmationAgainNode)
    .addConditionalEdges(START, routeFreightStart, {
      cancelPendingAction: 'cancelPendingAction',
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
      end: END,
    })
    .addEdge('executeAction', 'renderSuccess')
    .addEdge('renderSuccess', END)
    .addEdge('cancelPendingAction', END)
    .addEdge('askConfirmationAgain', END)
    .compile();
}

function routeFreightStart(state: AgentState): 'cancelPendingAction' | 'extractSlots' | 'resolveConfirmation' {
  if (state.currentFlow === 'create_freight' && state.currentStep && isGlobalCancelMessage(state.lastUserMessage)) {
    return 'cancelPendingAction';
  }
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

function routeAfterConfirmation(state: AgentState): 'executeAction' | 'cancelPendingAction' | 'askConfirmationAgain' | 'end' {
  if (state.currentStep === 'confirmed') return 'executeAction';
  if (state.currentStep === 'cancelled') return 'cancelPendingAction';
  // resolveConfirmation prefilled a response (stale/missing pendingAction or
  // expired). Skip askConfirmationAgain — its node would overwrite the
  // response with the generic "necesito si o no" prompt.
  if (state.response) return 'end';
  return 'askConfirmationAgain';
}
