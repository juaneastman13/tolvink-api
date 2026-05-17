import { GeminiClient } from '../../ai/core/gemini.client';
import { CREATE_FREIGHT_SLOT_EXTRACTOR_PROMPT } from '../prompts/slot-extractor.prompt';
import { AgentLocation, AgentState } from '../schemas/agent-state.schema';
import { CreateFreightSlotsPatchSchema } from '../schemas/freight.schema';

export function makeExtractSlotsNode(gemini: GeminiClient) {
  return async function extractSlotsNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight') return {};

    // Si estabamos esperando que el usuario elija entre matches ambiguos de ubicacion,
    // intentar resolver su respuesta (button id, numero "1", o "otra" para ir al map).
    if (state.currentStep === 'awaiting_location' && (state.locationChoices || []).length > 0 && state.awaitingLocationChoice) {
      const resolved = resolveLocationChoice(state);
      if (resolved) return resolved;
    }

    const heuristicSlots = extractCreateFreightSlotsHeuristic(state.lastUserMessage);

    // Fallback puntual: si estabamos esperando UN slot puntual y el usuario respondio
    // algo corto que la heuristica no levanto (ej. "3" para truckCount), intentar parseo single.
    if (
      state.currentStep === 'awaiting_slot'
      && state.awaitingSlot
      && (state.missingSlots || []).length === 1
      && Object.keys(heuristicSlots).length === 0
    ) {
      const value = parseSingleSlot(state.awaitingSlot, state.lastUserMessage);
      if (value !== undefined && value !== '' && value !== null) {
        return {
          originText: state.awaitingSlot === 'origin' ? String(value || '') : state.originText,
          destinationText: state.awaitingSlot === 'destination' ? String(value || '') : state.destinationText,
          slots: { ...(state.slots || {}), [state.awaitingSlot]: value },
          awaitingSlot: null,
          nodeHistory: [{ node: 'extractSlots', mode: 'single_slot_fallback', slot: state.awaitingSlot, at: new Date().toISOString() }],
        };
      }
    }

    const llmSlots = await extractWithLlm(gemini, state.lastUserMessage).catch(() => ({}));
    const llmPatch = llmSlots as Record<string, unknown>;
    const originText = (heuristicSlots.origin || llmPatch.origin || state.originText || state.slots?.origin || null) as string | null;
    const destinationText = (heuristicSlots.destination || llmPatch.destination || state.destinationText || state.slots?.destination || null) as string | null;
    return {
      originText,
      destinationText,
      slots: {
        ...(state.slots || {}),
        ...heuristicSlots,
        ...llmSlots,
      },
      nodeHistory: [{ node: 'extractSlots', at: new Date().toISOString() }],
    };
  };
}

async function extractWithLlm(gemini: GeminiClient, message: string): Promise<Record<string, unknown>> {
  if (!gemini.isEnabled()) return {};
  const response = await gemini.sendMessage({
    system: CREATE_FREIGHT_SLOT_EXTRACTOR_PROMPT,
    messages: [{ role: 'user', parts: [{ text: message.slice(0, 1500) }] }],
    tools: [],
  });
  const raw = response.text?.trim();
  if (!raw) return {};
  const json = raw.match(/\{[\s\S]*\}/)?.[0] || raw;
  const parsed = JSON.parse(json);
  return CreateFreightSlotsPatchSchema.parse(parsed);
}

export function extractCreateFreightSlotsHeuristic(message: string): Record<string, unknown> {
  const text = message || '';
  const normalized = normalize(text);
  const slots: Record<string, unknown> = {};

  const trucks = normalized.match(/(\d+)\s*(camion|camiones|viajes)/);
  if (trucks) slots.truckCount = Number(trucks[1]);

  const product = normalized.match(/\b(soja|maiz|trigo|cebada|sorgo|colza|arroz)\b/);
  if (product) slots.product = product[1] === 'maiz' ? 'maiz' : product[1];

  if (/\bmanana\b/.test(normalized)) slots.date = 'manana';
  else if (/\bhoy\b/.test(normalized)) slots.date = 'hoy';
  else {
    const isoDate = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (isoDate) slots.date = isoDate[1];
  }

  const time = normalized.match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/);
  if (time && /(hora|hs|am|pm|:)/.test(time[0] + normalized.slice(Math.max(0, time.index! - 8), time.index! + 8))) {
    slots.time = normalizeTime(time[1], time[2], time[3]);
  }

  const fromTo = text.match(/desde\s+(.+?)\s+(?:a|hasta|para)\s+(.+?)(?:\s+(?:el|para|mañana|manana|hoy|\d{1,2}\s*am|\d{1,2}:\d{2}|con|observaciones?|$))/i);
  if (fromTo) {
    slots.origin = cleanPlace(fromTo[1]);
    slots.destination = cleanPlace(fromTo[2]);
  }

  const obs = text.match(/(?:obs|observacion|observaciones|nota|notas)[:\s]+(.+)$/i);
  if (obs) slots.observations = obs[1].trim().slice(0, 1000);

  return slots;
}

function parseSingleSlot(slot: string, value: string): unknown {
  if (slot === 'truckCount') {
    const n = Number((value || '').match(/\d+/)?.[0]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  if (slot === 'time') {
    const m = normalize(value).match(/\b([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/);
    if (m) return normalizeTime(m[1], m[2], m[3]);
  }
  return value.trim();
}

function normalize(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function normalizeTime(hourRaw: string, minuteRaw?: string, meridian?: string): string {
  let hour = Number(hourRaw);
  if (meridian === 'pm' && hour < 12) hour += 12;
  if (meridian === 'am' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${String(minuteRaw || '00').padStart(2, '0')}`;
}

function cleanPlace(value: string): string {
  return value.replace(/\b(\d+)\s*(camion|camiones)\b/ig, '').trim().replace(/[.,;]+$/, '');
}

function resolveLocationChoice(state: AgentState): Partial<AgentState> | null {
  const type = state.awaitingLocationChoice!;
  const msg = (state.lastUserMessage || '').trim();
  const lower = msg.toLowerCase();

  // "otra" / "ninguna" / "mapa" -> ir al map picker, limpiar choices
  if (/^(otra|otro|ninguna|ninguno|mapa|en el mapa)$/i.test(lower)) {
    return {
      currentStep: 'awaiting_location',
      locationChoices: [],
      awaitingLocationChoice: null,
      locationRequestType: type,
      pendingLocationRequest: true,
      shouldPause: true,
      nodeHistory: [{ node: 'extractSlots', mode: 'choice_skip_to_map', type, at: new Date().toISOString() }],
    };
  }

  // Button id: "loc:origin:abc"
  let chosenId: string | null = null;
  const buttonMatch = msg.match(/^loc:(origin|destination):(.+)$/);
  if (buttonMatch && buttonMatch[1] === type) chosenId = buttonMatch[2];

  // Numero: "1", "2"...
  if (!chosenId) {
    const n = Number(msg.match(/^\d+$/)?.[0]);
    if (Number.isFinite(n) && n >= 1 && n <= state.locationChoices.length) {
      chosenId = state.locationChoices[n - 1].id;
    }
  }

  if (!chosenId) return null;
  const choice = state.locationChoices.find((c) => c.id === chosenId);
  if (!choice) return null;

  const user = state as any;
  const location: AgentLocation = {
    lat: choice.lat,
    lng: choice.lng,
    label: choice.label,
    source: 'backend_known_location',
    capturedAt: new Date().toISOString(),
    capturedByUserId: user?.userId || '',
  };
  const patch: Partial<AgentState> = {
    locationChoices: [],
    awaitingLocationChoice: null,
    locationRequestType: null,
    pendingLocationRequest: false,
    nodeHistory: [{ node: 'extractSlots', mode: 'choice_resolved', type, choiceId: chosenId, at: new Date().toISOString() }],
  };
  if (type === 'origin') patch.originLocation = location;
  else patch.destinationLocation = location;
  return patch;
}
