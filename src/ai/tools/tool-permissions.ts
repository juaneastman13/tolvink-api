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
  'assign_multi_trucks', 'update_assignment', 'cancel_assignment',
  'update_freight', 'duplicate_freight', 'authorize_freight',
  'approve_pending_change', 'reject_pending_change',
  'attach_document', 'delete_document', 'save_ocr_data',
  'create_field', 'create_lot', 'update_field', 'update_lot',
  'create_truck', 'create_driver', 'update_truck', 'deactivate_truck', 'deactivate_driver',
  'generate_location_link',
]);

/** Read-only tools — safe to execute in parallel. */
export const READ_ONLY_TOOLS = new Set([
  'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
  'search_fields', 'search_lots', 'get_user_profile',
  'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
  'list_documents', 'freight_history', 'get_dashboard',
  'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
  'get_truck_detail', 'get_truck_documents', 'get_expiring_documents', 'list_truck_expenses',
  'list_truck_incomes', 'list_truck_movements', 'get_truck_economic_summary', 'get_fleet_summary', 'get_fleet_alerts',
  'navigate_app',
]);

/** Tools that track completed actions in context. */
export const ACTION_TOOLS = new Set([
  'confirm_action', 'confirm_create_freight', 'accept_freight', 'reject_freight',
  'start_freight', 'confirm_loaded', 'confirm_finished', 'cancel_freight',
  'assign_transporter', 'authorize_freight', 'create_field', 'create_lot',
  'create_truck', 'create_user', 'update_freight', 'duplicate_freight',
  'assign_external_truck', 'assign_mixed_trucks', 'edit_external_assignment',
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
  'generate_tracking_link', 'generate_map_link', 'generate_report_link',
  'share_live_location', 'view_live_locations',
  'attach_document', 'navigate_app',
  'register_trip_data',
]);

// Additional tools unlocked for autonomous drivers (chofer + autonomousDriverEnabled)
const AUTONOMOUS_DRIVER_EXTRA_TOOLS = new Set([
  'prepare_autonomous_freight',
  'finish_autonomous_freight',
  'register_plant_arrival',
  'cancel_freight',
  'save_ocr_data',
  'search_fields', 'search_lots', 'search_plants',
]);

// Plant-only tools
const PLANT_ONLY = new Set([
  'authorize_freight', 'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
]);

// Producer-only tools
const PRODUCER_ONLY = new Set([
  'search_plants', 'list_fields', 'list_lots', 'search_fields', 'search_lots',
  'create_field', 'create_lot', 'update_field', 'update_lot',
  'list_enabled_plants',
]);

// Admin-only tools
const ADMIN_ONLY = new Set([
  'create_user', 'list_company_users', 'update_user_role', 'deactivate_user',
  'reactivate_user', 'update_user_admin', 'update_company',
  'list_branches', 'create_branch', 'update_branch', 'delete_branch',
]);

// Transport tools
const TRANSPORT_TOOLS_SET = new Set([
  'list_trucks', 'create_truck', 'update_truck', 'deactivate_truck',
  'list_drivers', 'create_driver', 'deactivate_driver',
  'view_driver_queue', 'reorder_driver_queue',
  'list_transporters', 'assign_transporter', 'assign_truck_to_trip', 'assign_truck_to_freight',
  'assign_multi_trucks', 'cancel_assignment', 'update_assignment',
  'assign_external_truck', 'assign_mixed_trucks', 'edit_external_assignment',
]);

// Fleet economics tools
const FLEET_TOOLS = new Set([
  'get_truck_detail', 'get_truck_documents', 'get_expiring_documents',
  'attach_truck_document',
  'register_truck_expense', 'list_truck_expenses',
  'register_truck_income', 'list_truck_incomes',
  'register_truck_movement', 'list_truck_movements',
  'register_trip_data', 'get_truck_economic_summary',
  'get_fleet_summary', 'get_fleet_alerts',
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
  const canManageFleet = !isChofer && (isTransporter || hasOwnFleet);

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

    // Web-only: navigate_app
    if (name === 'navigate_app' && !isWeb) return false;

    // remove escalate_to_sonnet — not needed with Gemini
    if (name === 'escalate_to_sonnet') return false;

    // Role-based filtering
    if (PLANT_ONLY.has(name) && !isPlant) return false;
    if (PRODUCER_ONLY.has(name) && !isProducer) return false;
    if (ADMIN_ONLY.has(name) && !isAdmin) return false;
    if (TRANSPORT_TOOLS_SET.has(name) && !isPlant && !isTransporter && !hasOwnFleet) return false;
    if (FLEET_TOOLS.has(name) && !canManageFleet) return false;

    return true;
  });
}
