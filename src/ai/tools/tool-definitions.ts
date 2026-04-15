// =====================================================================
// TOLVINK — AI Tool Definitions (Anthropic input_schema format)
// Each tool maps to a real FreightsService / FieldsService / TrucksService method
// =====================================================================

export interface AiToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
}

export const ALL_TOOL_DEFINITIONS: AiToolDefinition[] = [

  // ======================== CONSULTAS ========================

  {
    name: 'list_freights',
    description: 'Lista fletes del usuario. Sin filtros muestra activos. Devuelve codigo, estado, grano, origen, destino.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'], description: 'Filtrar por estado' },
        grain: { type: 'string', description: 'Filtrar por grano' },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD)' },
      },
      required: [],
    },
  },
  {
    name: 'get_freight_detail',
    description: 'Detalle completo de un flete por codigo (ej: F26-ABC.1234). Incluye estado, grano, toneladas, origen, destino, camion, chofer, fechas.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (ej: F26-ABC.1234)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_dashboard',
    description: 'Resumen ejecutivo: cantidad de fletes por estado, totales del mes.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ======================== BUSQUEDA DE ENTIDADES ========================

  {
    name: 'search_plants',
    description: 'Busca plantas/acopios por nombre. Devuelve nombre, ID y sucursales. Usar ANTES de crear flete para resolver destino.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nombre o parte del nombre de la planta' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_fields',
    description: 'Busca campos del usuario por nombre. Devuelve nombre, ID y lotes. Usar ANTES de crear flete para resolver origen.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nombre o parte del nombre del campo' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_lots',
    description: 'Busca lotes dentro de un campo. Si se proporciona fieldId, filtra por ese campo.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Nombre del lote' },
        fieldId: { type: 'string', description: 'UUID del campo para filtrar' },
      },
      required: ['query'],
    },
  },

  // ======================== CREACION AUTONOMA ========================

  {
    name: 'prepare_autonomous_freight',
    description: 'Prepara flete autonomo para chofer. El flete se crea en estado "A planta" (loaded). El camion se auto-detecta. Si hay flete activo, devuelve error indicandolo. Retorna resumen para confirmacion — los botones CONFIRMAR/CANCELAR se agregan automaticamente.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Nombre del origen (campo, lote o texto libre)' },
        destination: { type: 'string', description: 'Nombre del destino (planta o texto libre)' },
        grain: { type: 'string', description: 'Tipo de grano (soja, maiz, trigo, etc.)' },
        weightKg: { type: 'number', description: 'Peso en kilogramos (30 toneladas = 30000)' },
        fieldId: { type: 'string', description: 'UUID del campo de origen (de search_fields)' },
        originLotId: { type: 'string', description: 'UUID del lote de origen (de search_lots)' },
        destPlantId: { type: 'string', description: 'UUID de planta destino (de search_plants)' },
        branchId: { type: 'string', description: 'UUID de sucursal destino' },
        notes: { type: 'string', description: 'Notas adicionales' },
      },
      required: ['origin', 'destination', 'grain', 'weightKg'],
    },
  },
  {
    name: 'confirm_action',
    description: 'Ejecuta la accion previamente preparada (crear flete, finalizar, cancelar, adjuntar). Llamar SOLO cuando el usuario confirma.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },

  // ======================== FINALIZACION ========================

  {
    name: 'finish_autonomous_freight',
    description: 'Finaliza flete autonomo activo. Auto-detecta el flete si no se indica codigo. Opcionalmente registra peso de destino.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional, auto-detecta si solo hay uno activo)' },
        destinationWeightKg: { type: 'number', description: 'Peso neto en destino en kg (del ticket de balanza)' },
      },
      required: [],
    },
  },
  {
    name: 'register_plant_arrival',
    description: 'Registra llegada del chofer a la planta. El flete sigue en estado "A planta". Auto-detecta flete activo.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional)' },
      },
      required: [],
    },
  },

  // ======================== CANCELACION ========================

  {
    name: 'cancel_freight',
    description: 'Cancela un flete. Requiere motivo obligatorio.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        reason: { type: 'string', description: 'Motivo de cancelacion (obligatorio)' },
      },
      required: ['code', 'reason'],
    },
  },

  // ======================== DOCUMENTOS ========================

  {
    name: 'attach_document',
    description: 'Adjunta un documento o foto pendiente a un flete. Si no se indica codigo, auto-detecta el flete activo del chofer.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional, auto-detecta flete activo si no se indica)' },
      },
      required: [],
    },
  },
];
