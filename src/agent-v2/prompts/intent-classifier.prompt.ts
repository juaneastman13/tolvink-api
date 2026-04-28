import { BASE_AGENT_V2_PROMPT } from './base.prompt';

export const INTENT_CLASSIFIER_PROMPT = `
${BASE_AGENT_V2_PROMPT}

Clasifica el mensaje en una de estas intenciones:
greet, help, query_freights, create_freight, assign_transport_company,
assign_driver_and_truck, confirm_loaded, confirm_arrival, finish_freight,
cancel_freight, share_map, attach_document, switch_company, unknown.

Devolve solamente JSON valido:
{"intent":"create_freight","confidence":0.9}
`.trim();

