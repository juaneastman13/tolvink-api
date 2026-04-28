import { AgentActionName } from '../schemas/action.schema';

export type AgentRoleContext = {
  activeRole?: string | null;
  companyType?: string | null;
};

const ACTIONS_BY_ROLE: Record<string, AgentActionName[]> = {
  gerente: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  admin: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  platform_admin: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  operador: ['create_freight', 'update_freight', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  chofer: ['confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
};

export function canRolePerformAction(ctx: AgentRoleContext, action: AgentActionName): boolean {
  const role = (ctx.activeRole || 'operador').toLowerCase();
  return (ACTIONS_BY_ROLE[role] || ACTIONS_BY_ROLE.operador).includes(action);
}

