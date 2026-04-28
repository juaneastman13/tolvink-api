import { AgentActionName } from '../schemas/action.schema';

const ALLOWED_BY_STATUS: Partial<Record<AgentActionName, string[]>> = {
  update_freight: ['draft', 'pending_assignment', 'assigned', 'accepted'],
  cancel_freight: ['draft', 'pending_assignment', 'assigned', 'accepted', 'in_progress'],
  assign_transport_company: ['pending_assignment', 'assigned'],
  assign_driver_and_truck: ['assigned', 'accepted'],
  confirm_loaded: ['in_progress', 'accepted'],
  finish_freight: ['loaded', 'in_progress'],
};

export function isFreightStatusAllowed(action: AgentActionName, status?: string | null): boolean {
  const allowed = ALLOWED_BY_STATUS[action];
  if (!allowed || !status) return true;
  return allowed.includes(status);
}

