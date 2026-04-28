import { FLOW_CATALOG } from '../catalogs/flows.catalog';
import { AgentState } from '../schemas/agent-state.schema';

export async function validateSlotsNode(state: AgentState): Promise<Partial<AgentState>> {
  if (state.currentFlow !== 'create_freight') return {};
  if (state.currentStep === 'awaiting_confirmation') return {};
  const required = [...FLOW_CATALOG.create_freight.requiredSlots];
  const missing = required.find((slot) => {
    const value = (state.slots || {})[slot];
    return value === undefined || value === null || value === '';
  });
  if (missing) {
    return {
      currentStep: 'awaiting_slot',
      awaitingSlot: missing,
      shouldPause: true,
      nodeHistory: [{ node: 'validateSlots', result: 'missing_slot', slot: missing, at: new Date().toISOString() }],
    };
  }
  if (!state.originLocation) {
    return {
      currentStep: 'awaiting_location',
      awaitingSlot: null,
      pendingLocationRequest: true,
      locationRequestType: 'origin',
      shouldPause: true,
      nodeHistory: [{ node: 'validateSlots', result: 'missing_location', type: 'origin', at: new Date().toISOString() }],
    };
  }
  if (!state.destinationLocation) {
    return {
      currentStep: 'awaiting_location',
      awaitingSlot: null,
      pendingLocationRequest: true,
      locationRequestType: 'destination',
      shouldPause: true,
      nodeHistory: [{ node: 'validateSlots', result: 'missing_location', type: 'destination', at: new Date().toISOString() }],
    };
  }
  return {
    currentStep: 'slots_valid',
    awaitingSlot: null,
    pendingLocationRequest: false,
    locationRequestType: null,
    shouldPause: false,
    nodeHistory: [{ node: 'validateSlots', result: 'ok', at: new Date().toISOString() }],
  };
}
