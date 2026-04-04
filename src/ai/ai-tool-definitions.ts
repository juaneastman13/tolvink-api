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
    description: 'Lista fletes como menú interactivo para selección individual. Para resumen/conteo usar summarize_freights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
          description: 'Filtrar por estado',
        },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD)' },
        grain: { type: 'string', description: 'Filtrar por grano' },
      },
      required: [],
    },
  },
  {
    name: 'get_freight_detail',
    description: 'Detalle de flete por código. Incluye estado, datos, asignaciones, historial y mapLink.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
      },
      required: ['code'],
    },
  },
  {
    name: 'summarize_freights',
    description: 'Resumen analítico de fletes en texto para agrupar, contar o analizar. Para selección individual usar list_freights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
          description: 'Filtrar por estado',
        },
        groupBy: {
          type: 'string',
          enum: ['transporter', 'status', 'grain', 'destination', 'origin'],
          description: 'Agrupar por criterio',
        },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD)' },
        grain: { type: 'string', description: 'Filtrar por grano' },
        transporterName: { type: 'string', description: 'Filtrar por transportista (fuzzy)' },
      },
      required: [],
    },
  },
  {
    name: 'get_dashboard',
    description: 'Resumen ejecutivo: fletes por estado, toneladas del mes, completados vs cancelados.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'freight_history',
    description: 'Historial de un flete: quién hizo qué y cuándo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
      },
      required: ['code'],
    },
  },

  // ======================== CREACIÓN DE FLETES ========================
  {
    name: 'prepare_freight',
    description: 'Prepara flete (no lo crea). Auto-resuelve destName→planta, originName→campo/lote. Confirmar con confirm_create_freight.',
    input_schema: {
      type: 'object' as const,
      properties: {
        grain: {
          type: 'string',
          enum: ['Soja', 'Maíz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'],
          description: 'Tipo de grano',
        },
        tons: { type: 'number', description: 'Toneladas (opcional, no preguntar si no las dio)' },
        truckCount: { type: 'number', description: 'Cantidad de camiones. OBLIGATORIO — preguntar si no lo indicó.' },
        loadDate: { type: 'string', description: 'Fecha de carga (YYYY-MM-DD), hoy o futura' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:mm)' },
        useOwnFleet: { type: 'boolean', description: 'true=flota propia (pide camión+chofer), false=planta asigna' },
        destPlantId: { type: 'string', description: 'UUID planta destino' },
        destName: { type: 'string', description: 'Nombre planta, auto-resuelve con fuzzy' },
        branchId: { type: 'string', description: 'UUID sucursal, obligatorio si planta tiene sucursales' },
        customDestLat: { type: 'number', description: 'Latitud destino custom' },
        customDestLng: { type: 'number', description: 'Longitud destino custom' },
        originLotId: { type: 'string', description: 'UUID lote origen' },
        originName: { type: 'string', description: 'Nombre campo/lote, auto-resuelve' },
        customOriginName: { type: 'string', description: 'Nombre origen personalizado' },
        customOriginLat: { type: 'number', description: 'Latitud origen custom' },
        customOriginLng: { type: 'number', description: 'Longitud origen custom' },
        truckId: { type: 'string', description: 'UUID camión (solo useOwnFleet=true)' },
        driverId: { type: 'string', description: 'UUID chofer o "self"' },
        notes: { type: 'string', description: 'Notas adicionales' },
      },
      required: ['grain', 'loadDate', 'truckCount'],
    },
  },
  {
    name: 'confirm_create_freight',
    description: 'Crea el flete preparado. Llamar solo cuando el usuario confirma.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'duplicate_freight',
    description: 'Duplica flete existente con nueva fecha. Copia grano, toneladas, origen, destino, notas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete original' },
        loadDate: { type: 'string', description: 'Fecha de carga (YYYY-MM-DD), hoy o futura' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:mm), copia del original si omitido' },
      },
      required: ['code', 'loadDate'],
    },
  },
  {
    name: 'update_freight',
    description: 'Modifica flete: fecha, hora, notas, destino, camión, chofer, truckCount, flota propia. Algunos cambios requieren aprobación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        loadDate: { type: 'string', description: 'Nueva fecha (YYYY-MM-DD)' },
        loadTime: { type: 'string', description: 'Nueva hora (HH:mm)' },
        notes: { type: 'string', description: 'Nuevas notas' },
        useOwnFleet: { type: 'boolean', description: 'Cambiar a flota propia (true) o delegado (false)' },
        destPlantId: { type: 'string', description: 'UUID nueva planta destino' },
        truckId: { type: 'string', description: 'UUID camión propio' },
        driverId: { type: 'string', description: 'UUID chofer o "self"' },
        truckCount: { type: 'number', description: 'Nueva cantidad de camiones (>= ya asignados)' },
      },
      required: ['code'],
    },
  },

  // ======================== CONFIRMACIÓN GENÉRICA ========================
  {
    name: 'confirm_action',
    description: 'Ejecuta acción previamente preparada cuando el usuario confirma. NO usar para crear fletes (usar confirm_create_freight).',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // ======================== ACCIONES DE FLETE ========================
  {
    name: 'accept_freight',
    description: 'Acepta flete asignado. Solo estado "assigned".',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'reject_freight',
    description: 'Rechaza flete asignado. Requiere motivo. Solo estado "assigned".',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        reason: { type: 'string', description: 'Motivo del rechazo' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'start_freight',
    description: 'Inicia viaje de flete aceptado. Cambia a "a campo".',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'confirm_loaded',
    description: 'Confirma carga. Requiere toneladas reales. AMBAS partes (productor+transportista) deben confirmar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        tons: { type: 'number', description: 'Toneladas reales cargadas (> 0)' },
      },
      required: ['code', 'tons'],
    },
  },
  {
    name: 'confirm_finished',
    description: 'Confirma entrega/recepción. AMBAS partes (transportista+planta) deben confirmar.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'cancel_freight',
    description: 'Cancela flete. No se puede si está a campo o a planta. Requiere motivo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        reason: { type: 'string', description: 'Motivo de cancelación' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'authorize_freight',
    description: 'Autoriza flete con flota propia. Solo plantas, solo estado "assigned".',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },

  // ======================== VIAJES MULTI-CAMIÓN ========================
  {
    name: 'respond_trip',
    description: 'Acepta o rechaza viaje en flete multi-camión.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
        action: { type: 'string', enum: ['accepted', 'rejected'], description: 'Acción' },
        reason: { type: 'string', description: 'Motivo (obligatorio si rejected)' },
      },
      required: ['code', 'action'],
    },
  },
  {
    name: 'start_trip',
    description: 'Inicia viaje específico de flete multi-camión.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_loaded',
    description: 'Confirma carga de viaje específico.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
        loadedTons: { type: 'number', description: 'Toneladas cargadas en este viaje' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_finished',
    description: 'Confirma entrega de viaje específico.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
      },
      required: ['code'],
    },
  },

  // ======================== ASIGNACIÓN DE TRANSPORTE ========================
  {
    name: 'list_transporters',
    description: 'Lista transportistas disponibles como menú interactivo. Puede filtrar por nombre (fuzzy).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filtrar por nombre (fuzzy)' },
      },
      required: [],
    },
  },
  {
    name: 'assign_transporter',
    description: 'Asigna transportista a flete. Usar "own_fleet" para flota propia del productor.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        transporterCompanyId: { type: 'string', description: 'UUID empresa transportista o "own_fleet" para flota propia' },
        truckId: { type: 'string', description: 'UUID camión (opcional)' },
        driverId: { type: 'string', description: 'UUID chofer (opcional)' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  {
    name: 'assign_truck_to_trip',
    description: 'Asigna o cambia camión en viaje existente. Solo plantas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        truckId: { type: 'string', description: 'UUID del camión' },
        driverId: { type: 'string', description: 'UUID chofer (opcional)' },
      },
      required: ['code', 'truckId'],
    },
  },
  {
    name: 'assign_truck_to_freight',
    description: 'Asigna camión adicional a flete multi-camión con viajes sin asignar. "own_fleet" para flota propia.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        transporterCompanyId: { type: 'string', description: 'UUID empresa o "own_fleet"' },
        truckId: { type: 'string', description: 'UUID camión (opcional)' },
        driverId: { type: 'string', description: 'UUID chofer (opcional)' },
        tons: { type: 'number', description: 'Toneladas para este viaje (opcional)' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  {
    name: 'assign_multi_trucks',
    description: 'Asigna múltiples camiones a flete de una vez. Solo plantas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        trucks: {
          type: 'array',
          description: 'Lista de camiones a asignar',
          items: {
            type: 'object',
            properties: {
              transportCompanyId: { type: 'string', description: 'UUID empresa transportista' },
              truckId: { type: 'string', description: 'UUID camión (opcional)' },
              driverId: { type: 'string', description: 'UUID chofer (opcional)' },
              tons: { type: 'number', description: 'Toneladas (opcional)' },
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
    description: 'Cancela asignación de camión. Solo plantas. Requiere motivo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
        reason: { type: 'string', description: 'Motivo' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'update_assignment',
    description: 'Edita asignación existente (transportista, camión, chofer, tons). Solo plantas, solo viajes pendientes/aceptados.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'UUID asignación (opcional si un solo viaje)' },
        transporterCompanyId: { type: 'string', description: 'Nuevo transportista UUID' },
        truckId: { type: 'string', description: 'Nuevo camión UUID' },
        driverId: { type: 'string', description: 'Nuevo chofer UUID' },
        tons: { type: 'number', description: 'Nuevas toneladas' },
      },
      required: ['code'],
    },
  },
  {
    name: 'approve_pending_change',
    description: 'Aprueba cambio pendiente en flete. Solo empresa aprobadora.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        changeId: { type: 'string', description: 'UUID del cambio (opcional, usa el primero)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'reject_pending_change',
    description: 'Rechaza cambio pendiente en flete. Solo empresa aprobadora.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        changeId: { type: 'string', description: 'UUID del cambio (opcional)' },
        reason: { type: 'string', description: 'Motivo del rechazo' },
      },
      required: ['code'],
    },
  },

  // ======================== CAMPOS Y LOTES ========================
  {
    name: 'search_plants',
    description: 'Busca plantas destino por nombre (fuzzy). Menú interactivo si hay múltiples.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial de planta o sucursal' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_fields',
    description: 'Lista campos del productor como menú interactivo.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'list_lots',
    description: 'Lista lotes del productor como menú interactivo. Puede filtrar por campo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldId: { type: 'string', description: 'UUID campo para filtrar (opcional)' },
      },
      required: [],
    },
  },
  {
    name: 'search_fields',
    description: 'Busca campos del productor por nombre (fuzzy).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial del campo' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_lots',
    description: 'Busca lotes del productor por nombre (fuzzy). Puede filtrar por campo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial del lote' },
        fieldId: { type: 'string', description: 'UUID campo para filtrar (opcional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_user_profile',
    description: 'Datos del perfil del usuario: nombre, email, teléfono, rol, empresa activa.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_field',
    description: 'Crea campo agrícola. Usa ubicación de generate_location_link si disponible.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre del campo' },
        address: { type: 'string', description: 'Dirección (opcional)' },
        lat: { type: 'number', description: 'Latitud (opcional)' },
        lng: { type: 'number', description: 'Longitud (opcional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_lot',
    description: 'Crea lote dentro de un campo.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldId: { type: 'string', description: 'UUID del campo' },
        name: { type: 'string', description: 'Nombre del lote' },
        hectares: { type: 'number', description: 'Hectáreas (opcional)' },
        lat: { type: 'number', description: 'Latitud (opcional)' },
        lng: { type: 'number', description: 'Longitud (opcional)' },
      },
      required: ['fieldId', 'name'],
    },
  },
  {
    name: 'update_field',
    description: 'Modifica campo existente (dirección, ubicación). Busca por nombre.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldName: { type: 'string', description: 'Nombre del campo' },
        address: { type: 'string', description: 'Nueva dirección' },
        lat: { type: 'number', description: 'Nueva latitud' },
        lng: { type: 'number', description: 'Nueva longitud' },
      },
      required: ['fieldName'],
    },
  },
  {
    name: 'update_lot',
    description: 'Modifica lote existente (hectáreas, ubicación). Busca por nombre.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lotName: { type: 'string', description: 'Nombre del lote' },
        hectares: { type: 'number', description: 'Nuevas hectáreas' },
        lat: { type: 'number', description: 'Nueva latitud' },
        lng: { type: 'number', description: 'Nueva longitud' },
      },
      required: ['lotName'],
    },
  },

  // ======================== CAMIONES Y CHOFERES ========================
  {
    name: 'list_trucks',
    description: 'Lista camiones de la empresa como menú interactivo.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_truck',
    description: 'Registra camión en la flota. Patente obligatoria.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plate: { type: 'string', description: 'Patente/matrícula' },
        model: { type: 'string', description: 'Modelo (opcional)' },
      },
      required: ['plate'],
    },
  },
  {
    name: 'update_truck',
    description: 'Edita datos de camión (patente, marca, modelo, capacidad).',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'UUID del camión' },
        plate: { type: 'string', description: 'Nueva patente' },
        brand: { type: 'string', description: 'Marca' },
        model: { type: 'string', description: 'Modelo' },
        capacity: { type: 'number', description: 'Capacidad en toneladas' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'deactivate_truck',
    description: 'Desactiva camión. No se puede si tiene viajes activos.',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'UUID del camión' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'list_drivers',
    description: 'Lista choferes de la empresa como menú interactivo.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_driver',
    description: 'Registra nuevo chofer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo' },
        phone: { type: 'string', description: 'Teléfono (opcional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'deactivate_driver',
    description: 'Desactiva chofer. No se puede si tiene viajes activos.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer' },
      },
      required: ['driverId'],
    },
  },
  {
    name: 'view_driver_queue',
    description: 'Cola de fletes asignados a un chofer en orden de prioridad.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer' },
      },
      required: ['driverId'],
    },
  },
  {
    name: 'reorder_driver_queue',
    description: 'Reordena cola de fletes de un chofer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'UUID del chofer' },
        orderedFreightIds: {
          type: 'array',
          description: 'UUIDs de fletes en orden deseado',
          items: { type: 'string' },
        },
      },
      required: ['driverId', 'orderedFreightIds'],
    },
  },

  // ======================== DOCUMENTOS ========================
  {
    name: 'attach_document',
    description: 'Adjunta imagen/documento pendiente a un flete. Usar directo con código.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        step: {
          type: 'string',
          enum: ['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'],
          description: 'Etapa del documento (opcional)',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'list_documents',
    description: 'Lista documentos adjuntos de un flete. Retorna texto.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'delete_document',
    description: 'Elimina documento de un flete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        documentId: { type: 'string', description: 'UUID del documento' },
      },
      required: ['code', 'documentId'],
    },
  },
  {
    name: 'ocr_analyze',
    description: 'Analiza imagen de documento (remito, pesaje) y extrae datos con OCR.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL pública de la imagen' },
        docType: {
          type: 'string',
          enum: ['carta_porte', 'remito', 'pesaje', 'general'],
          description: 'Tipo de documento ("general" si no se sabe)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'save_ocr_data',
    description: 'Guarda datos OCR en documento de flete. Usar después de ocr_analyze cuando el usuario confirma.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        documentId: { type: 'string', description: 'UUID del documento' },
        ocrData: { type: 'object', description: 'Datos OCR estructurados' },
      },
      required: ['code', 'documentId', 'ocrData'],
    },
  },

  // ======================== UBICACIONES Y MAPAS ========================
  {
    name: 'generate_location_link',
    description: 'Link para elegir ubicación en mapa. Coordenadas se guardan en sesión.',
    input_schema: {
      type: 'object' as const,
      properties: {
        purpose: {
          type: 'string',
          enum: ['origin', 'destination', 'field', 'lot'],
          description: 'Para qué es la ubicación',
        },
      },
      required: ['purpose'],
    },
  },
  {
    name: 'generate_tracking_link',
    description: 'Link público para rastrear flete en vivo. Solo fletes activos.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'generate_map_link',
    description: 'Link para ver ubicación en mapa. Acepta 1 o 2 puntos. NUNCA devolver coordenadas directamente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lat: { type: 'number', description: 'Latitud principal' },
        lng: { type: 'number', description: 'Longitud principal' },
        name: { type: 'string', description: 'Nombre del lugar' },
        destLat: { type: 'number', description: 'Latitud destino (opcional)' },
        destLng: { type: 'number', description: 'Longitud destino (opcional)' },
        destName: { type: 'string', description: 'Nombre destino (opcional)' },
      },
      required: ['lat', 'lng', 'name'],
    },
  },
  {
    name: 'generate_report_link',
    description: 'Link para descargar PDF de un flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'generate_shared_link',
    description: 'Link compartible para seguimiento de flete sin login. Dura 72h.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        targetCompanyId: { type: 'string', description: 'ID empresa destinataria (opcional, default productor del flete)' },
      },
      required: ['code'],
    },
  },
  {
    name: 'generate_daily_map_link',
    description: 'Mapa interactivo de todos los fletes del día con marcadores por estado.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'generate_batch_report_link',
    description: 'Link a pantalla de reportes web con filtros pre-aplicados para PDF/Excel.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filtro estado' },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD)' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD)' },
      },
      required: [],
    },
  },
  {
    name: 'share_live_location',
    description: 'Link para compartir ubicación en vivo en mapa de un flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'view_live_locations',
    description: 'Link para ver ubicaciones en vivo de participantes de un flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },
  {
    name: 'request_location',
    description: 'Envía WhatsApp a participantes pidiendo compartir ubicación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete' } },
      required: ['code'],
    },
  },

  // ======================== GESTIÓN DE USUARIOS ========================
  {
    name: 'list_company_users',
    description: 'Lista usuarios de la empresa como menú interactivo.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'create_user',
    description: 'Crea usuario en la empresa.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo' },
        email: { type: 'string', description: 'Email' },
        phone: { type: 'string', description: 'Teléfono (opcional)' },
        role: {
          type: 'string',
          enum: ['admin', 'gerente', 'operario', 'chofer'],
          description: 'Rol',
        },
      },
      required: ['name', 'email'],
    },
  },
  {
    name: 'update_user_role',
    description: 'Cambia rol de un usuario.',
    input_schema: {
      type: 'object' as const,
      properties: {
        userIdentifier: { type: 'string', description: 'Nombre o email del usuario' },
        newRole: {
          type: 'string',
          enum: ['gerente', 'operario', 'chofer'],
          description: 'Nuevo rol',
        },
      },
      required: ['userIdentifier', 'newRole'],
    },
  },
  {
    name: 'deactivate_user',
    description: 'Desactiva usuario de la empresa.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'reactivate_user',
    description: 'Reactiva usuario desactivado.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'update_user_admin',
    description: 'Edita usuario (nombre, email, teléfono, rol, estado).',
    input_schema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'UUID del usuario' },
        name: { type: 'string', description: 'Nuevo nombre' },
        email: { type: 'string', description: 'Nuevo email' },
        phone: { type: 'string', description: 'Nuevo teléfono' },
        role: { type: 'string', enum: ['admin', 'operario', 'chofer'], description: 'Nuevo rol' },
        active: { type: 'boolean', description: 'Activar/desactivar' },
      },
      required: ['userId'],
    },
  },
  {
    name: 'update_profile',
    description: 'Modifica perfil del usuario actual (nombre, email, teléfono).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre' },
        email: { type: 'string', description: 'Nuevo email' },
        phone: { type: 'string', description: 'Nuevo teléfono' },
      },
      required: [],
    },
  },

  // ======================== EMPRESA ========================
  {
    name: 'switch_company',
    description: 'Cambia empresa activa. Sin companyId lista disponibles, con companyId ejecuta cambio.',
    input_schema: {
      type: 'object' as const,
      properties: { companyId: { type: 'string', description: 'UUID empresa destino (opcional)' } },
      required: [],
    },
  },
  {
    name: 'update_company',
    description: 'Edita datos de empresa activa (nombre, dirección, teléfono, email, ubicación).',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre' },
        address: { type: 'string', description: 'Nueva dirección' },
        phone: { type: 'string', description: 'Nuevo teléfono' },
        email: { type: 'string', description: 'Nuevo email' },
        lat: { type: 'number', description: 'Nueva latitud' },
        lng: { type: 'number', description: 'Nueva longitud' },
      },
      required: [],
    },
  },

  // ======================== ACCESO PLANTA-PRODUCTOR ========================
  {
    name: 'list_enabled_plants',
    description: 'Lista plantas habilitadas para el productor.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'list_enabled_producers',
    description: 'Lista productores habilitados en la planta. Solo plantas.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'grant_producer_access',
    description: 'Habilita productor para operar con la planta. Solo plantas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        producerCompanyId: { type: 'string', description: 'UUID empresa productora' },
        producerUserId: { type: 'string', description: 'UUID usuario (opcional, habilita toda la empresa si omitido)' },
      },
      required: ['producerCompanyId'],
    },
  },
  {
    name: 'revoke_producer_access',
    description: 'Revoca acceso de productor a la planta. Solo plantas.',
    input_schema: {
      type: 'object' as const,
      properties: {
        accessId: { type: 'string', description: 'UUID del registro de acceso' },
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
    description: 'Crea sucursal para la empresa.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre' },
        address: { type: 'string', description: 'Dirección (opcional)' },
        reference: { type: 'string', description: 'Referencia (opcional)' },
        lat: { type: 'number', description: 'Latitud (opcional)' },
        lng: { type: 'number', description: 'Longitud (opcional)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_branch',
    description: 'Edita sucursal existente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'UUID de la sucursal' },
        name: { type: 'string', description: 'Nuevo nombre' },
        address: { type: 'string', description: 'Nueva dirección' },
        reference: { type: 'string', description: 'Nueva referencia' },
        lat: { type: 'number', description: 'Nueva latitud' },
        lng: { type: 'number', description: 'Nueva longitud' },
      },
      required: ['branchId'],
    },
  },
  {
    name: 'delete_branch',
    description: 'Desactiva una sucursal.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'UUID de la sucursal' },
      },
      required: ['branchId'],
    },
  },

  // ======================== NAVEGACIÓN WEB ========================
  {
    name: 'navigate_app',
    description: 'Navega al usuario a pantalla de la app web. Solo canal web.',
    input_schema: {
      type: 'object' as const,
      properties: {
        screen: {
          type: 'string',
          enum: ['home', 'list', 'new', 'detail', 'calendar', 'reports', 'locations', 'trucks', 'menu', 'chats', 'documents', 'analytics', 'admin', 'mydata', 'notifs', 'linked', 'queue'],
          description: 'Pantalla destino',
        },
        freightId: { type: 'string', description: 'UUID flete (solo screen="detail")' },
      },
      required: ['screen'],
    },
  },
  {
    name: 'get_assignment_suggestions',
    description: 'Sugerencias rankeadas de transporte para asignar un flete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        freightId: { type: 'string', description: 'ID del flete' },
      },
      required: ['freightId'],
    },
  },

  // ======================== FLEET ECONOMICS ========================
  {
    name: 'get_truck_detail',
    description: 'Detalle de camión: datos, chofer, fletes activos, documentos, resumen económico. Buscar por patente o ID.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente (fuzzy)' }, truckId: { type: 'string', description: 'UUID del camión' } }, required: [] },
  },
  {
    name: 'get_truck_documents',
    description: 'Documentos de camión con estado de vencimiento.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, filter: { type: 'string', enum: ['all', 'expired', 'expiring', 'valid'], description: 'Filtro por vencimiento' } }, required: ['plate'] },
  },
  {
    name: 'get_expiring_documents',
    description: 'Documentos próximos a vencer o vencidos de toda la flota.',
    input_schema: { type: 'object' as const, properties: { days: { type: 'number', description: 'Días hacia adelante (default 30)' } }, required: [] },
  },
  {
    name: 'attach_truck_document',
    description: 'Adjunta archivo pendiente a gasto, ingreso o documento de camión.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, linkTo: { type: 'string', enum: ['expense', 'income', 'movement', 'general'], description: 'A qué vincular' }, linkId: { type: 'string', description: 'ID del gasto/ingreso/movimiento (opcional)' }, docType: { type: 'string', enum: ['VTV_ITV', 'INSURANCE', 'TRANSPORT_LICENSE', 'DRIVER_LICENSE', 'BPS_DGI', 'GET_CERTIFICATE', 'CIRCULATION_PERMIT', 'OTHER'], description: 'Tipo de documento' } }, required: ['plate'] },
  },
  {
    name: 'register_truck_expense',
    description: 'Registra gasto del camión (combustible, peaje, mantenimiento, etc).',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, type: { type: 'string', enum: ['FUEL', 'TOLL', 'MAINTENANCE', 'TIRE', 'INSURANCE', 'FINE', 'PARKING', 'MEAL', 'OTHER'], description: 'Tipo de gasto' }, amount: { type: 'number', description: 'Monto' }, currency: { type: 'string', enum: ['UYU', 'USD', 'ARS'], description: 'Moneda (default UYU)' }, date: { type: 'string', description: 'Fecha YYYY-MM-DD (default hoy)' }, description: { type: 'string', description: 'Descripción (opcional)' }, freightCode: { type: 'string', description: 'Código flete asociado (opcional)' } }, required: ['plate', 'type', 'amount'] },
  },
  {
    name: 'list_truck_expenses',
    description: 'Lista gastos de camión con totales. Filtrar por fecha o tipo.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, from: { type: 'string', description: 'Fecha desde' }, to: { type: 'string', description: 'Fecha hasta' }, type: { type: 'string', description: 'Tipo de gasto' } }, required: ['plate'] },
  },
  {
    name: 'register_truck_income',
    description: 'Registra ingreso/cobro del camión. Puede vincularse a flete.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, concept: { type: 'string', description: 'Concepto del ingreso' }, amount: { type: 'number', description: 'Monto' }, currency: { type: 'string', enum: ['UYU', 'USD', 'ARS'], description: 'Moneda' }, date: { type: 'string', description: 'Fecha YYYY-MM-DD' }, status: { type: 'string', enum: ['PENDING', 'PAID', 'OVERDUE'], description: 'Estado (default PENDING)' }, freightCode: { type: 'string', description: 'Código flete asociado (opcional)' } }, required: ['plate', 'concept', 'amount'] },
  },
  {
    name: 'list_truck_incomes',
    description: 'Lista ingresos de camión. Filtrar por estado para pendientes de cobro.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, from: { type: 'string', description: 'Fecha desde' }, to: { type: 'string', description: 'Fecha hasta' }, status: { type: 'string', enum: ['PENDING', 'PAID', 'OVERDUE'], description: 'Filtrar por estado' } }, required: ['plate'] },
  },
  {
    name: 'register_truck_movement',
    description: 'Registra movimiento extra-flete (reposicionamiento, taller, traslado, uso particular).',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, type: { type: 'string', enum: ['REPOSITIONING', 'MAINTENANCE_TRIP', 'INTERNAL_TRANSFER', 'PERSONAL', 'OTHER'], description: 'Tipo de movimiento' }, description: { type: 'string', description: 'Descripción' }, originName: { type: 'string', description: 'Origen' }, destName: { type: 'string', description: 'Destino' }, kmDriven: { type: 'number', description: 'Km recorridos' }, fuelLiters: { type: 'number', description: 'Litros combustible' }, fuelCost: { type: 'number', description: 'Costo combustible' }, tollCost: { type: 'number', description: 'Costo peajes' } }, required: ['plate', 'type'] },
  },
  {
    name: 'list_truck_movements',
    description: 'Lista movimientos extra-flete de un camión.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, from: { type: 'string', description: 'Fecha desde' }, to: { type: 'string', description: 'Fecha hasta' }, type: { type: 'string', description: 'Tipo' } }, required: ['plate'] },
  },
  {
    name: 'register_trip_data',
    description: 'Registra datos operativos de viaje (km, combustible, odómetro, tiempos). Carga parcial OK.',
    input_schema: { type: 'object' as const, properties: { freightCode: { type: 'string', description: 'Código del flete' }, kmLoaded: { type: 'number', description: 'Km con carga' }, kmEmpty: { type: 'number', description: 'Km vacío' }, fuelLiters: { type: 'number', description: 'Litros consumidos' }, fuelCostPerLiter: { type: 'number', description: 'Precio/litro' }, tollCost: { type: 'number', description: 'Peajes totales' }, odometerStart: { type: 'number', description: 'Odómetro salida' }, odometerEnd: { type: 'number', description: 'Odómetro llegada' }, loadingMinutes: { type: 'number', description: 'Min espera carga' }, unloadingMinutes: { type: 'number', description: 'Min espera descarga' } }, required: ['freightCode'] },
  },
  {
    name: 'get_truck_economic_summary',
    description: 'Resumen económico de camión: ingresos, gastos, neto, km, costo/km, km/litro.',
    input_schema: { type: 'object' as const, properties: { plate: { type: 'string', description: 'Patente' }, from: { type: 'string', description: 'Fecha desde' }, to: { type: 'string', description: 'Fecha hasta' } }, required: ['plate'] },
  },
  {
    name: 'get_fleet_summary',
    description: 'Resumen económico de toda la flota del mes: ingresos, gastos, neto, km, mejor camión, alertas.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_fleet_alerts',
    description: 'Alertas de documentos vencidos y por vencer de toda la flota.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },

  // ====================== EXTERNAL TRUCKS (G1, G2, G3) ======================
  {
    name: 'assign_external_truck',
    description: 'Asigna camión de terceros (no registrado) a flete. Solo por matrícula.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        plate: { type: 'string', description: 'Matrícula del camión' },
        externalCompanyName: { type: 'string', description: 'Empresa transportista (opcional)' },
        externalDriverName: { type: 'string', description: 'Chofer (opcional)' },
      },
      required: ['code', 'plate'],
    },
  },
  {
    name: 'assign_mixed_trucks',
    description: 'Asigna múltiples camiones de distintos tipos: flota propia (transportCompanyId+truckId), externo (isExternal+plate) o delegado (solo transportCompanyId).',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        trucks: {
          type: 'array',
          description: 'Lista de camiones',
          items: {
            type: 'object',
            properties: {
              isExternal: { type: 'boolean', description: 'true si terceros' },
              plate: { type: 'string', description: 'Matrícula (requerido si isExternal)' },
              externalCompanyName: { type: 'string', description: 'Empresa externa (opcional)' },
              externalDriverName: { type: 'string', description: 'Chofer externo (opcional)' },
              transportCompanyId: { type: 'string', description: 'ID empresa (requerido si no isExternal)' },
              truckId: { type: 'string', description: 'ID camión (opcional)' },
              driverId: { type: 'string', description: 'ID chofer (opcional)' },
            },
          },
        },
      },
      required: ['code', 'trucks'],
    },
  },
  {
    name: 'edit_external_assignment',
    description: 'Edita datos de camión externo ya asignado (matrícula, empresa, chofer).',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        assignmentId: { type: 'string', description: 'ID asignación (opcional si una sola)' },
        plate: { type: 'string', description: 'Nueva matrícula (opcional)' },
        externalCompanyName: { type: 'string', description: 'Nueva empresa (opcional)' },
        externalDriverName: { type: 'string', description: 'Nuevo chofer (opcional)' },
      },
      required: ['code'],
    },
  },

  // ====================== DOCUMENT RENAME (G8) ======================
  {
    name: 'rename_document',
    description: 'Renombra documento adjunto a un flete.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        documentId: { type: 'string', description: 'ID del documento' },
        newName: { type: 'string', description: 'Nuevo nombre' },
      },
      required: ['code', 'documentId', 'newName'],
    },
  },

  // ====================== SHARE LINK (G9) ======================
  {
    name: 'generate_share_link_with_details',
    description: 'Link público para compartir seguimiento de flete. Reutiliza link activo si existe.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
      },
      required: ['code'],
    },
  },

  // ====================== ESCALAMIENTO HAIKU → SONNET ======================
  {
    name: 'escalate_to_sonnet',
    description: 'Escalar cuando no se puede ejecutar con herramientas disponibles. Responder "Dame un momento" y llamar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Qué acción necesita el usuario',
        },
        user_message: {
          type: 'string',
          description: 'Mensaje original del usuario',
        },
      },
      required: ['reason'],
    },
  },
];
