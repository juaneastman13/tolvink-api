import { AgentActionName } from '../schemas/action.schema';

export type AgentRoleContext = {
  activeRole?: string | null;
  companyType?: string | null;
  membershipActive?: boolean | null;
};

const ACTIONS_BY_ROLE: Record<string, AgentActionName[]> = {
  gerente: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  admin: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  platform_admin: ['create_freight', 'update_freight', 'cancel_freight', 'assign_transport_company', 'assign_driver_and_truck', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  operador: ['create_freight', 'update_freight', 'confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  chofer: ['confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
  driver: ['confirm_loaded', 'confirm_arrival', 'finish_freight', 'generate_map_link', 'attach_document'],
};

export function canRolePerformAction(ctx: AgentRoleContext, action: AgentActionName): boolean {
  if (ctx.membershipActive === false) return false;
  if (action === 'create_freight' && isDriverOnlyContext(ctx)) return false;
  const role = normalizeRole(ctx.activeRole);
  return (ACTIONS_BY_ROLE[role] || ACTIONS_BY_ROLE.operador).includes(action);
}

function normalizeRole(role?: string | null): string {
  const value = (role || 'operador').toLowerCase();
  const aliases: Record<string, string> = {
    operator: 'operador',
    operations: 'operador',
    manager: 'gerente',
    owner: 'gerente',
    admin_user: 'admin',
  };
  return aliases[value] || value;
}

function isDriverOnlyContext(ctx: AgentRoleContext): boolean {
  const role = normalizeRole(ctx.activeRole);
  const companyType = (ctx.companyType || '').toLowerCase();
  return (role === 'chofer' || role === 'driver') && !['producer', 'plant', 'transporter'].includes(companyType);
}
