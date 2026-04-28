import { ACTION_CATALOG } from '../catalogs/actions.catalog';
import { AgentActionName } from '../schemas/action.schema';

export function requiresExplicitConfirmation(action: AgentActionName): boolean {
  const entry = ACTION_CATALOG[action];
  return !!entry?.mutates || !!entry?.sensitive;
}

