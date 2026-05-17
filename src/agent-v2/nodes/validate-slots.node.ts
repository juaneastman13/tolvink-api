import { FLOW_CATALOG } from '../catalogs/flows.catalog';
import { AgentLocation, AgentState } from '../schemas/agent-state.schema';
import { AgentV2LocationTools, LocationMatch } from '../tools/location.tools';

type UserProvider = () => any;

export function makeValidateSlotsNode(locationTools?: AgentV2LocationTools, userProvider?: UserProvider) {
  return async function validateSlotsNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight') return {};
    if (state.currentStep === 'awaiting_confirmation') return {};

    const required = [...FLOW_CATALOG.create_freight.requiredSlots];
    const missing = required.filter((slot) => {
      const value = (state.slots || {})[slot];
      return value === undefined || value === null || value === '';
    });

    if (missing.length > 0) {
      return {
        currentStep: 'awaiting_slot',
        awaitingSlot: missing[0],
        missingSlots: missing,
        shouldPause: true,
        nodeHistory: [{ node: 'validateSlots', result: 'missing_slots', slots: missing, at: new Date().toISOString() }],
      };
    }

    if (!state.originLocation) {
      const resolved = await tryResolve(state, 'origin', locationTools, userProvider);
      if (resolved) return resolved;
      return missingLocation('origin');
    }
    if (!state.destinationLocation) {
      const resolved = await tryResolve(state, 'destination', locationTools, userProvider);
      if (resolved) return resolved;
      return missingLocation('destination');
    }

    return {
      currentStep: 'slots_valid',
      awaitingSlot: null,
      missingSlots: [],
      pendingLocationRequest: false,
      locationRequestType: null,
      locationChoices: [],
      awaitingLocationChoice: null,
      shouldPause: false,
      nodeHistory: [{ node: 'validateSlots', result: 'ok', at: new Date().toISOString() }],
    };
  };
}

// Backwards-compatible: graphs/tests que importan validateSlotsNode directo siguen funcionando
// (sin resolucion de ubicaciones — cae siempre al map picker).
export const validateSlotsNode = makeValidateSlotsNode();

async function tryResolve(
  state: AgentState,
  type: 'origin' | 'destination',
  locationTools: AgentV2LocationTools | undefined,
  userProvider: UserProvider | undefined,
): Promise<Partial<AgentState> | null> {
  if (!locationTools || !userProvider) return null;
  const query = type === 'origin' ? state.originText : state.destinationText;
  if (!query) return null;
  const user = userProvider();
  const matches = await locationTools.resolveUserLocation(query, type, user).catch(() => [] as LocationMatch[]);
  if (!matches.length) return null;

  if (matches.length === 1 || matches[0].score >= 0.9) {
    const m = matches[0];
    const location: AgentLocation = {
      lat: m.lat,
      lng: m.lng,
      label: m.label,
      source: 'backend_known_location',
      capturedAt: new Date().toISOString(),
      capturedByUserId: user?.id || user?.sub || '',
    };
    return type === 'origin'
      ? { originLocation: location, locationChoices: [], awaitingLocationChoice: null, nodeHistory: [{ node: 'validateSlots', result: 'resolved_origin', kind: m.kind, at: new Date().toISOString() }] }
      : { destinationLocation: location, locationChoices: [], awaitingLocationChoice: null, nodeHistory: [{ node: 'validateSlots', result: 'resolved_destination', kind: m.kind, at: new Date().toISOString() }] };
  }

  // ambigüedad: dejar la elección al user
  return {
    currentStep: 'awaiting_location',
    awaitingSlot: null,
    pendingLocationRequest: true,
    locationRequestType: type,
    locationChoices: matches.map((m) => ({ id: m.id, label: m.label, lat: m.lat, lng: m.lng, kind: m.kind === 'tolvink_plant' ? 'plant' : m.kind as any })),
    awaitingLocationChoice: type,
    shouldPause: true,
    nodeHistory: [{ node: 'validateSlots', result: 'location_ambiguous', type, count: matches.length, at: new Date().toISOString() }],
  };
}

function missingLocation(type: 'origin' | 'destination'): Partial<AgentState> {
  return {
    currentStep: 'awaiting_location',
    awaitingSlot: null,
    missingSlots: [],
    pendingLocationRequest: true,
    locationRequestType: type,
    locationChoices: [],
    awaitingLocationChoice: null,
    shouldPause: true,
    nodeHistory: [{ node: 'validateSlots', result: 'missing_location', type, at: new Date().toISOString() }],
  };
}
