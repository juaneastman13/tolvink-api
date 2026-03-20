// =====================================================================
// TOLVINK — AI Tool Definitions (Organized by Domain)
// Re-exports from the master definitions file, categorized for readability.
// The master file ai-tool-definitions.ts remains the single source of truth.
// =====================================================================

import { AI_TOOL_DEFINITIONS, AiToolDefinition } from '../../ai-tool-definitions';

// Helper to pick tools by name
const pick = (names: string[]): AiToolDefinition[] =>
  names.map(n => AI_TOOL_DEFINITIONS.find(t => t.name === n)!).filter(Boolean);

// ======================== FREIGHT QUERIES ========================
export const FREIGHT_QUERY_TOOLS = pick([
  'list_freights', 'get_freight_detail', 'summarize_freights',
  'get_dashboard', 'freight_history',
]);

// ======================== FREIGHT CREATION & MUTATION ========================
export const FREIGHT_MUTATION_TOOLS = pick([
  'prepare_freight', 'confirm_create_freight', 'duplicate_freight',
  'update_freight', 'confirm_action',
]);

// ======================== FREIGHT ACTIONS (STATE CHANGES) ========================
export const FREIGHT_ACTION_TOOLS = pick([
  'accept_freight', 'reject_freight', 'start_freight',
  'confirm_loaded', 'confirm_finished', 'cancel_freight',
  'authorize_freight',
]);

// ======================== MULTI-TRUCK TRIPS ========================
export const TRIP_TOOLS = pick([
  'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
]);

// ======================== TRANSPORT & ASSIGNMENT ========================
export const TRANSPORT_TOOLS = pick([
  'list_transporters', 'assign_transporter', 'assign_truck_to_trip',
  'assign_truck_to_freight', 'assign_multi_trucks',
  'cancel_assignment', 'update_assignment',
]);

// ======================== CHANGE APPROVALS ========================
export const CHANGE_APPROVAL_TOOLS = pick([
  'approve_pending_change', 'reject_pending_change',
]);

// ======================== FIELDS & LOTS ========================
export const FIELD_TOOLS = pick([
  'search_plants', 'list_fields', 'list_lots', 'search_fields', 'search_lots',
  'create_field', 'create_lot', 'update_field', 'update_lot',
]);

// ======================== TRUCKS & DRIVERS ========================
export const TRUCK_TOOLS = pick([
  'list_trucks', 'create_truck', 'update_truck', 'deactivate_truck',
  'list_drivers', 'create_driver', 'deactivate_driver',
  'view_driver_queue', 'reorder_driver_queue',
]);

// ======================== DOCUMENTS & OCR ========================
export const DOCUMENT_TOOLS = pick([
  'attach_document', 'list_documents', 'delete_document',
  'ocr_analyze', 'save_ocr_data',
]);

// ======================== LOCATION & MAPS ========================
export const LOCATION_TOOLS = pick([
  'generate_location_link', 'generate_tracking_link', 'generate_map_link',
  'generate_report_link', 'generate_shared_link', 'generate_daily_map_link', 'generate_batch_report_link',
  'share_live_location', 'view_live_locations', 'request_location',
]);

// ======================== USER MANAGEMENT ========================
export const USER_TOOLS = pick([
  'list_company_users', 'create_user', 'update_user_role',
  'deactivate_user', 'reactivate_user', 'update_user_admin',
  'update_profile', 'get_user_profile',
]);

// ======================== COMPANY & ACCESS ========================
export const COMPANY_TOOLS = pick([
  'switch_company', 'update_company',
  'list_enabled_plants', 'list_enabled_producers',
  'grant_producer_access', 'revoke_producer_access',
]);

// ======================== BRANCHES ========================
export const BRANCH_TOOLS = pick([
  'list_branches', 'create_branch', 'update_branch', 'delete_branch',
]);

// ======================== NAVIGATION (WEB ONLY) ========================
export const NAVIGATION_TOOLS = pick(['navigate_app']);

// ======================== ASSIGNMENT SUGGESTIONS ========================
export const SUGGESTION_TOOLS = pick(['get_assignment_suggestions']);

// ======================== ALL TOOLS (consolidated) ========================
export { AI_TOOL_DEFINITIONS as ALL_TOOLS } from '../../ai-tool-definitions';
export type { AiToolDefinition } from '../../ai-tool-definitions';
