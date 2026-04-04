/**
 * Classifies messages into functional domains to load only relevant tools.
 * Reduces from ~150 tools to ~10-30 per request.
 */

export type ToolDomain =
  | 'core'
  | 'freight_create'
  | 'freight_ops'
  | 'fleet'
  | 'fields'
  | 'navigation';

export const CORE_TOOLS = new Set([
  'get_dashboard', 'list_freights', 'get_freight_detail', 'summarize_freights',
  'generate_report_link', 'generate_daily_map_link', 'switch_company',
  'get_user_profile', 'update_profile', 'confirm_action',
]);

export const DOMAIN_TOOLS: Record<Exclude<ToolDomain, 'core'>, Set<string>> = {
  freight_create: new Set([
    'search_fields', 'list_fields', 'search_lots', 'list_lots',
    'search_plants', 'prepare_freight', 'confirm_create_freight',
    'generate_location_link', 'list_enabled_plants',
  ]),
  freight_ops: new Set([
    'start_freight', 'start_trip',
    'confirm_loaded', 'confirm_trip_loaded',
    'confirm_finished', 'confirm_trip_finished',
    'cancel_freight', 'update_freight', 'duplicate_freight',
    'assign_transporter', 'assign_truck_to_freight', 'assign_truck_to_trip',
    'assign_external_truck', 'assign_mixed_trucks', 'edit_external_assignment',
    'assign_multi_trucks', 'cancel_assignment', 'update_assignment',
    'authorize_freight', 'accept_freight', 'reject_freight', 'respond_trip',
    'approve_pending_change', 'reject_pending_change',
    'list_transporters', 'list_trucks', 'list_drivers',
    'attach_document', 'delete_document', 'ocr_analyze', 'save_ocr_data',
    'freight_history', 'list_documents',
    'generate_tracking_link', 'generate_map_link', 'generate_shared_link',
    'share_live_location', 'view_live_locations', 'request_location',
    'generate_batch_report_link',
    'rename_document', 'generate_share_link_with_details',
    'get_assignment_suggestions',
  ]),
  fleet: new Set([
    'list_trucks', 'get_truck_detail', 'get_truck_documents',
    'get_expiring_documents', 'get_fleet_alerts', 'get_fleet_summary',
    'list_drivers', 'list_company_users',
    'create_truck', 'update_truck', 'deactivate_truck',
    'create_driver', 'deactivate_driver',
    'register_truck_expense', 'register_truck_income',
    'register_truck_movement', 'register_trip_data',
    'list_truck_expenses', 'list_truck_incomes', 'list_truck_movements',
    'get_truck_economic_summary',
    'attach_truck_document',
  ]),
  fields: new Set([
    'list_fields', 'search_fields', 'list_lots', 'search_lots',
    'create_field', 'update_field', 'create_lot', 'update_lot',
  ]),
  navigation: new Set([
    'navigate_app',
  ]),
};

const DOMAIN_PATTERNS: Array<{ domain: ToolDomain; patterns: RegExp[] }> = [
  {
    domain: 'freight_create',
    patterns: [
      /\b(crear|nuevo|mandar|enviar|despachar|cargar)\b.*\b(flete|carga|camion)/i,
      /\b(mand[áa]|envi[áa]|despach[áa])\b/i,
      /\bprepara(r|me)?\b/i,
      /\b(repet[ií]|lo mismo|igual que antes|como el [úu]ltimo)\b/i,
      /\b\d+\s*(t|ton|tonelada)\b/i,
      /\b(soja|ma[ií]z|trigo|girasol|sorgo|cebada)\b/i,
    ],
  },
  {
    domain: 'freight_ops',
    patterns: [
      /\b(cancelar?|cancel[áa])\b/i,
      /\b(asigna[r]?|asign[áa]|autoriza[r]?)\b/i,
      /\b(inici[áa]|sal[ií]|empez[áa])\b.*\b(viaje|flete)\b/i,
      /\b(ya cargu[ée]|ya llegu[ée]|confirm[áa])\b/i,
      /\b(adjunt[áa]|foto|remito|pesaje)\b/i,
      /\bflota propia\b/i,
      /\b(externo|delegad[oa])\b/i,
      /\bF\d{2}-[A-Z]/i,
    ],
  },
  {
    domain: 'fleet',
    patterns: [
      /\b(mis camiones|mi flota|camiones|flota)\b/i,
      /\b(gasto|ingreso|gasoil|peaje|km|rendimiento)\b/i,
      /\b(registr[áa]|anot[áa])\b.*\b(gasto|ingreso|movimiento)\b/i,
      /\b(cu[áa]nto gast[ée]|cu[áa]nto me deben|resumen.*flota)\b/i,
      /\b(documentos?|papeles|vencimiento)\b.*\b(cami[oó]n|flota)\b/i,
      /\b[A-Z]{3}\s?\d{3,4}\b/,
    ],
  },
  {
    domain: 'fields',
    patterns: [
      /\b(mis campos|campos|chacras|lotes)\b/i,
      /\b(crear|nuevo)\b.*\b(campo|lote)\b/i,
    ],
  },
  {
    domain: 'navigation',
    patterns: [
      /\b(llev[áa]me|ir a|mostrar|abrir|navegar)\b/i,
    ],
  },
];

export function detectDomains(
  message: string,
  sessionState?: { activeFlow?: string; pendingAction?: any; pendingFreight?: any },
): Set<ToolDomain> {
  const domains = new Set<ToolDomain>(['core']);

  // Session state: pending freight → always load freight_create tools
  if (sessionState?.pendingFreight || sessionState?.activeFlow === 'create_freight') {
    domains.add('freight_create');
  }
  if (sessionState?.pendingAction) {
    domains.add('freight_ops');
  }

  // Interactive replies related to freight creation (truck selection, confirmations)
  if (/ownfleet_truck:|ai_confirm|confirm_freight|seleccione.*cami[oó]n/i.test(message)) {
    domains.add('freight_create');
    domains.add('fleet');
  }

  // Short confirmations during active flows — keep current domains
  if (/^(si|sí|dale|va|ok|confirmar?|confirmo|externo|propio|delegado)\s*[.!]*$/i.test(message)) {
    if (sessionState?.pendingFreight) {
      domains.add('freight_create');
    }
    if (sessionState?.pendingAction) {
      domains.add('freight_ops');
    }
  }

  for (const { domain, patterns } of DOMAIN_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        domains.add(domain);
        break;
      }
    }
  }

  // Fallback: if only core detected, add freight_ops for ambiguous queries
  if (domains.size === 1) {
    domains.add('freight_ops');
  }

  return domains;
}

export function getToolNamesForDomains(domains: Set<ToolDomain>): Set<string> {
  const allowed = new Set<string>(CORE_TOOLS);
  for (const domain of domains) {
    if (domain !== 'core' && DOMAIN_TOOLS[domain]) {
      for (const tool of DOMAIN_TOOLS[domain]) allowed.add(tool);
    }
  }
  if (domains.size > 1) {
    for (const tool of DOMAIN_TOOLS.navigation) allowed.add(tool);
  }
  return allowed;
}
