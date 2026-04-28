import { AgentState } from '../schemas/agent-state.schema';
import { AgentActionName } from '../schemas/action.schema';
import { canRolePerformAction } from './role-policy';
import { requiresExplicitConfirmation } from './confirmation-policy';

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
};

export function checkActionPolicy(state: AgentState, action: AgentActionName): PolicyDecision {
  if (!state.activeCompanyId) {
    return {
      allowed: false,
      reason: 'Necesito que selecciones la empresa con la que queres operar.',
      requiresConfirmation: false,
    };
  }
  if (!canRolePerformAction({ activeRole: state.activeRole }, action)) {
    return {
      allowed: false,
      reason: 'Tu rol no tiene permisos para realizar esa accion por WhatsApp.',
      requiresConfirmation: false,
    };
  }
  return {
    allowed: true,
    requiresConfirmation: requiresExplicitConfirmation(action),
  };
}

