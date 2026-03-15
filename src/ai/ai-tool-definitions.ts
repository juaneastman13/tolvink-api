// =====================================================================
// TOLVINK — AI Tool Definitions
// Anthropic tool schemas for the WhatsApp conversational agent
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

export const AI_TOOL_DEFINITIONS: AiToolDefinition[] = [
  // ======================== CONSULTAS DE FLETES ========================
  {
    name: 'list_freights',
    description: 'Lista fletes del usuario como menú interactivo de WhatsApp. Usar SOLO para que el usuario seleccione un flete individual. Para resúmenes/análisis/conteos usar summarize_freights. Retorna _selectionSent:true — NO repetir los ítems en el mensaje.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
          description: 'Filtrar por estado. Valores: pending_assignment, assigned, accepted, in_progress, loaded, finished, canceled.',
        },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD).' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD).' },
        grain: { type: 'string', description: 'Filtrar por grano. Valores: Soja, Maiz, Trigo, Girasol, Sorgo, Cebada, Otros.' },
      },
      required: [],
    },
  },
  {
    name: 'get_freight_detail',
    description: 'Detalle completo de un flete por código (ej: F26-LCP.1822). Incluye estado, grano, toneladas, origen, destino, transportista, camión, chofer, historial de cambios y mapLink. Usar mapLink para mostrar ubicación — nunca coordenadas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código completo del flete (ej: F26-LCP.1822). NUNCA truncar.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'summarize_freights',
    description: 'Resumen analítico de fletes con datos completos para agrupar, contar o analizar. NO muestra menú interactivo — retorna datos en texto. Usar para: "resumen", "cuántos fletes", "estadísticas", "agrupados por". Para selección individual usar list_freights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
          description: 'Filtrar por estado.',
        },
        groupBy: {
          type: 'string',
          enum: ['transporter', 'status', 'grain', 'destination', 'origin'],
          description: 'Agrupar resultados por este criterio.',
        },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD).' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD).' },
        grain: { type: 'string', description: 'Filtrar por grano. Valores: Soja, Maiz, Trigo, Girasol, Sorgo, Cebada, Otros.' },
        transporterName: { type: 'string', description: 'Filtrar por nombre de transportista (parcial, fuzzy).' },
      },
      required: [],
    },
  },
  {
    name: 'get_dashboard',
    description: 'Resumen ejecutivo de la empresa: fletes por estado, toneladas del mes, completados vs cancelados. Usar ante consultas vagas como "cómo estamos", "novedades", "resumen general".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'freight_history',
    description: 'Historial completo de un flete: quién hizo qué y cuándo (creación, asignaciones, cambios de estado). Retorna texto.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete (ej: F26-LCP.1822).' },
      },
      required: ['code'],
    },
  },

  // ======================== CREACIÓN DE FLETES ========================
  {
    name: 'prepare_freight',
    description: 'Prepara un flete para creación (NO lo crea). Devuelve resumen para confirmar con confirm_create_freight. Auto-resuelve nombres: destName busca entre plantas habilitadas, originName busca entre campos/lotes. Si planta tiene sucursales, pide seleccionar. Si flota propia, pide camión y chofer (auto-selecciona si hay uno solo). NOTA: los campos/lotes/plantas del usuario ya están en el contexto pre-cargado — usar esa info para pasar nombres directamente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        grain: {
          type: 'string',
          enum: ['Soja', 'Maíz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'],
          description: 'Tipo de grano. DEBE ser uno de: Soja, Maíz, Trigo, Girasol, Sorgo, Cebada, Otros.',
        },
        tons: { type: 'number', description: 'Toneladas a transportar. Debe ser > 0.' },
        truckCount: { type: 'number', description: 'Cantidad de camiones. OBLIGATORIO. Preguntar al usuario si no lo indicó.' },
        loadDate: { type: 'string', description: 'Fecha de carga (YYYY-MM-DD). Debe ser hoy o futura.' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:mm). Ej: "08:00".' },
        useOwnFleet: { type: 'boolean', description: 'OBLIGATORIO. true = flota propia (sistema pide camión + chofer). false = planta asigna transporte.' },
        destPlantId: { type: 'string', description: 'UUID de planta destino. Usar si ya tenés el ID.' },
        destName: { type: 'string', description: 'Nombre de planta. Se auto-resuelve con fuzzy search contra plantas habilitadas.' },
        branchId: { type: 'string', description: 'UUID de sucursal. OBLIGATORIO si la planta tiene sucursales (el sistema lo valida y muestra lista).' },
        customDestLat: { type: 'number', description: 'Latitud destino custom (requiere generate_location_link previo).' },
        customDestLng: { type: 'number', description: 'Longitud destino custom.' },
        originLotId: { type: 'string', description: 'UUID de lote origen. Usar si ya tenés el ID.' },
        originName: { type: 'string', description: 'Nombre de campo o lote. Se auto-resuelve contra campos/lotes del productor.' },
        customOriginName: { type: 'string', description: 'Nombre origen personalizado (si no hay lote/campo registrado).' },
        customOriginLat: { type: 'number', description: 'Latitud origen custom (requiere generate_location_link previo).' },
        customOriginLng: { type: 'number', description: 'Longitud origen custom.' },
        truckId: { type: 'string', description: 'UUID de camión (solo con useOwnFleet=true). Se auto-selecciona si hay uno solo.' },
        driverId: { type: 'string', description: 'UUID del chofer o "self" para el usuario actual. OBLIGATORIO si truckId indicado.' },
        notes: { type: 'string', description: 'Notas adicionales.' },
      },
      required: ['grain', 'tons', 'loadDate', 'loadTime', 'truckCount', 'useOwnFleet'],
    },
  },
  {
    name: 'confirm_create_freight',
    description: 'Crea el flete preparado con prepare_freight. Llamar SOLO cuando el usuario confirma ("sí", "dale", "confirmar"). Sin esta llamada el flete NO se crea.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'duplicate_freight',
    description: 'Duplica un flete existente con nueva fecha. Copia grano, toneladas, origen, destino y notas. NO pedir reconfirmar datos — solo la fecha nueva.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete original (ej: F26-LCP.1822).' },
        loadDate: { type: 'string', description: 'Fecha de carga para el nuevo flete (YYYY-MM-DD). Debe ser hoy o futura.' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:mm). Si no se indica, se copia del original.' },
      },
      required: ['code', 'loadDate'],
    },
  },
  {
    name: 'update_freight',
    description: 'Modifica un flete existente: fecha, hora, notas, planta destino, camión, chofer, cantidad de camiones, flota propia. Algunos cambios pueden requerir aprobación de la otra parte. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete (ej: F26-LCP.1822).' },
        loadDate: { type: 'string', description: 'Nueva fecha de carga (YYYY-MM-DD).' },
        loadTime: { type: 'string', description: 'Nueva hora de carga (HH:mm).' },
        notes: { type: 'string', description: 'Nuevas notas.' },
        useOwnFleet: { type: 'boolean', description: 'Cambiar a flota propia (true) o delegado (false).' },
        destPlantId: { type: 'string', description: 'UUID de nueva planta destino (de search_plants).' },
        truckId: { type: 'string', description: 'UUID de camión propio (de list_trucks).' },
        driverId: { type: 'string', description: 'UUID del chofer o "self".' },
        truckCount: { type: 'number', description: 'Nueva cantidad de camiones. Debe ser >= camiones ya asignados.' },
      },
      required: ['code'],
    },
  },

  // ======================== CONFIRMACIÓN GENÉRICA ========================
  {
    name: 'confirm_action',
    description: 'Ejecuta una acción previamente preparada cuando el usuario confirma ("sí", "dale", "confirmar"). Sin esta llamada la acción NO se ejecuta. NO usar para crear fletes — esos usan confirm_create_freight.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // ======================== ACCIONES DE FLETE ========================
  {
    name: 'accept_freight',
    description: 'Acepta un flete asignado al transportista/chofer. Solo estado "assigned". Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'reject_freight',
    description: 'Rechaza un flete asignado. Requiere motivo. Solo estado "assigned". Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        reason: { type: 'string', description: 'Motivo del rechazo.' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'start_freight',
    description: 'Inicia el viaje de un flete aceptado. Cambia a "en camino". Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'confirm_loaded',
    description: 'Confirma carga de un flete. Requiere toneladas reales cargadas. Carga requiere confirmación de AMBAS partes (productor + transportista). Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        tons: { type: 'number', description: 'Toneladas reales cargadas (> 0).' },
      },
      required: ['code', 'tons'],
    },
  },
  {
    name: 'confirm_finished',
    description: 'Confirma entrega/recepción de un flete. Entrega requiere confirmación de AMBAS partes (transportista + planta). Si solo una confirmó, informar que falta la otra. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'cancel_freight',
    description: 'Cancela un flete. No se puede cancelar si está en camino o cargado. Requiere motivo. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        reason: { type: 'string', description: 'Motivo de cancelación.' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'authorize_freight',
    description: 'Autoriza un flete con flota propia. Solo plantas. Solo estado "assigned". El flujo es: asignado → planta autoriza → aceptado. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },

  // ======================== VIAJES MULTI-CAMIÓN ========================
  {
    name: 'respond_trip',
    description: 'Acepta o rechaza un viaje específico en un flete multi-camión. Si hay un solo viaje, assignmentId es opcional.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
        action: { type: 'string', enum: ['accepted', 'rejected'], description: '"accepted" o "rejected".' },
        reason: { type: 'string', description: 'Motivo. Obligatorio si action="rejected".' },
      },
      required: ['code', 'action'],
    },
  },
  {
    name: 'start_trip',
    description: 'Inicia un viaje específico de un flete multi-camión. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_loaded',
    description: 'Confirma carga de un viaje específico. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
        loadedTons: { type: 'number', description: 'Toneladas reales cargadas en este viaje.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_finished',
    description: 'Confirma entrega de un viaje específico. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
      },
      required: ['code'],
    },
  },

  // ======================== ASIGNACIÓN DE TRANSPORTE ========================
  {
    name: 'list_transporters',
    description: 'Lista transportistas disponibles como menú interactivo. Para plantas y productores con flota interna. Puede filtrar por nombre con fuzzy search. Retorna _selectionSent:true — NO repetir ítems.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filtrar por nombre de transportista (fuzzy, opcional).' },
      },
      required: [],
    },
  },
  {
    name: 'assign_transporter',
    description: 'Asigna transportista a un flete. Usar transporterCompanyId="own_fleet" para flota propia del productor. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        transporterCompanyId: { type: 'string', description: 'UUID de empresa transportista, o "own_fleet" para flota propia.' },
        truckId: { type: 'string', description: 'UUID del camión (opcional).' },
        driverId: { type: 'string', description: 'UUID del chofer (opcional).' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  {
    name: 'assign_truck_to_trip',
    description: 'Asigna o cambia camión en un viaje existente. Solo plantas. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        truckId: { type: 'string', description: 'UUID del camión.' },
        driverId: { type: 'string', description: 'UUID del chofer (opcional).' },
      },
      required: ['code', 'truckId'],
    },
  },
  {
    name: 'assign_truck_to_freight',
    description: 'Asigna camión adicional a un flete multi-camión con viajes sin asignar. "own_fleet" para flota propia. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        transporterCompanyId: { type: 'string', description: 'UUID empresa o "own_fleet".' },
        truckId: { type: 'string', description: 'UUID del camión (opcional).' },
        driverId: { type: 'string', description: 'UUID del chofer (opcional).' },
        tons: { type: 'number', description: 'Toneladas para este viaje (opcional).' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  {
    name: 'assign_multi_trucks',
    description: 'Asigna múltiples camiones a un flete de una vez. Solo plantas. Cada camión necesita transporterCompanyId. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        trucks: {
          type: 'array',
          description: 'Lista de camiones a asignar.',
          items: {
            type: 'object',
            properties: {
              transportCompanyId: { type: 'string', description: 'UUID empresa transportista.' },
              truckId: { type: 'string', description: 'UUID del camión (opcional).' },
              driverId: { type: 'string', description: 'UUID del chofer (opcional).' },
              tons: { type: 'number', description: 'Toneladas (opcional).' },
            },
            required: ['transportCompanyId'],
          },
        },
      },
      required: ['code', 'trucks'],
    },
  },
  {
    name: 'cancel_assignment',
    description: 'Cancela una asignación de camión en un flete. Solo plantas. Requiere motivo. Para quitar camiones: primero cancel_assignment, luego update_freight(truckCount=nuevo). Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
        reason: { type: 'string', description: 'Motivo de la cancelación.' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'update_assignment',
    description: 'Edita una asignación existente (transportista, camión, chofer, toneladas). Solo plantas. Solo viajes pendientes o aceptados. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        assignmentId: { type: 'string', description: 'UUID de la asignación (opcional si hay un solo viaje).' },
        transporterCompanyId: { type: 'string', description: 'Nuevo transportista UUID.' },
        truckId: { type: 'string', description: 'Nuevo camión UUID.' },
        driverId: { type: 'string', description: 'Nuevo chofer UUID.' },
        tons: { type: 'number', description: 'Nuevas toneladas.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'approve_pending_change',
    description: 'Aprueba un cambio pendiente en un flete (ej: cambio de destino o flota). Solo la empresa aprobadora. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        changeId: { type: 'string', description: 'UUID del cambio (opcional, se usa el primero si no se indica).' },
      },
      required: ['code'],
    },
  },
  {
    name: 'reject_pending_change',
    description: 'Rechaza un cambio pendiente en un flete. Solo la empresa aprobadora. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        changeId: { type: 'string', description: 'UUID del cambio (opcional).' },
        reason: { type: 'string', description: 'Motivo del rechazo.' },
      },
      required: ['code'],
    },
  },

  // ======================== CAMPOS Y LOTES ========================
  {
    name: 'search_plants',
    description: 'Busca plantas/empresas destino por nombre (fuzzy). También busca por nombre de sucursal. Menú interactivo si hay múltiples. Retorna _selectionSent:true. NOTA: las plantas habilitadas del usuario ya están en el contexto pre-cargado — usar esta tool solo si necesitás datos actualizados o buscar por nombre específico.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial de planta o sucursal. Usa fuzzy search con normalización fonética rioplatense.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_fields',
    description: 'Lista campos del productor como menú interactivo. Retorna _selectionSent:true — NO repetir ítems. NOTA: la cantidad de campos ya está en el contexto pre-cargado.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'list_lots',
    description: 'Lista lotes del productor como menú interactivo seleccionable. Puede filtrar por campo. Retorna _selectionSent:true — NO repetir ítems. Usar SIEMPRE que el usuario deba elegir un lote.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldId: { type: 'string', description: 'UUID de campo para filtrar (opcional). Si se omite, muestra todos los lotes.' },
      },
      required: [],
    },
  },
  {
    name: 'search_fields',
    description: 'Busca campos del productor por nombre (fuzzy). Retorna campos que matchean. Usar cuando el usuario menciona un campo por nombre parcial.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial del campo (fuzzy).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_lots',
    description: 'Busca lotes del productor por nombre (fuzzy). Puede filtrar por campo. Retorna lotes que matchean. Usar cuando el usuario menciona un lote por nombre parcial.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial del lote (fuzzy).' },
        fieldId: { type: 'string', description: 'UUID de campo para limitar búsqueda (opcional).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_profile',
    description: 'Retorna datos del perfil del usuario actual: nombre, email, teléfono, rol, empresa activa. Usar cuando pregunta "quién soy", "mis datos", "mi perfil".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_field',
    description: 'Crea un campo (establecimiento agrícola). Si el usuario marcó ubicación con generate_location_link, se usa automáticamente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre del campo.' },
        address: { type: 'string', description: 'Dirección (opcional).' },
        lat: { type: 'number', description: 'Latitud (opcional, se usa ubicación compartida).' },
        lng: { type: 'number', description: 'Longitud (opcional).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_lot',
    description: 'Crea un lote dentro de un campo. Usar list_fields para obtener fieldId si no lo tenés. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldId: { type: 'string', description: 'UUID del campo (de list_fields).' },
        name: { type: 'string', description: 'Nombre del lote.' },
        hectares: { type: 'number', description: 'Hectáreas (opcional).' },
        lat: { type: 'number', description: 'Latitud (opcional).' },
        lng: { type: 'number', description: 'Longitud (opcional).' },
      },
      required: ['fieldId', 'name'],
    },
  },
  {
    name: 'update_field',
    description: 'Modifica un campo existente (dirección, ubicación). Busca por nombre. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldName: { type: 'string', description: 'Nombre del campo a modificar.' },
        address: { type: 'string', description: 'Nueva dirección.' },
        lat: { type: 'number', description: 'Nueva latitud.' },
        lng: { type: 'number', description: 'Nueva longitud.' },
      },
      required: ['fieldName'],
    },
  },
  {
    name: 'update_lot',
    description: 'Modifica un lote existente (hectáreas, ubicación). Busca por nombre. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lotName: { type: 'string', description: 'Nombre del lote a modificar.' },
        hectares: { type: 'number', description: 'Nuevas hectáreas.' },
        lat: { type: 'number', description: 'Nueva latitud.' },
        lng: { type: 'number', description: 'Nueva longitud.' },
      },
      required: ['lotName'],
    },
  },

  // ======================== CAMIONES Y CHOFERES ========================
  {
    name: 'list_trucks',
    description: 'Lista camiones de la empresa como menú interactivo. Retorna _selectionSent:true. NOTA: la cantidad de camiones ya está en el contexto pre-cargado si la empresa tiene flota propia.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_truck',
    description: 'Registra un camión en la flota. Patente obligatoria. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plate: { type: 'string', description: 'Patente/matrícula (ej: ABC1234). Se normaliza a mayúsculas.' },
        model: { type: 'string', description: 'Modelo (opcional).' },
      },
      required: ['plate'],
    },
  },
  {
    name: 'update_truck',
    description: 'Edita datos de un camión (patente, marca, modelo, capacidad). Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'UUID del camión (de list_trucks).' },
        plate: { type: 'string', description: 'Nueva patente.' },
        brand: { type: 'string', description: 'Marca.' },
        model: { type: 'string', description: 'Modelo.' },
        capacity: { type: 'number', description: 'Capacidad en toneladas.' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'deactivate_truck',
    description: 'Desactiva un camión. No se puede si tiene viajes activos. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'UUID del camión (de list_trucks).' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'list_drivers',
    description: 'Lista choferes de la empresa como menú interactivo. Retorna _selectionSent:true.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_driver',
    description: 'Registra un nuevo chofer. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo del chofer.' },
        phone: { type: 'string', description: 'Teléfono (09XXXXXXX, opcional).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deactivate_driver',
    description: 'Desactiva un chofer. No se puede si tiene viajes activos. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer (de list_drivers).' },
      },
      required: ['driverId'],
    },
  },
  {
    name: 'view_driver_queue',
    description: 'Cola de fletes asignados a un chofer, en orden de prioridad.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer (de list_drivers).' },
      },
      required: ['driverId'],
    },
  },
  {
    name: 'reorder_driver_queue',
    description: 'Reordena la cola de fletes de un chofer. Solo plantas/admin. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer.' },
        orderedFreightIds: {
          type: 'array',
          description: 'UUIDs de fletes en el orden deseado.',
          items: { type: 'string' },
        },
      },
      required: ['driverId', 'orderedFreightIds'],
    },
  },

  // ======================== DOCUMENTOS ========================
  {
    name: 'attach_document',
    description: 'Adjunta imagen/documento pendiente (enviado previamente por WhatsApp) a un flete. Usar DIRECTO con código — NO buscar con list_freights primero. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        step: {
          type: 'string',
          enum: ['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'],
          description: 'Etapa del documento (opcional).',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'list_documents',
    description: 'Lista documentos adjuntos de un flete (fotos, remitos, etc). Retorna texto, NO menú.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'delete_document',
    description: 'Elimina un documento de un flete. Requiere documentId (de list_documents). Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        documentId: { type: 'string', description: 'UUID del documento (de list_documents).' },
      },
      required: ['code', 'documentId'],
    },
  },
  {
    name: 'ocr_analyze',
    description: 'Analiza imagen de documento (remito, ticket de pesaje) y extrae datos con OCR. Usar cuando el usuario envía foto de un documento y quiere extraer info.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL pública de la imagen en storage.' },
        docType: {
          type: 'string',
          enum: ['carta_porte', 'remito', 'pesaje', 'general'],
          description: 'Tipo de documento. Usar "general" si no se sabe.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'save_ocr_data',
    description: 'Guarda datos OCR extraídos en un documento de flete. Usar después de ocr_analyze cuando el usuario confirma. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete.' },
        documentId: { type: 'string', description: 'UUID del documento.' },
        ocrData: { type: 'object', description: 'Datos OCR estructurados (de ocr_analyze).' },
      },
      required: ['code', 'documentId', 'ocrData'],
    },
  },

  // ======================== UBICACIONES Y MAPAS ========================
  {
    name: 'generate_location_link',
    description: 'Genera link para que el usuario elija ubicación en el mapa Tolvink. Usar para: origen/destino personalizado, campo, lote. Las coordenadas se guardan automáticamente en la sesión.',
    input_schema: {
      type: 'object' as const,
      properties: {
        purpose: {
          type: 'string',
          enum: ['origin', 'destination', 'field', 'lot'],
          description: 'Para qué es la ubicación.',
        },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'generate_tracking_link',
    description: 'Link público para rastrear flete en vivo en mapa. Muestra ruta y posición del camión. Solo fletes activos.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'generate_map_link',
    description: 'Link para ver ubicación en mapa Tolvink. Acepta 1 o 2 puntos (origen + destino). NUNCA devolver coordenadas — siempre usar esta herramienta.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lat: { type: 'number', description: 'Latitud del punto principal.' },
        lng: { type: 'number', description: 'Longitud del punto principal.' },
        name: { type: 'string', description: 'Nombre del lugar.' },
        destLat: { type: 'number', description: 'Latitud destino (opcional, para ruta).' },
        destLng: { type: 'number', description: 'Longitud destino (opcional).' },
        destName: { type: 'string', description: 'Nombre destino (opcional).' },
      },
      required: ['lat', 'lng', 'name'],
    },
  },
  {
    name: 'generate_report_link',
    description: 'Link público para descargar PDF de un flete. Incluye info completa, recorrido, historial, documentos. Funciona para cualquier flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'generate_daily_map_link',
    description: 'Link con mapa interactivo de todos los fletes del día. Marcadores por estado. Usar para "panorama general" o "mapa del día".',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'generate_batch_report_link',
    description: 'Link a pantalla de reportes web con filtros pre-aplicados. El usuario descarga PDF o Excel desde ahí.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filtro: all, solicitado, en_curso, finalizados, cancelados.' },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD).' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD).' },
      },
      required: [],
    },
  },
  {
    name: 'share_live_location',
    description: 'Link para compartir ubicación en vivo en el mapa de un flete. Participantes ven la posición del usuario.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'view_live_locations',
    description: 'Link para ver ubicaciones en vivo de todos los participantes de un flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },
  {
    name: 'request_location',
    description: 'Envía mensaje WhatsApp a participantes del flete pidiéndoles compartir ubicación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete.' } },
      required: ['code'],
    },
  },

  // ======================== GESTIÓN DE USUARIOS ========================
  {
    name: 'list_company_users',
    description: 'Lista usuarios de la empresa como menú interactivo. Solo admin/gerente. Retorna _selectionSent:true.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_user',
    description: 'Crea usuario en la empresa. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo.' },
        email: { type: 'string', description: 'Email del usuario.' },
        phone: { type: 'string', description: 'Teléfono (opcional).' },
        role: {
          type: 'string',
          enum: ['admin', 'gerente', 'operario', 'chofer'],
          description: 'Rol. Valores: admin, gerente, operario (default), chofer.',
        },
      },
      required: ['name', 'email'],
    },
  },
  {
    name: 'update_user_role',
    description: 'Cambia rol de un usuario. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        userIdentifier: { type: 'string', description: 'Nombre o email del usuario.' },
        newRole: {
          type: 'string',
          enum: ['gerente', 'operario', 'chofer'],
          description: 'Nuevo rol. Valores: gerente, operario, chofer.',
        },
      },
      required: ['userIdentifier', 'newRole'],
    },
  },
  {
    name: 'deactivate_user',
    description: 'Desactiva un usuario de la empresa. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email del usuario.' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'reactivate_user',
    description: 'Reactiva un usuario desactivado. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email del usuario.' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'update_user_admin',
    description: 'Edita un usuario (nombre, email, teléfono, rol, estado). Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'UUID del usuario (de list_company_users).' },
        name: { type: 'string', description: 'Nuevo nombre.' },
        email: { type: 'string', description: 'Nuevo email.' },
        phone: { type: 'string', description: 'Nuevo teléfono.' },
        role: { type: 'string', enum: ['admin', 'operario', 'chofer'], description: 'Nuevo rol.' },
        active: { type: 'boolean', description: 'Activar/desactivar.' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'update_profile',
    description: 'Modifica perfil del usuario actual (nombre, email, teléfono). Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre.' },
        email: { type: 'string', description: 'Nuevo email.' },
        phone: { type: 'string', description: 'Nuevo teléfono (09XXXXXXX).' },
      },
      required: [],
    },
  },

  // ======================== EMPRESA ========================
  {
    name: 'switch_company',
    description: 'Cambia empresa activa. Sin companyId: lista empresas disponibles. Con companyId: ejecuta cambio. Usar solo cuando el usuario lo pide explícitamente.',
    input_schema: {
      type: 'object' as const,
      properties: { companyId: { type: 'string', description: 'UUID de empresa destino (opcional).' } },
      required: [],
    },
  },
  {
    name: 'update_company',
    description: 'Edita datos de empresa activa (nombre, dirección, teléfono, email, ubicación). Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre.' },
        address: { type: 'string', description: 'Nueva dirección.' },
        phone: { type: 'string', description: 'Nuevo teléfono.' },
        email: { type: 'string', description: 'Nuevo email.' },
        lat: { type: 'number', description: 'Nueva latitud.' },
        lng: { type: 'number', description: 'Nueva longitud.' },
      },
      required: [],
    },
  },

  // ======================== ACCESO PLANTA-PRODUCTOR ========================
  {
    name: 'list_enabled_plants',
    description: 'Lista plantas habilitadas para el productor. Muestra qué plantas puede usar como destino. NOTA: esta info ya está en el contexto pre-cargado — usar solo si necesitás datos actualizados.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'list_enabled_producers',
    description: 'Lista productores habilitados en la planta. Solo plantas.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'grant_producer_access',
    description: 'Habilita un productor para operar con la planta. Solo plantas/admin. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        producerCompanyId: { type: 'string', description: 'UUID de empresa productora.' },
        producerUserId: { type: 'string', description: 'UUID de usuario productor (opcional, habilita toda la empresa si no se indica).' },
      },
      required: ['producerCompanyId'],
    },
  },
  {
    name: 'revoke_producer_access',
    description: 'Revoca acceso de productor a la planta. Solo plantas/admin. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        accessId: { type: 'string', description: 'UUID del registro de acceso (de list_enabled_producers).' },
      },
      required: ['accessId'],
    },
  },

  // ======================== SUCURSALES ========================
  {
    name: 'list_branches',
    description: 'Lista sucursales de la empresa activa.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_branch',
    description: 'Crea sucursal para la empresa. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre de la sucursal.' },
        address: { type: 'string', description: 'Dirección (opcional).' },
        reference: { type: 'string', description: 'Referencia (ej: "Ruta 2 km 135", opcional).' },
        lat: { type: 'number', description: 'Latitud (opcional, usar generate_location_link).' },
        lng: { type: 'number', description: 'Longitud (opcional).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_branch',
    description: 'Edita sucursal existente. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'UUID de la sucursal (de list_branches).' },
        name: { type: 'string', description: 'Nuevo nombre.' },
        address: { type: 'string', description: 'Nueva dirección.' },
        reference: { type: 'string', description: 'Nueva referencia.' },
        lat: { type: 'number', description: 'Nueva latitud.' },
        lng: { type: 'number', description: 'Nueva longitud.' },
      },
      required: ['branchId'],
    },
  },
  {
    name: 'delete_branch',
    description: 'Desactiva una sucursal. Solo admin/gerente. Prepara para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'UUID de la sucursal.' },
      },
      required: ['branchId'],
    },
  },

  // ======================== NAVEGACIÓN WEB ========================
  {
    name: 'navigate_app',
    description: 'Navega al usuario a una pantalla de la app web. Solo canal web. Usar ADEMÁS de la respuesta informativa cuando la acción tiene sentido visual.',
    input_schema: {
      type: 'object' as const,
      properties: {
        screen: {
          type: 'string',
          enum: ['home', 'list', 'new', 'detail', 'calendar', 'reports', 'fields', 'trucks', 'menu', 'chats'],
          description: 'Pantalla destino.',
        },
        freightId: { type: 'string', description: 'UUID del flete (solo para screen="detail").' },
      },
      required: ['screen'],
    },
  },
  {
    name: 'get_assignment_suggestions',
    description: 'Obtiene sugerencias rankeadas de transporte para asignar un flete. Usar cuando el usuario pide asignar sin especificar transportista, pregunta quién puede hacer un flete, o pide recomendaciones de transporte.',
    input_schema: {
      type: 'object' as const,
      properties: {
        freightId: { type: 'string', description: 'ID del flete' },
      },
      required: ['freightId'],
    },
  },
];
