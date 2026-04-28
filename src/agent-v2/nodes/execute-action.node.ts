import { AgentV2FreightTools } from '../tools/freight.tools';
import { WhatsAppAgentV2Renderer } from '../renderers/whatsapp.renderer';
import { AgentState } from '../schemas/agent-state.schema';
import { CreateFreightSlotsSchema } from '../schemas/freight.schema';

export function makeExecuteActionNode(
  freightTools: AgentV2FreightTools,
  renderer: WhatsAppAgentV2Renderer,
  userProvider: () => any,
) {
  return async function executeActionNode(state: AgentState): Promise<Partial<AgentState>> {
    if (state.currentFlow !== 'create_freight' || state.currentStep !== 'confirmed') return {};
    if (state.pendingAction?.action !== 'create_freight') {
      return { response: renderer.error('No hay una accion de creacion pendiente.'), shouldPause: false };
    }
    const actionId = state.pendingAction.auditId || String((state.pendingAction.payload as any).actionId || '');
    if (actionId && state.executedActionId === actionId && state.executedResult) {
      return {
        currentFlow: null,
        currentStep: null,
        pendingAction: null,
        pendingConfirmation: false,
        response: state.executedResult.realExecution
          ? renderer.created(String(state.executedResult.code || ''))
          : renderer.prepared(String(state.executedResult.code || '')),
        shouldPause: false,
        auditTrail: [{ node: 'executeAction', action: 'create_freight', result: 'idempotent_replay', at: new Date().toISOString() }],
      };
    }
    const slots = CreateFreightSlotsSchema.parse(state.pendingAction.payload);
    const result = await freightTools.createFreightRequest({
      ...slots,
      originLocation: state.originLocation || (state.pendingAction.payload as any).originLocation || null,
      destinationLocation: state.destinationLocation || (state.pendingAction.payload as any).destinationLocation || null,
      idempotencyKey: (state.pendingAction.payload as any).idempotencyKey,
    } as any, userProvider());
    const response = result.status === 'created'
      ? renderer.created(result.code)
      : result.status === 'blocked_missing_location'
        ? renderer.blockedMissingLocation()
        : renderer.prepared(result.code);
    return {
      currentFlow: null,
      currentStep: null,
      pendingAction: null,
      pendingConfirmation: false,
      pendingLocationRequest: false,
      locationRequestType: null,
      response,
      shouldPause: false,
      executedActionId: actionId || null,
      executedResult: result as unknown as Record<string, unknown>,
      audit: [...(state.audit || []), { node: 'executeAction', action: 'create_freight', status: result.status, at: new Date().toISOString() }],
      auditTrail: [{ node: 'executeAction', action: 'create_freight', status: result.status, at: new Date().toISOString() }],
      toolCalls: [{ tool: 'createFreightRequest', status: result.status, durationMs: result.durationMs || null, at: new Date().toISOString() }],
      nodeHistory: [{ node: 'executeAction', at: new Date().toISOString() }],
    };
  };
}
