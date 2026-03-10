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
  {
    name: 'list_freights',
    description: 'Lista los fletes del usuario como menú interactivo de WhatsApp. Puede filtrar por estado, fecha y grano. Retorna _selectionSent: true — NO reformatear. Para resúmenes/análisis usar summarize_freights.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'],
          description: 'Filtrar por estado (opcional)',
        },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
        grain: { type: 'string', description: 'Filtrar por grano (ej: Soja, Trigo). Opcional.' },
      },
      required: [],
    },
  },
  {
    name: 'get_freight_detail',
    description: 'Detalle completo de un flete por código (ej: F26-LCP.1822). Incluye mapLink con link al mapa Tolvink si hay coordenadas — usarlo siempre que el usuario pregunte por ubicación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
      },
      required: ['code'],
    },
  },
  {
    name: 'search_plants',
    description: 'Busca plantas/empresas destino. Envía menú interactivo si hay multiples resultados. Retorna _selectionSent: true — NO reformatear.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Nombre parcial de la planta' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_lots',
    description: 'Lista lotes del productor como menú interactivo. Retorna _selectionSent: true — NO reformatear.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'prepare_freight',
    description: 'Prepara un flete para creación (NO lo crea). Devuelve resumen para confirmar. Necesita: grain, tons, loadDate (YYYY-MM-DD), loadTime (HH:mm). Destino: destPlantId O destName (auto-resuelve texto contra plantas habilitadas). Origen: originLotId O originName (auto-resuelve contra campos/lotes del productor). Si planta tiene sucursales → branchId OBLIGATORIO. Si truckId (flota propia) → driverId OBLIGATORIO ("self" = yo).',
    input_schema: {
      type: 'object' as const,
      properties: {
        grain: { type: 'string', enum: ['Soja', 'Maíz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'] },
        tons: { type: 'number' },
        truckCount: { type: 'number', description: 'Se auto-calcula a partir de tons/30 si no se pasa' },
        destPlantId: { type: 'string', description: 'ID de planta/empresa destino' },
        destName: { type: 'string', description: 'Nombre de planta — se auto-resuelve contra plantas habilitadas' },
        branchId: { type: 'string', description: 'ID de sucursal. OBLIGATORIO si planta tiene sucursales.' },
        customDestLat: { type: 'number' },
        customDestLng: { type: 'number' },
        originLotId: { type: 'string', description: 'ID de lote' },
        originName: { type: 'string', description: 'Nombre de campo o lote — se auto-resuelve contra datos del productor' },
        customOriginName: { type: 'string', description: 'Nombre origen personalizado (si no hay lote/campo)' },
        customOriginLat: { type: 'number' },
        customOriginLng: { type: 'number' },
        truckId: { type: 'string', description: 'ID de camión propio. Requiere driverId.' },
        driverId: { type: 'string', description: 'ID del chofer o "self". OBLIGATORIO si truckId se indica.' },
        loadDate: { type: 'string', description: 'YYYY-MM-DD' },
        loadTime: { type: 'string', description: 'HH:mm' },
        notes: { type: 'string' },
      },
      required: ['grain', 'tons', 'loadDate', 'loadTime'],
    },
  },
  {
    name: 'confirm_create_freight',
    description: 'OBLIGATORIO: Crea el flete preparado con prepare_freight. Debes llamar esta herramienta cuando el usuario confirme (dice si/dale/confirmar/ok). Sin esta llamada el flete NO se crea.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'confirm_action',
    description: 'OBLIGATORIO: Ejecuta una acción previamente preparada cuando el usuario confirma (dice si/dale/confirmar/ok). Sin esta llamada la acción NO se ejecuta. NO usar para crear fletes (esos usan confirm_create_freight).',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'accept_freight',
    description: 'Acepta un flete asignado. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'reject_freight',
    description: 'Rechaza un flete asignado. Requiere motivo. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        reason: { type: 'string', description: 'Motivo del rechazo' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'start_freight',
    description: 'Inicia el viaje de un flete aceptado. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'confirm_loaded',
    description: 'Confirma carga de un flete. Requiere toneladas reales. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        tons: { type: 'number', description: 'Toneladas cargadas' },
      },
      required: ['code', 'tons'],
    },
  },
  {
    name: 'confirm_finished',
    description: 'Confirma entrega/recepción de un flete. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'cancel_freight',
    description: 'Cancela un flete. No se puede si está in_progress o loaded. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        reason: { type: 'string', description: 'Motivo de cancelación' },
      },
      required: ['code', 'reason'],
    },
  },
  // ---- Field & Lot management ----
  { name: 'list_fields', description: 'Lista campos del productor como menú interactivo. Retorna _selectionSent: true — NO reformatear.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'create_field',
    description: 'Crea un campo (establecimiento). Prepara la acción para confirmación. Si el usuario marcó ubicación con generate_location_link, se usa automáticamente.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre del campo' },
        address: { type: 'string', description: 'Dirección (opcional)' },
        lat: { type: 'number', description: 'Latitud (opcional, se usa ubicación compartida si no se indica)' },
        lng: { type: 'number', description: 'Longitud (opcional, se usa ubicación compartida si no se indica)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'create_lot',
    description: 'Crea un lote dentro de un campo existente. Prepara la acción para confirmación. Usa list_fields para obtener el fieldId.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldId: { type: 'string', description: 'ID del campo (de list_fields)' },
        name: { type: 'string', description: 'Nombre del lote' },
        hectares: { type: 'number', description: 'Hectáreas (opcional)' },
        lat: { type: 'number', description: 'Latitud (opcional, se usa ubicación compartida si no se indica)' },
        lng: { type: 'number', description: 'Longitud (opcional, se usa ubicación compartida si no se indica)' },
      },
      required: ['fieldId', 'name'],
    },
  },
  // ---- Truck management ----
  { name: 'list_trucks', description: 'Lista camiones de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'create_truck',
    description: 'Registra un nuevo camión en la flota de la empresa. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plate: { type: 'string', description: 'Patente/matrícula del camión (ej: ABC1234)' },
        model: { type: 'string', description: 'Modelo del camión (opcional)' },
      },
      required: ['plate'],
    },
  },
  // ---- User management ----
  {
    name: 'create_user',
    description: 'Crea un nuevo usuario en la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo' },
        email: { type: 'string', description: 'Email del usuario' },
        phone: { type: 'string', description: 'Teléfono (opcional)' },
        role: { type: 'string', enum: ['admin', 'gerente', 'operario', 'chofer'], description: 'Rol: admin/gerente, operario, o chofer (default: operario)' },
      },
      required: ['name', 'email'],
    },
  },
  // ---- Document attachment ----
  {
    name: 'attach_document',
    description: 'USAR CUANDO EL USUARIO INDICA UN CÓDIGO DE FLETE DESPUÉS DE ENVIAR UN ARCHIVO. Adjunta la imagen o documento previamente enviado por WhatsApp al flete indicado. NO usar list_freights — usar esta herramienta directamente con el código. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        step: { type: 'string', enum: ['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'], description: 'Etapa del documento (opcional)' },
      },
      required: ['code'],
    },
  },
  // ---- Location picker ----
  {
    name: 'generate_location_link',
    description: 'Genera un link para que el usuario elija una ubicación en el mapa Tolvink. Usalo cuando el usuario necesite marcar una ubicación personalizada (origen, destino, campo, lote). El usuario abre el link, pinea la ubicación, y las coordenadas se guardan automáticamente en la sesión.',
    input_schema: {
      type: 'object' as const,
      properties: { purpose: { type: 'string', enum: ['origin', 'destination', 'field', 'lot'], description: 'Para que es la ubicación' } },
      required: ['purpose'],
    },
  },
  // ---- Tracking & map links ----
  {
    name: 'generate_tracking_link',
    description: 'Genera un link público para rastrear un flete en vivo en el mapa Tolvink. Muestra ruta completa (origen → destino) y posición del camión en tiempo real. Solo funciona para fletes activos (no finalizados ni cancelados). El link no expira mientras el flete esté activo.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'generate_map_link',
    description: 'Genera un link para ver una ubicación en el mapa Tolvink. OBLIGATORIO cuando el usuario pregunta por la ubicación de un campo, lote, planta, origen o destino. Acepta 1 o 2 puntos (origen + destino). NUNCA devolver coordenadas numéricas — siempre usar esta herramienta.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lat: { type: 'number', description: 'Latitud del punto principal' },
        lng: { type: 'number', description: 'Longitud del punto principal' },
        name: { type: 'string', description: 'Nombre del lugar (campo, lote, planta, origen)' },
        destLat: { type: 'number', description: 'Latitud del destino (opcional, para mostrar ruta)' },
        destLng: { type: 'number', description: 'Longitud del destino (opcional)' },
        destName: { type: 'string', description: 'Nombre del destino (opcional)' },
      },
      required: ['lat', 'lng', 'name'],
    },
  },
  {
    name: 'generate_report_link',
    description: 'Genera un link público para descargar el informe PDF de un flete. Incluye información completa, recorrido, historial de cambios y documentos. Funciona para cualquier flete (incluso finalizados o cancelados). El link no expira.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  { name: 'generate_daily_map_link', description: 'Genera un link con un mapa interactivo mostrando todos los fletes del día de la empresa activa del usuario. Los fletes se muestran con marcadores de colores según estado. Usar cuando el usuario quiera ver un panorama general de los fletes del día en el mapa.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'share_live_location',
    description: 'Genera un link para que el usuario comparta su ubicación en vivo en el mapa de un flete específico. Todos los participantes del flete podrán ver la posición del usuario. Usar cuando el usuario quiera compartir dónde está durante un viaje.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'view_live_locations',
    description: 'Genera un link para ver las ubicaciones en vivo de todos los participantes de un flete en el mapa. Usar cuando el usuario quiera ver dónde están los involucrados en un flete.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'request_location',
    description: 'Solicitar a los involucrados de un flete que compartan su ubicación por WhatsApp. Envía un mensaje a los participantes pidiéndoles que envíen su ubicación. Usar cuando alguien pregunta dónde está el chofer o pide ubicación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  // ---- Transporter assignment ----
  { name: 'list_transporters', description: 'Lista transportistas como menú interactivo. Retorna _selectionSent: true — NO reformatear. Para plantas y productores con flota interna.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'assign_transporter',
    description: 'Asigna un transportista a un flete. Para plantas y productores con flota interna. Usar transporterCompanyId="own_fleet" para flota interna del productor. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        transporterCompanyId: { type: 'string', description: 'ID de empresa transportista, o "own_fleet" para flota interna del productor' },
        truckId: { type: 'string', description: 'ID del camión (opcional, de list_trucks)' },
        driverId: { type: 'string', description: 'ID del chofer (opcional, de list_drivers)' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  {
    name: 'assign_truck_to_trip',
    description: 'Asigna o cambia el camión de un viaje existente. Solo para plantas. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        truckId: { type: 'string', description: 'ID del camión (de list_trucks)' },
        driverId: { type: 'string', description: 'ID del chofer (opcional)' },
      },
      required: ['code', 'truckId'],
    },
  },
  {
    name: 'assign_truck_to_freight',
    description: 'Asigna un camión adicional a un flete multi-camión que tiene viajes sin asignar. Usar transporterCompanyId="own_fleet" para flota interna. Se llama una vez por cada viaje adicional. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        transporterCompanyId: { type: 'string', description: 'ID empresa o "own_fleet" para flota interna' },
        truckId: { type: 'string', description: 'ID del camión (opcional, de list_trucks)' },
        driverId: { type: 'string', description: 'ID del chofer (opcional)' },
        tons: { type: 'number', description: 'Toneladas para este viaje (opcional)' },
      },
      required: ['code', 'transporterCompanyId'],
    },
  },
  // ---- Company team management ----
  { name: 'list_company_users', description: 'Lista usuarios de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  { name: 'list_drivers', description: 'Lista choferes de la empresa como menú interactivo. Retorna _selectionSent: true — NO reformatear.', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'update_user_role',
    description: 'Cambia el rol de un usuario de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        userIdentifier: { type: 'string', description: 'Nombre o email del usuario' },
        newRole: { type: 'string', enum: ['gerente', 'operario', 'chofer'], description: 'Nuevo rol' },
      },
      required: ['userIdentifier', 'newRole'],
    },
  },
  {
    name: 'deactivate_user',
    description: 'Desactiva un usuario de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email del usuario a desactivar' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'switch_company',
    description: 'Cambia la empresa activa del usuario. Sin companyId: lista empresas disponibles. Con companyId: ejecuta el cambio. Usar cuando el usuario quiere operar con otra empresa.',
    input_schema: {
      type: 'object' as const,
      properties: { companyId: { type: 'string', description: 'ID de la empresa destino (opcional, de la lista)' } },
      required: [],
    },
  },
  {
    name: 'summarize_freights',
    description: 'Resumen analítico de fletes con datos completos para agrupar, contar o analizar. NO muestra menú interactivo — retorna datos en texto para que el asistente genere un resumen organizado. Usar cuando el usuario pide: resumen, reporte, agrupados por, cuántos fletes, estadísticas, análisis. Para seleccionar un flete individual, usar list_freights en su lugar.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', enum: ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded', 'finished', 'canceled'], description: 'Filtrar por estado (opcional)' },
        groupBy: { type: 'string', enum: ['transporter', 'status', 'grain', 'destination', 'origin'], description: 'Agrupar resultados por este criterio (opcional)' },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
        grain: { type: 'string', description: 'Filtrar por grano (ej: Soja, Trigo). Opcional.' },
        transporterName: { type: 'string', description: 'Filtrar por nombre de transportista (parcial). Opcional.' },
      },
      required: [],
    },
  },
  {
    name: 'update_freight',
    description: 'Modifica un flete existente. Puede cambiar fecha, hora, notas, flota propia, planta destino, camión y chofer. Algunos cambios pueden requerir aprobación. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        loadDate: { type: 'string', description: 'Nueva fecha de carga (YYYY-MM-DD). Opcional.' },
        loadTime: { type: 'string', description: 'Nueva hora de carga (HH:mm). Opcional.' },
        notes: { type: 'string', description: 'Nuevas notas. Opcional.' },
        useOwnFleet: { type: 'boolean', description: 'Usar flota propia (true/false). Opcional.' },
        destPlantId: { type: 'string', description: 'ID de nueva planta destino (de search_plants). Opcional.' },
        truckId: { type: 'string', description: 'ID de camión propio a asignar (de list_trucks). Opcional.' },
        driverId: { type: 'string', description: 'ID del chofer (de list_drivers). Opcional. Usar "self" para "yo soy el chofer".' },
      },
      required: ['code'],
    },
  },
  {
    name: 'duplicate_freight',
    description: 'Duplica un flete existente con una nueva fecha de carga. Copia grano, toneladas, origen, destino y notas. Solo productores. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete original, ej: F26-LCP.1822' },
        loadDate: { type: 'string', description: 'Fecha de carga para el nuevo flete (YYYY-MM-DD)' },
        loadTime: { type: 'string', description: 'Hora de carga (HH:mm). Si no se indica, se copia del original.' },
      },
      required: ['code', 'loadDate'],
    },
  },
  {
    name: 'list_documents',
    description: 'Lista los documentos adjuntos de un flete (fotos, carta de porte, etc). Retorna datos en texto, NO menú interactivo.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'freight_history',
    description: 'Muestra el historial completo de un flete: quién hizo qué y cuándo (creación, asignaciones, cambios de estado, cancelaciones). Retorna datos en texto.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  { name: 'get_dashboard', description: 'Resumen ejecutivo de la empresa: fletes por estado, toneladas del mes, completados vs cancelados. Usar cuando el usuario pide "cómo estamos", "resumen general", "dashboard", "estado de la empresa".', input_schema: { type: 'object' as const, properties: {}, required: [] } },
  {
    name: 'update_field',
    description: 'Modifica un campo existente (dirección y ubicación). Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        fieldName: { type: 'string', description: 'Nombre del campo a modificar' },
        address: { type: 'string', description: 'Nueva dirección. Opcional.' },
        lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
        lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
      },
      required: ['fieldName'],
    },
  },
  {
    name: 'update_lot',
    description: 'Modifica un lote existente (hectáreas y ubicación). Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        lotName: { type: 'string', description: 'Nombre del lote a modificar' },
        hectares: { type: 'number', description: 'Nuevas hectáreas. Opcional.' },
        lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
        lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
      },
      required: ['lotName'],
    },
  },
  {
    name: 'reactivate_user',
    description: 'Reactiva un usuario previamente desactivado de la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { userIdentifier: { type: 'string', description: 'Nombre o email del usuario a reactivar' } },
      required: ['userIdentifier'],
    },
  },
  {
    name: 'authorize_freight',
    description: 'Autoriza un flete con flota propia. Solo plantas. Solo en estado assigned. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: { code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' } },
      required: ['code'],
    },
  },
  {
    name: 'approve_pending_change',
    description: 'Aprueba un cambio pendiente en un flete (cambio de planta destino o flota propia). Solo la empresa aprobadora puede hacerlo. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        changeId: { type: 'string', description: 'ID del cambio pendiente. Si no se indica, se usa el primer cambio pendiente del flete.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'reject_pending_change',
    description: 'Rechaza un cambio pendiente en un flete. Solo la empresa aprobadora puede hacerlo. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        changeId: { type: 'string', description: 'ID del cambio pendiente. Si no se indica, se usa el primer cambio pendiente del flete.' },
        reason: { type: 'string', description: 'Motivo del rechazo. Opcional.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'respond_trip',
    description: 'Acepta o rechaza un viaje/asignación específica de un flete multi-camión. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        action: { type: 'string', enum: ['accepted', 'rejected'], description: 'Aceptar o rechazar' },
        reason: { type: 'string', description: 'Motivo del rechazo. Requerido si action=rejected.' },
      },
      required: ['code', 'action'],
    },
  },
  {
    name: 'start_trip',
    description: 'Inicia un viaje específico de un flete. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_loaded',
    description: 'Confirma la carga de un viaje específico. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        loadedTons: { type: 'number', description: 'Toneladas reales cargadas. Opcional.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'confirm_trip_finished',
    description: 'Confirma la entrega de un viaje específico. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'cancel_assignment',
    description: 'Cancela una asignación de camión específica en un flete multi-camión. Solo plantas. Requiere motivo. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        reason: { type: 'string', description: 'Motivo de la cancelación.' },
      },
      required: ['code', 'reason'],
    },
  },
  {
    name: 'update_assignment',
    description: 'Edita una asignación existente (cambiar transportista, camión, chofer o toneladas). Solo plantas. Solo viajes pendientes o aceptados. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        assignmentId: { type: 'string', description: 'ID de la asignación. Opcional si hay un solo viaje.' },
        transporterCompanyId: { type: 'string', description: 'Nuevo transportista (de list_transporters). Opcional.' },
        truckId: { type: 'string', description: 'Nuevo camión (de list_trucks). Opcional.' },
        driverId: { type: 'string', description: 'Nuevo chofer (de list_drivers). Opcional.' },
        tons: { type: 'number', description: 'Nuevas toneladas asignadas. Opcional.' },
      },
      required: ['code'],
    },
  },
  {
    name: 'create_driver',
    description: 'Registra un nuevo chofer para la empresa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre completo del chofer' },
        phone: { type: 'string', description: 'Teléfono del chofer (09XXXXXXX). Opcional.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_profile',
    description: 'Modifica el perfil del usuario actual (nombre, email, teléfono). Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre. Opcional.' },
        email: { type: 'string', description: 'Nuevo email. Opcional.' },
        phone: { type: 'string', description: 'Nuevo teléfono (09XXXXXXX). Opcional.' },
      },
      required: [],
    },
  },
  {
    name: 'generate_batch_report_link',
    description: 'Genera un enlace a la pantalla de reportes de la web con filtros pre-aplicados. El usuario puede descargar PDF o Excel desde ahí.',
    input_schema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filtro de estado: all, solicitado, en_curso, finalizados, cancelados. Opcional.' },
        dateFrom: { type: 'string', description: 'Fecha desde (YYYY-MM-DD). Opcional.' },
        dateTo: { type: 'string', description: 'Fecha hasta (YYYY-MM-DD). Opcional.' },
      },
      required: [],
    },
  },
  {
    name: 'ocr_analyze',
    description: 'Analiza una imagen de documento (carta de porte, remito, ticket de pesaje) y extrae datos estructurados usando OCR. Útil cuando el usuario envía una foto de un documento y quiere extraer la información. Requiere la URL del documento previamente subido.',
    input_schema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'URL pública de la imagen en Supabase Storage' },
        docType: {
          type: 'string',
          enum: ['carta_porte', 'remito', 'pesaje', 'general'],
          description: 'Tipo de documento. Si no se sabe, usar "general" para detección automática.',
        },
      },
      required: ['url'],
    },
  },

  // ======================== NEW TOOLS — Admin & Management ========================

  // --- Documents ---
  {
    name: 'delete_document',
    description: 'Elimina un documento/foto adjunto a un flete. Requiere código del flete y el ID del documento (obtenido de list_documents). Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete, ej: F26-LCP.1822' },
        documentId: { type: 'string', description: 'ID del documento a eliminar (UUID obtenido de list_documents)' },
      },
      required: ['code', 'documentId'],
    },
  },
  {
    name: 'save_ocr_data',
    description: 'Guarda los datos extraídos por OCR en un documento de flete. Usar después de ocr_analyze cuando el usuario confirma que los datos son correctos. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        code: { type: 'string', description: 'Código del flete' },
        documentId: { type: 'string', description: 'ID del documento (UUID)' },
        ocrData: { type: 'object', description: 'Datos OCR estructurados (resultado de ocr_analyze)' },
      },
      required: ['code', 'documentId', 'ocrData'],
    },
  },

  // --- Trucks & Drivers ---
  {
    name: 'deactivate_truck',
    description: 'Desactiva un camión de la flota. No se puede si tiene viajes activos. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'ID del camión (UUID, obtenido de list_trucks)' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'update_truck',
    description: 'Edita los datos de un camión (patente, marca, modelo, capacidad). Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        truckId: { type: 'string', description: 'ID del camión (UUID)' },
        plate: { type: 'string', description: 'Nueva patente (se normaliza a mayúsculas). Opcional.' },
        brand: { type: 'string', description: 'Marca del camión. Opcional.' },
        model: { type: 'string', description: 'Modelo del camión. Opcional.' },
        capacity: { type: 'number', description: 'Capacidad en toneladas. Opcional.' },
      },
      required: ['truckId'],
    },
  },
  {
    name: 'deactivate_driver',
    description: 'Desactiva un chofer de la empresa. No se puede si tiene viajes activos. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'ID del chofer (UUID, obtenido de list_drivers)' },
      },
      required: ['driverId'],
    },
  },

  // --- Plant Access ---
  {
    name: 'list_enabled_plants',
    description: 'Lista las plantas habilitadas para el productor. Muestra qué plantas puede usar como destino de fletes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_enabled_producers',
    description: 'Lista los productores habilitados en la planta. Solo plantas. Muestra qué productores pueden enviar fletes.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'grant_producer_access',
    description: 'Habilita un productor para operar con la planta. Solo plantas y admin. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        producerCompanyId: { type: 'string', description: 'ID de la empresa productora (UUID). Usar search_plants para buscar.' },
        producerUserId: { type: 'string', description: 'ID del usuario productor específico (opcional, si no se indica se habilita toda la empresa).' },
      },
      required: ['producerCompanyId'],
    },
  },
  {
    name: 'revoke_producer_access',
    description: 'Revoca el acceso de un productor a la planta. Solo plantas y admin. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        accessId: { type: 'string', description: 'ID del registro de acceso (UUID, obtenido de list_enabled_producers)' },
      },
      required: ['accessId'],
    },
  },

  // --- Branches ---
  {
    name: 'list_branches',
    description: 'Lista las sucursales de la empresa activa. Muestra nombre, dirección y referencia.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_branch',
    description: 'Crea una sucursal para la empresa activa. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nombre de la sucursal' },
        address: { type: 'string', description: 'Dirección. Opcional.' },
        reference: { type: 'string', description: 'Referencia (ej: "Ruta 2 km 135"). Opcional.' },
        lat: { type: 'number', description: 'Latitud. Opcional (usar generate_location_link para obtener).' },
        lng: { type: 'number', description: 'Longitud. Opcional.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_branch',
    description: 'Edita una sucursal existente. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'ID de la sucursal (UUID, obtenido de list_branches)' },
        name: { type: 'string', description: 'Nuevo nombre. Opcional.' },
        address: { type: 'string', description: 'Nueva dirección. Opcional.' },
        reference: { type: 'string', description: 'Nueva referencia. Opcional.' },
        lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
        lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
      },
      required: ['branchId'],
    },
  },
  {
    name: 'delete_branch',
    description: 'Desactiva una sucursal. Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        branchId: { type: 'string', description: 'ID de la sucursal (UUID)' },
      },
      required: ['branchId'],
    },
  },

  // --- Company & User Admin ---
  {
    name: 'update_company',
    description: 'Edita datos de la empresa activa (nombre, dirección, teléfono, email, ubicación). Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Nuevo nombre. Opcional.' },
        address: { type: 'string', description: 'Nueva dirección. Opcional.' },
        phone: { type: 'string', description: 'Nuevo teléfono. Opcional.' },
        email: { type: 'string', description: 'Nuevo email. Opcional.' },
        lat: { type: 'number', description: 'Nueva latitud. Opcional.' },
        lng: { type: 'number', description: 'Nueva longitud. Opcional.' },
      },
      required: [],
    },
  },
  {
    name: 'update_user_admin',
    description: 'Edita un usuario de la empresa (nombre, email, teléfono, rol, estado activo). Solo admin/gerente. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        userId: { type: 'string', description: 'ID del usuario (UUID, obtenido de list_company_users)' },
        name: { type: 'string', description: 'Nuevo nombre. Opcional.' },
        email: { type: 'string', description: 'Nuevo email. Opcional.' },
        phone: { type: 'string', description: 'Nuevo teléfono. Opcional.' },
        role: { type: 'string', enum: ['admin', 'operario', 'chofer'], description: 'Nuevo rol. Opcional.' },
        active: { type: 'boolean', description: 'Activar/desactivar usuario. Opcional.' },
      },
      required: ['userId'],
    },
  },

  // --- Freight Extras ---
  {
    name: 'assign_multi_trucks',
    description: 'Asigna múltiples camiones a un flete de una sola vez. Solo plantas. Cada camión requiere transporterCompanyId. Prepara la acción para confirmación.',
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
              transportCompanyId: { type: 'string', description: 'ID empresa transportista (UUID)' },
              truckId: { type: 'string', description: 'ID del camión (opcional)' },
              driverId: { type: 'string', description: 'ID del chofer (opcional)' },
              tons: { type: 'number', description: 'Toneladas para este camión (opcional)' },
            },
            required: ['transportCompanyId'],
          },
        },
      },
      required: ['code', 'trucks'],
    },
  },
  {
    name: 'view_driver_queue',
    description: 'Muestra la cola de fletes asignados a un chofer, en orden de prioridad. Útil para ver qué fletes tiene pendientes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'ID del chofer (UUID, obtenido de list_drivers)' },
      },
      required: ['driverId'],
    },
  },
  {
    name: 'reorder_driver_queue',
    description: 'Reordena la cola de fletes de un chofer. Solo plantas y admin. Enviar los IDs de fletes en el orden deseado. Prepara la acción para confirmación.',
    input_schema: {
      type: 'object' as const,
      properties: {
        driverId: { type: 'string', description: 'ID del chofer (UUID)' },
        orderedFreightIds: {
          type: 'array',
          description: 'IDs de fletes en el orden deseado',
          items: { type: 'string' },
        },
      },
      required: ['driverId', 'orderedFreightIds'],
    },
  },
];
