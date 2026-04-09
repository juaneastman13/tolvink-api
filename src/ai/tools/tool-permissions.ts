// =====================================================================
// TOLVINK — Tool permission filtering by role and company type
// =====================================================================

import { hasType, resolveActiveRole } from '../utils/ai-utils';

/** Tools blocked for CONSULTA (READONLY) users. */
export const CONSULTA_BLOCKED_TOOLS = new Set([
  'prepare_freight', 'confirm_create_freight', 'confirm_action',
  'accept_freight', 'reject_freight',
  'start_freight', 'confirm_loaded', 'confirm_finished',
  'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished', 'respond_trip',
  'cancel_freight', 'assign_transporter', 'assign_truck_to_freight', 'assign_truck_to_trip',
  'update_assignment', 'cancel_assignment',
  'update_freight', 'duplicate_freight', 'authorize_freight',
  'attach_document', 'delete_document',
  'assign_external_truck', 'edit_external_assignment',
]);

/** Read-only tools — safe to execute in parallel. */
export const READ_ONLY_TOOLS = new Set([
  'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
  'search_fields', 'search_lots', 'get_user_profile',
  'list_transporters', 'list_trucks', 'list_drivers', 'summarize_freights',
  'list_documents', 'freight_history', 'get_dashboard',
  'generate_tracking_link', 'generate_report_link',
]);

/** Tools that track completed actions in context. */
export const ACTION_TOOLS = new Set([
  'confirm_action', 'confirm_create_freight', 'accept_freight', 'reject_freight',
  'start_freight', 'confirm_loaded', 'confirm_finished', 'cancel_freight',
  'assign_transporter', 'authorize_freight', 'update_freight', 'duplicate_freight',
  'assign_external_truck', 'edit_external_assignment',
]);

/** Tools that track search filters. */
export const SEARCH_TOOLS = new Set([
  'list_freights', 'summarize_freights',
]);

// Chofer-only tools (limited set)
const CHOFER_TOOLS = new Set([
  'list_freights', 'get_freight_detail', 'summarize_freights', 'get_dashboard',
  'freight_history', 'list_documents',
  'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded', 'confirm_finished',
  'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
  'confirm_action', 'confirm_create_freight',
  'get_user_profile', 'update_profile',
  'generate_tracking_link', 'generate_report_link',
  'share_live_location', 'view_live_locations',
  'attach_document',
]);

// Additional tools unlocked for autonomous drivers (chofer + autonomousDriverEnabled)
const AUTONOMOUS_DRIVER_EXTRA_TOOLS = new Set([
  'prepare_autonomous_freight',
  'finish_autonomous_freight',
  'register_plant_arrival',
  'cancel_freight',
  'search_fields', 'search_lots', 'search_plants',
  'list_fields', 'list_lots',
]);

// Plant-only tools
const PLANT_ONLY = new Set([
  'authorize_freight', 'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
]);

// Producer-only tools
const PRODUCER_ONLY = new Set([
  'search_plants', 'list_fields', 'list_lots', 'search_fields', 'search_lots',
  'list_enabled_plants',
]);

// Transport tools (available to plant, transporter, or own-fleet companies)
const TRANSPORT_TOOLS_SET = new Set([
  'list_trucks', 'list_drivers',
  'list_transporters', 'assign_transporter', 'assign_truck_to_trip', 'assign_truck_to_freight',
  'cancel_assignment', 'update_assignment',
  'assign_external_truck', 'edit_external_assignment',
]);

/** Filter tool definitions based on user role and company type. */
export function filterToolsByRole(
  allTools: any[],
  user: any,
  companyType: string,
  isWeb: boolean,
): any[] {
  const { isChofer, isAdmin } = resolveActiveRole(user);
  const isProducer = hasType(companyType, 'producer');
  const isPlant = hasType(companyType, 'plant');
  const isTransporter = hasType(companyType, 'transporter');

  // Determine if user has own fleet
  const activeCoId = user.activeCompanyId || user.companyId;
  const activeMem = (user.memberships || []).find((m: any) => m.companyId === activeCoId);
  const hasOwnFleet = !!(activeMem?.company?.hasInternalFleet || user.company?.hasInternalFleet);

  // Check if autonomous driver (chofer + company has autonomousDriverEnabled)
  const isAutonomousDriver = isChofer &&
    !!(activeMem?.company?.autonomousDriverEnabled || user.company?.autonomousDriverEnabled);

  return allTools.filter(tool => {
    const name = tool.name;

    // Chofer: limited set + autonomous extras if enabled
    if (isChofer) {
      if (CHOFER_TOOLS.has(name)) return true;
      if (isAutonomousDriver && AUTONOMOUS_DRIVER_EXTRA_TOOLS.has(name)) return true;
      return false;
    }

    // Role-based filtering
    if (PLANT_ONLY.has(name) && !isPlant) return false;
    if (PRODUCER_ONLY.has(name) && !isProducer) return false;
    if (TRANSPORT_TOOLS_SET.has(name) && !isPlant && !isTransporter && !hasOwnFleet) return false;

    return true;
  });
}
