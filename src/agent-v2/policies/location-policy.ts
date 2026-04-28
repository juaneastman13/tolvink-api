import { AgentLocation, AgentState } from '../schemas/agent-state.schema';

export function shouldUseFreightMapLink(activeFreightCode?: string | null): boolean {
  return !!activeFreightCode;
}

export type LocationPolicyResult = {
  allowed: boolean;
  reason?: string;
};

export function canAttachIncomingLocation(
  state: Partial<AgentState>,
  location: Pick<AgentLocation, 'lat' | 'lng' | 'capturedByUserId'>,
  user: { id?: string; activeCompanyId?: string | null; companyId?: string | null },
): LocationPolicyResult {
  if (!state.pendingLocationRequest && state.currentStep !== 'awaiting_location') {
    return { allowed: false, reason: 'no_pending_location_request' };
  }
  if (!state.locationRequestType) {
    return { allowed: false, reason: 'missing_location_request_type' };
  }
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return { allowed: false, reason: 'invalid_coordinates' };
  }
  if (location.capturedByUserId && user.id && location.capturedByUserId !== user.id) {
    return { allowed: false, reason: 'wrong_user' };
  }
  const activeCompanyId = user.activeCompanyId || user.companyId || null;
  const expectedCompanyId = state.activeCompanyId || state.locationCapturedForCompanyId || null;
  if (expectedCompanyId && activeCompanyId && expectedCompanyId !== activeCompanyId) {
    return { allowed: false, reason: 'wrong_company' };
  }
  return { allowed: true };
}
