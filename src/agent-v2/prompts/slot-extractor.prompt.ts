import { BASE_AGENT_V2_PROMPT } from './base.prompt';

export const CREATE_FREIGHT_SLOT_EXTRACTOR_PROMPT = `
${BASE_AGENT_V2_PROMPT}

Extrae slots para crear una solicitud de flete.
Slots permitidos: product, origin, destination, date, time, truckCount, observations.
Normaliza hora a HH:MM si es claro. Para fechas relativas, usa palabras como "hoy" o "manana" si no tenes fecha absoluta.
No inventes slots. Si un dato no aparece, omitilo.

Devolve solamente JSON valido.
Ejemplo:
{"product":"soja","origin":"Ombues","destination":"Nueva Palmira","date":"manana","truckCount":2}
`.trim();

