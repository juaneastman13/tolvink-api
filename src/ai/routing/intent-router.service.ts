import { Injectable } from '@nestjs/common';
import { MODEL_ID, MODEL_ID_FAST } from '../ai.constants';
import { resolveActiveRole, hasType } from '../ai.utils';
import { AI_TOOL_DEFINITIONS } from '../ai-tool-definitions';

@Injectable()
export class IntentRouterService {

  private readonly tools = AI_TOOL_DEFINITIONS;

  // ======================== TOOL SETS BY ROLE ========================

  private static readonly CORE_TOOLS = new Set([
    'confirm_action', 'confirm_create_freight', 'list_freights', 'get_freight_detail',
    'summarize_freights', 'update_profile', 'get_user_profile',
  ]);

  private static readonly CHOFER_TOOLS = new Set([
    'start_freight', 'confirm_loaded',
    'confirm_finished', 'get_freight_detail', 'list_freights', 'generate_tracking_link',
    'share_live_location', 'view_live_locations', 'request_location', 'confirm_action',
    'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
    'update_profile', 'ocr_analyze',
  ]);

  private static readonly PRODUCER_TOOLS = new Set([
    'prepare_freight', 'list_lots', 'list_fields', 'search_fields', 'search_lots',
    'create_field', 'create_lot',
    'search_plants', 'list_trucks', 'create_truck', 'generate_location_link',
    'duplicate_freight', 'update_field', 'update_lot', 'cancel_freight',
    'list_enabled_plants', 'assign_truck_to_freight', 'cancel_assignment',
    'list_drivers',
  ]);

  private static readonly PLANT_TOOLS = new Set([
    'search_plants', 'list_transporters', 'assign_transporter', 'assign_truck_to_trip',
    'assign_truck_to_freight', 'list_trucks', 'list_drivers', 'authorize_freight',
    'cancel_assignment', 'update_assignment', 'cancel_freight',
    'assign_multi_trucks', 'view_driver_queue', 'reorder_driver_queue',
    'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
    'get_assignment_suggestions',
  ]);

  private static readonly TRANSPORTER_TOOLS = new Set([
    'reject_freight', 'start_freight', 'confirm_loaded',
    'confirm_finished', 'start_trip', 'confirm_trip_loaded',
    'confirm_trip_finished', 'list_trucks', 'list_drivers',
    'deactivate_truck', 'deactivate_driver',
    'update_assignment', 'assign_truck_to_freight', 'assign_truck_to_trip',
  ]);

  private static readonly TRACKING_TOOLS = new Set([
    'generate_tracking_link', 'generate_map_link', 'generate_report_link',
    'generate_shared_link', 'generate_daily_map_link', 'share_live_location',
    'view_live_locations', 'request_location',
  ]);

  private static readonly ANALYTICS_TOOLS = new Set([
    'get_dashboard', 'list_documents', 'freight_history', 'update_freight',
    'attach_document', 'ocr_analyze', 'generate_batch_report_link',
    'delete_document', 'save_ocr_data',
  ]);

  private static readonly ADMIN_TOOLS = new Set([
    'create_user', 'update_user_role', 'deactivate_user', 'reactivate_user',
    'list_company_users', 'list_drivers', 'create_driver',
    'update_truck', 'deactivate_truck', 'deactivate_driver',
    'list_branches', 'create_branch', 'update_branch', 'delete_branch',
    'update_company', 'update_user_admin',
  ]);

  private static readonly FLEET_ECONOMICS_TOOLS = new Set([
    'get_truck_detail', 'get_truck_documents', 'get_expiring_documents',
    'register_truck_expense', 'list_truck_expenses',
    'register_truck_income', 'list_truck_incomes',
    'register_truck_movement', 'list_truck_movements',
    'register_trip_data', 'get_truck_economic_summary',
    'get_fleet_summary', 'get_fleet_alerts',
    'attach_truck_document',
  ]);

  private static readonly MULTI_COMPANY_TOOLS = new Set(['switch_company']);
  private static readonly PENDING_CHANGE_TOOLS = new Set(['approve_pending_change', 'reject_pending_change']);

  // ======================== MODEL SELECTION ========================

  /** Classify message complexity to pick the right model.
   *  Simple queries → Haiku (faster). Complex queries → Sonnet (smarter). */
  selectModel(message: string, hasHistory: boolean): string {
    const lower = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const simplePatterns = [
      /^(hola|buenas|buen dia|buenos dias|hey|che)\b/,
      /^(si|no|ok|dale|listo|perfecto|gracias|confirmo|cancelo)\b/,
      /\b(estado|status)\b.{0,20}\b(flete|flt)/,
      /^(mis fletes|fletes pendientes|pendientes)/,
      /^(resumen del dia|resumen diario)/,
      /\b(como (van|estan|esta)|que hay de nuevo)\b/,
    ];
    const complexPatterns = [
      /\b(crear|creat|nuevo flete|solicitar|agendar)\b/,
      /\b(analiz|compar|recomiend|optimiz|reporte detallado)\b/,
      /\b(cambiar empresa|switch|modificar)\b/,
      /\b(adjunt|document|archivo)\b/,
    ];
    if (complexPatterns.some(p => p.test(lower))) return MODEL_ID;
    if (!hasHistory && simplePatterns.some(p => p.test(lower))) return MODEL_ID_FAST;
    if (message.length < 40 && simplePatterns.some(p => p.test(lower))) return MODEL_ID_FAST;
    return MODEL_ID;
  }

  // ======================== TOOL FILTERING ========================

  /** Filter available tools based on user role, company type, and channel. */
  getFilteredTools(user: any, companyType: string, isWeb = false): any[] {
    const { isChofer, isAdmin } = resolveActiveRole(user);
    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const hasMultiCompany = activeMemberships.length > 1;

    if (isChofer && !isAdmin) {
      return this.tools.filter(t => IntentRouterService.CHOFER_TOOLS.has(t.name));
    }

    const allowed = new Set<string>(IntentRouterService.CORE_TOOLS);
    for (const t of IntentRouterService.TRACKING_TOOLS) allowed.add(t);
    for (const t of IntentRouterService.ANALYTICS_TOOLS) allowed.add(t);

    if (hasType(companyType, 'producer')) {
      for (const t of IntentRouterService.PRODUCER_TOOLS) allowed.add(t);
    }
    if (hasType(companyType, 'plant')) {
      for (const t of IntentRouterService.PLANT_TOOLS) allowed.add(t);
      for (const t of IntentRouterService.PENDING_CHANGE_TOOLS) allowed.add(t);
    }
    if (hasType(companyType, 'transporter')) {
      for (const t of IntentRouterService.TRANSPORTER_TOOLS) allowed.add(t);
    }
    if (isAdmin) {
      for (const t of IntentRouterService.ADMIN_TOOLS) allowed.add(t);
    }
    // Fleet economics — available to all non-chofer users (transporters manage fleet, producers/plants may have own fleet)
    for (const t of IntentRouterService.FLEET_ECONOMICS_TOOLS) allowed.add(t);
    if (hasMultiCompany) {
      for (const t of IntentRouterService.MULTI_COMPANY_TOOLS) allowed.add(t);
    }
    if (isWeb) allowed.add('navigate_app');

    return this.tools.filter(t => allowed.has(t.name));
  }

  // ======================== MESSAGE PREPROCESSING ========================

  private static readonly NUMBER_WORDS: Record<string, string> = {
    cero:'0',uno:'1',una:'1',dos:'2',tres:'3',cuatro:'4',cinco:'5',
    seis:'6',siete:'7',ocho:'8',nueve:'9',diez:'10',
    once:'11',doce:'12',trece:'13',catorce:'14',quince:'15',
    veinte:'20',veintiuno:'21',veintidos:'22',veinticinco:'25',
    treinta:'30',cuarenta:'40',cincuenta:'50',sesenta:'60',
    setenta:'70',ochenta:'80',noventa:'90',cien:'100',
  };

  /** Normalize spoken Spanish numbers and compound expressions in text. */
  normalizeSpokenNumbers(text: string): string {
    let result = text;
    // Replace standalone number words
    for (const [word, num] of Object.entries(IntentRouterService.NUMBER_WORDS)) {
      result = result.replace(new RegExp(`\\b${word}\\b`, 'gi'), num);
    }
    // "X y cinco/tres/etc" → X+N (e.g., "30 y 5" → "35")
    result = result.replace(/\b(\d+)\s+y\s+(\d+)\b/g, (_, a, b) => String(Number(a) + Number(b)));
    // Fractions: "X y medio/a" → X.5, "media tonelada" → 0.5 toneladas
    result = result.replace(/\b(\d+)\s+y\s+medi[oa]\b/gi, (_, n) => String(Number(n) + 0.5));
    result = result.replace(/\btonelada\s+y\s+media\b/gi, '1.5 toneladas');
    result = result.replace(/\bmedia\s+tonelada\b/gi, '0.5 toneladas');
    // "X y pico" → X (drop the "pico")
    result = result.replace(/\b(\d+)\s+y\s+pico\b/gi, '$1');
    return result;
  }
}
