import { AgentState } from '../schemas/agent-state.schema';
import { PENDING_ACTION_TTL_MS } from '../schemas/action.schema';
import { isGlobalCancelMessage } from './cancel-intent';

export async function resolveConfirmationNode(state: AgentState): Promise<Partial<AgentState>> {
  const answer = normalize(state.lastUserMessage);

  // Cancel always wins — even with a stale or missing pendingAction.
  if (/^no$/.test(answer) || isGlobalCancelMessage(state.lastUserMessage)) {
    return {
      currentStep: 'cancelled',
      shouldPause: false,
    };
  }

  if (/^(si|sí|ok|dale|va|confirmo|confirmar)$/.test(answer)) {
    // Refuse to mark as confirmed when the pending context is gone or expired.
    // Without these guards, a "si" arriving after a session reset, after the
    // pending action was cancelled out-of-band, or 30+ min late would still
    // route to executeAction with a half-rebuilt payload.
    if (!state.pendingAction || state.pendingAction.action !== 'create_freight') {
      return {
        currentStep: null,
        currentFlow: null,
        pendingConfirmation: false,
        response: 'No tengo una solicitud pendiente para confirmar. Empezala de nuevo cuando quieras.',
        shouldPause: false,
      };
    }
    if (isPendingActionExpired((state.pendingAction as any).createdAt)) {
      return {
        currentStep: null,
        currentFlow: null,
        pendingAction: null,
        pendingConfirmation: false,
        response: 'La solicitud expiro. Volve a iniciarla cuando quieras.',
        shouldPause: false,
      };
    }
    return {
      currentStep: 'confirmed',
      pendingConfirmation: false,
      shouldPause: false,
    };
  }

  return {
    currentStep: 'confirmation_unclear',
    shouldPause: true,
  };
}

function normalize(value: string): string {
  return (value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function isPendingActionExpired(createdAt?: string | null): boolean {
  if (!createdAt) return false;
  const t = Date.parse(createdAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > PENDING_ACTION_TTL_MS;
}
