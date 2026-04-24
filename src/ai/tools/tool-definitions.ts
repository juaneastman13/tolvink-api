// =====================================================================
// TOLVINK — AI Tool Definitions (provider-adapted internal schema)
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
    description: 'Busca plantas/acopios por nombre. Prioriza plantas/empresas relacionadas del usuario; si no hay coincidencias, busca en el directorio maestro Tolvink. Devuelve nombre, IDs y sucursales cuando existan. Usar ANTES de crear flete para resolver destino.',
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

  {
    name: 'create_freight_request',
    description: 'Uso principal para productor gerente u operario. Prepara una solicitud de flete del flujo normal y pide confirmacion antes de crearla.',
    input_schema: {
      type: 'object',
      properties: {
        origin: { type: 'string', description: 'Nombre del origen o texto libre si no hay lote/campo exacto' },
        fieldId: { type: 'string', description: 'UUID del campo de origen si ya fue resuelto' },
        lotId: { type: 'string', description: 'UUID del lote de origen si ya fue resuelto' },
        originLotId: { type: 'string', description: 'UUID del lote de origen si ya fue resuelto' },
        customOriginName: { type: 'string', description: 'Nombre de origen personalizado' },
        overrideOriginLat: { type: 'number', description: 'Latitud de origen marcada en mapa' },
        overrideOriginLng: { type: 'number', description: 'Longitud de origen marcada en mapa' },
        destination: { type: 'string', description: 'Nombre del destino o texto libre' },
        destPlantId: { type: 'string', description: 'UUID de planta registrada destino' },
        tolvinkPlantId: { type: 'string', description: 'UUID de planta Tolvink del directorio maestro' },
        destCompanyId: { type: 'string', description: 'UUID de empresa destino si ya fue resuelta' },
        customDestName: { type: 'string', description: 'Nombre de destino personalizado' },
        customDestLat: { type: 'number', description: 'Latitud de destino personalizado' },
        customDestLng: { type: 'number', description: 'Longitud de destino personalizado' },
        overrideDestLat: { type: 'number', description: 'Latitud de destino ajustada en mapa' },
        overrideDestLng: { type: 'number', description: 'Longitud de destino ajustada en mapa' },
        grain: { type: 'string', description: 'Tipo de grano o cultivo' },
        weightKg: { type: 'number', description: 'Peso en kg. 30 toneladas = 30000' },
        loadDate: { type: 'string', description: 'Fecha de carga (YYYY-MM-DD). Opcional: si falta, se usa hoy.' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:MM). Opcional: si falta, se usa la hora actual redondeada.' },
        truckCount: { type: 'number', description: 'Cantidad total de camiones requeridos' },
        useOwnFleet: { type: 'boolean', description: 'true=flota propia, false=delegar a planta/terceros' },
        truckId: { type: 'string', description: 'UUID de camion propio si se asigna al crear' },
        driverId: { type: 'string', description: 'UUID de chofer propio si se asigna al crear' },
        producerCompanyId: { type: 'string', description: 'UUID de empresa productora cuando la planta crea en nombre de productor' },
        originFromLastLocation: { type: 'boolean', description: 'Usar la ultima ubicacion compartida/guardada como origen' },
        destinationFromLastLocation: { type: 'boolean', description: 'Usar la ultima ubicacion compartida/guardada como destino' },
        notes: { type: 'string', description: 'Notas adicionales' },
      },
      required: ['grain', 'weightKg'],
    },
  },

  {
    name: 'request_location_picker',
    description: 'Genera un link a una pagina de mapa para que el usuario indique una ubicacion precisa. Usar siempre que el usuario quiera indicar o avisar una ubicacion y no haya compartido una ubicacion por WhatsApp previamente.',
    input_schema: {
      type: 'object',
      properties: {
        purpose: { type: 'string', enum: ['origin', 'destination', 'current', 'general'], description: 'Para que se usara la ubicacion: origen, destino o ubicacion actual/aviso' },
      },
      required: ['purpose'],
    },
  },

  {
    name: 'update_freight',
    description: 'Edita datos operativos de un flete existente: fecha/hora, notas, cantidad de camiones, flota propia, destino y camion/chofer propio. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        loadDate: { type: 'string', description: 'Nueva fecha de carga (YYYY-MM-DD)' },
        loadTime: { type: 'string', description: 'Nueva hora de carga (HH:MM)' },
        notes: { type: 'string', description: 'Notas nuevas' },
        truckCount: { type: 'number', description: 'Cantidad de camiones necesarios' },
        useOwnFleet: { type: 'boolean', description: 'true=flota propia, false=delegar' },
        destPlantId: { type: 'string', description: 'UUID de planta destino' },
        destination: { type: 'string', description: 'Nombre destino personalizado' },
        customDestName: { type: 'string', description: 'Nombre destino personalizado' },
        customDestLat: { type: 'number', description: 'Latitud destino personalizado' },
        customDestLng: { type: 'number', description: 'Longitud destino personalizado' },
        destinationFromLastLocation: { type: 'boolean', description: 'Usar la ultima ubicacion compartida/guardada como destino' },
        truckId: { type: 'string', description: 'UUID camion propio' },
        driverId: { type: 'string', description: 'UUID chofer propio' },
      },
      required: ['code'],
    },
  },

  {
    name: 'generate_tracking_link',
    description: 'Genera o reutiliza un link compartible publico de seguimiento/detalle para un flete.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        targetCompanyId: { type: 'string', description: 'Empresa destino del link. Opcional; por defecto usa la empresa activa.' },
      },
      required: ['code'],
    },
  },

  {
    name: 'list_freight_assignments',
    description: 'Lista viajes/camiones de un flete multi-camion: assignmentId, numero de viaje, camion, chofer y estado.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Codigo del flete' } },
      required: ['code'],
    },
  },

  {
    name: 'assign_multi_trucks',
    description: 'Asigna uno o varios camiones a un flete. Para multiples camiones usar trucks; para uno solo tambien sirven campos directos. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        trucks: { type: 'array', description: 'Lista de camiones con transportCompanyId, truckId, driverId, plate, tons, isExternal, externalCompanyName, externalDriverName' },
        transportCompanyId: { type: 'string', description: 'UUID empresa transportista' },
        truckId: { type: 'string', description: 'UUID camion' },
        driverId: { type: 'string', description: 'UUID chofer' },
        plate: { type: 'string', description: 'Matricula si camion externo o para referencia' },
        weightKg: { type: 'number', description: 'Peso de este camion en kg' },
        tons: { type: 'number', description: 'Toneladas de este camion' },
        isExternal: { type: 'boolean', description: 'Camion externo no registrado' },
        externalCompanyName: { type: 'string', description: 'Empresa externa' },
        externalDriverName: { type: 'string', description: 'Chofer externo' },
      },
      required: ['code'],
    },
  },

  {
    name: 'add_truck_to_freight',
    description: 'Agrega un camion/viaje adicional a un flete. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        transportCompanyId: { type: 'string', description: 'UUID empresa transportista' },
        truckId: { type: 'string', description: 'UUID camion' },
        driverId: { type: 'string', description: 'UUID chofer' },
        plate: { type: 'string', description: 'Matricula camion externo' },
        weightKg: { type: 'number', description: 'Peso en kg' },
        tons: { type: 'number', description: 'Toneladas' },
        isExternal: { type: 'boolean', description: 'Camion externo' },
        externalCompanyName: { type: 'string', description: 'Empresa externa' },
        externalDriverName: { type: 'string', description: 'Chofer externo' },
      },
      required: ['code'],
    },
  },

  {
    name: 'update_freight_assignment',
    description: 'Edita un viaje/camion asignado por assignmentId o numero de viaje. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion' },
        tripNumber: { type: 'number', description: 'Numero de viaje' },
        transportCompanyId: { type: 'string', description: 'UUID empresa transportista' },
        truckId: { type: 'string', description: 'UUID camion' },
        driverId: { type: 'string', description: 'UUID chofer' },
        plate: { type: 'string', description: 'Matricula camion externo' },
        weightKg: { type: 'number', description: 'Peso en kg' },
        tons: { type: 'number', description: 'Toneladas' },
        externalCompanyName: { type: 'string', description: 'Empresa externa' },
        externalDriverName: { type: 'string', description: 'Chofer externo' },
      },
      required: ['code'],
    },
  },

  {
    name: 'cancel_freight_assignment',
    description: 'Cancela un viaje/camion asignado por assignmentId o numero de viaje. Requiere motivo y confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion' },
        tripNumber: { type: 'number', description: 'Numero de viaje' },
        reason: { type: 'string', description: 'Motivo de cancelacion' },
      },
      required: ['code', 'reason'],
    },
  },

  {
    name: 'respond_trip',
    description: 'Acepta o rechaza un viaje especifico de un flete multi-camion. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion' },
        tripNumber: { type: 'number', description: 'Numero de viaje' },
        action: { type: 'string', enum: ['accepted', 'rejected'], description: 'Accion sobre el viaje' },
        reason: { type: 'string', description: 'Motivo si rechaza' },
        truckId: { type: 'string', description: 'UUID camion si acepta' },
        driverId: { type: 'string', description: 'UUID chofer si acepta' },
      },
      required: ['code', 'action'],
    },
  },

  {
    name: 'list_pending_freight_changes',
    description: 'Lista cambios pendientes de aprobacion/rechazo para un flete.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string', description: 'Codigo del flete' } },
      required: ['code'],
    },
  },

  {
    name: 'approve_pending_freight_change',
    description: 'Aprueba un cambio pendiente de un flete. Si hay un unico cambio pendiente, puede omitirse changeId. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        changeId: { type: 'string', description: 'UUID del cambio pendiente' },
      },
      required: ['code'],
    },
  },

  {
    name: 'reject_pending_freight_change',
    description: 'Rechaza un cambio pendiente de un flete. Si hay un unico cambio pendiente, puede omitirse changeId. Pide confirmacion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        changeId: { type: 'string', description: 'UUID del cambio pendiente' },
        reason: { type: 'string', description: 'Motivo del rechazo' },
      },
      required: ['code'],
    },
  },

  {
    name: 'approve_freight_request',
    description: 'Uso solo para planta gerente u operario. Aprueba un flete de productor que requiere aprobacion de planta.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete a aprobar' },
      },
      required: ['code'],
    },
  },

  {
    name: 'assign_transport_company',
    description: 'Uso solo para planta gerente u operario. Asigna la empresa transportista a un flete. Puede recibir UUID o nombre de la empresa.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        transportCompanyId: { type: 'string', description: 'UUID de la empresa transportista o nombre si aun no se conoce el UUID' },
        transportCompanyName: { type: 'string', description: 'Nombre de la empresa transportista para resolverla por texto' },
        notes: { type: 'string', description: 'Notas internas opcionales' },
      },
      required: ['code'],
    },
  },

  {
    name: 'accept_freight_assignment',
    description: 'Uso principal para transportista gerente. Intenta aceptar una asignacion; si faltan camion o chofer, pedira o resolvera esos datos.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
      },
      required: ['code'],
    },
  },

  {
    name: 'reject_freight_assignment',
    description: 'Uso principal para transportista gerente. Rechaza una asignacion con motivo obligatorio.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        reason: { type: 'string', description: 'Motivo del rechazo' },
        tripNumber: { type: 'number', description: 'Numero de viaje si el flete es multi-camion' },
      },
      required: ['code', 'reason'],
    },
  },

  {
    name: 'assign_driver_and_truck',
    description: 'Uso principal para transportista gerente. Completa la asignacion aceptando operativamente el viaje con chofer y camion.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete' },
        driverId: { type: 'string', description: 'UUID del chofer, si ya se conoce' },
        driverName: { type: 'string', description: 'Nombre del chofer o "yo" si es el propio usuario' },
        truckId: { type: 'string', description: 'UUID del camion, si ya se conoce' },
        plate: { type: 'string', description: 'Matricula del camion para resolverlo por texto' },
        tripNumber: { type: 'number', description: 'Numero de viaje si el flete es multi-camion' },
      },
      required: ['code'],
    },
  },

  {
    name: 'start_freight_trip',
    description: 'Uso principal para chofer operativo. Inicia su viaje activo o el flete indicado.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional si solo hay uno elegible)' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion si es multi-camion' },
        tripNumber: { type: 'number', description: 'Numero de viaje si es multi-camion' },
      },
      required: [],
    },
  },

  {
    name: 'confirm_freight_loaded',
    description: 'Uso principal para chofer operativo. Confirma que la carga ya esta hecha.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional si solo hay uno elegible)' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion si es multi-camion' },
        tripNumber: { type: 'number', description: 'Numero de viaje si es multi-camion' },
        weightKg: { type: 'number', description: 'Peso cargado en kg, opcional' },
      },
      required: [],
    },
  },

  {
    name: 'confirm_freight_arrival',
    description: 'Uso principal para chofer. Registra llegada si el flujo lo soporta; para otros casos puede orientar al siguiente paso.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional si solo hay uno elegible)' },
      },
      required: [],
    },
  },

  {
    name: 'finish_freight',
    description: 'Uso principal para chofer operativo. Finaliza el viaje activo o el flete indicado.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Codigo del flete (opcional si solo hay uno elegible)' },
        assignmentId: { type: 'string', description: 'UUID del viaje/asignacion si es multi-camion' },
        tripNumber: { type: 'number', description: 'Numero de viaje si es multi-camion' },
        destinationWeightKg: { type: 'number', description: 'Peso neto en destino en kg, opcional' },
      },
      required: [],
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
        originFromLastLocation: { type: 'boolean', description: 'Usar la ultima ubicacion compartida/guardada como origen' },
        destinationFromLastLocation: { type: 'boolean', description: 'Usar la ultima ubicacion compartida/guardada como destino' },
        grain: { type: 'string', description: 'Tipo de grano (soja, maiz, trigo, etc.)' },
        weightKg: { type: 'number', description: 'Peso en kilogramos (30 toneladas = 30000)' },
        fieldId: { type: 'string', description: 'UUID del campo de origen (de search_fields)' },
        originLotId: { type: 'string', description: 'UUID del lote de origen (de search_lots)' },
        destPlantId: { type: 'string', description: 'UUID de planta/empresa registrada destino (de search_plants)' },
        tolvinkPlantId: { type: 'string', description: 'UUID de planta del directorio maestro Tolvink (de search_plants)' },
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
