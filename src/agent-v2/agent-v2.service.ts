import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GeminiClient } from '../ai/core/gemini.client';
import { getActiveMembership, getScopedCompany, getScopedRole, scopeUserToSessionCompany } from '../common/user-company-scope';
import { AgentState, AgentStateSchema } from './schemas/agent-state.schema';
import { WhatsAppAgentV2Renderer } from './renderers/whatsapp.renderer';
import { AgentV2FreightTools } from './tools/freight.tools';
import { buildMainGraph } from './graphs/main.graph';
import { WhatsAppSessionCheckpointStore } from './checkpoints/whatsapp-session-checkpoint.store';
import { canAttachIncomingLocation } from './policies/location-policy';

@Injectable()
export class AgentV2Service {
  private readonly logger = new Logger(AgentV2Service.name);
  private warnedInvalidAgentMode = false;

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiClient,
    private freightTools: AgentV2FreightTools,
  ) {}

  isEnabled(): boolean {
    return this.getMode() === 'v2';
  }

  getMode(): 'legacy' | 'v2' {
    const raw = (process.env.AGENT_MODE || 'legacy').trim().toLowerCase();
    if (raw === 'legacy' || raw === 'v2') return raw;
    if (!this.warnedInvalidAgentMode) {
      this.warnedInvalidAgentMode = true;
      this.logger.warn(`[Agent Router] Invalid AGENT_MODE="${process.env.AGENT_MODE}". Falling back to legacy.`);
    }
    return 'legacy';
  }

  async chat(phone: string, userMessage: string, user: any, session: any): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    const started = Date.now();
    const scopedUser = scopeUserToSessionCompany(user, session);
    const scopedCompany = getScopedCompany(scopedUser);
    const activeMembership = getActiveMembership(scopedUser);
    const renderer = new WhatsAppAgentV2Renderer();
    const checkpointStore = new WhatsAppSessionCheckpointStore(this.prisma, this.logger);
    const checkpoint = session?.id ? await checkpointStore.load(session.id) : null;
    const prior = checkpoint?.state || ((session?.flowState as any) || {}).agentV2 || {};
    const conversationId = session?.id || phone;
    const initialState = AgentStateSchema.parse({
      channel: 'whatsapp',
      userId: user.id,
      phone,
      sessionId: session?.id,
      activeCompanyId: scopedUser.activeCompanyId || scopedUser.companyId || null,
      activeCompanyType: scopedCompany?.type || scopedCompany?.types?.[0] || null,
      activeRole: getScopedRole(scopedUser) || scopedUser.role || null,
      membershipActive: activeMembership ? activeMembership.active !== false : null,
      currentIntent: prior.currentIntent,
      currentFlow: prior.currentFlow || null,
      currentStep: prior.currentStep || null,
      awaitingSlot: prior.awaitingSlot || null,
      slots: prior.slots || {},
      originText: prior.originText || prior.slots?.origin || null,
      destinationText: prior.destinationText || prior.slots?.destination || null,
      originLocation: prior.originLocation || null,
      destinationLocation: prior.destinationLocation || null,
      pendingLocationRequest: prior.pendingLocationRequest || false,
      locationRequestToken: prior.locationRequestToken || null,
      locationRequestType: prior.locationRequestType || null,
      locationCapturedAt: prior.locationCapturedAt || null,
      locationCapturedByUserId: prior.locationCapturedByUserId || null,
      locationCapturedForCompanyId: prior.locationCapturedForCompanyId || null,
      activeFreightCode: prior.activeFreightCode || null,
      pendingAction: prior.pendingAction || null,
      pendingConfirmation: prior.pendingConfirmation || false,
      executedActionId: prior.executedActionId || null,
      executedResult: prior.executedResult || null,
      lastUserMessage: userMessage.slice(0, 5000),
      response: undefined,
      shouldPause: false,
      shouldPersist: true,
      audit: [],
      auditTrail: prior.auditTrail || [],
      nodeHistory: prior.nodeHistory || [],
      toolCalls: prior.toolCalls || [],
      errors: prior.errors || [],
    });

    const graph = buildMainGraph(this.gemini, renderer, this.freightTools, () => scopedUser);
    this.logger.log(JSON.stringify({
      msg: 'agent_v2_start',
      mode: this.getMode(),
      conversationId,
      whatsappSessionId: session?.id,
      userId: user.id,
      companyId: scopedUser.activeCompanyId || scopedUser.companyId || null,
      intent: initialState.currentIntent || null,
      flow: initialState.currentFlow || null,
      currentStep: initialState.currentStep || null,
    }));
    const finalState = await graph.invoke(initialState) as AgentState;
    await this.persistState(session, finalState, checkpointStore);
    this.logger.log(JSON.stringify({
      msg: 'agent_v2_done',
      mode: this.getMode(),
      conversationId,
      whatsappSessionId: session?.id,
      userId: user.id,
      companyId: scopedUser.activeCompanyId || scopedUser.companyId || null,
      intent: finalState.currentIntent || null,
      flow: finalState.currentFlow || null,
      currentStep: finalState.currentStep || null,
      durationMs: Date.now() - started,
      result: finalState.shouldPause ? 'paused' : 'completed',
      confirmationRequired: finalState.pendingConfirmation || false,
    }));
    return { text: finalState.response || renderer.error() };
  }

  async handleLocation(
    phone: string,
    user: any,
    session: any,
    location: { lat: number; lng: number; label?: string },
  ): Promise<{ text: string }> {
    const renderer = new WhatsAppAgentV2Renderer();
    const checkpointStore = new WhatsAppSessionCheckpointStore(this.prisma, this.logger);
    const checkpoint = session?.id ? await checkpointStore.load(session.id) : null;
    const prior = checkpoint?.state || ((session?.flowState as any) || {}).agentV2 || {};
    if (!prior.currentFlow || prior.currentFlow !== 'create_freight' || prior.currentStep !== 'awaiting_location') {
      return { text: renderer.unexpectedLocation() };
    }
    const type = prior.locationRequestType === 'destination' ? 'destination' : 'origin';
    const captured = {
      lat: location.lat,
      lng: location.lng,
      label: location.label,
      source: 'whatsapp_location' as const,
      capturedAt: new Date().toISOString(),
      capturedByUserId: user.id,
    };
    const policy = canAttachIncomingLocation(prior as any, captured, user);
    if (!policy.allowed) {
      this.logger.warn(JSON.stringify({
        msg: 'agent_v2_location_rejected',
        whatsappSessionId: session?.id,
        userId: user.id,
        reason: policy.reason,
      }));
      return { text: 'No pude asociar esta ubicacion al flujo actual. Volve a enviarla desde esta conversacion.' };
    }
    const statePatch = {
      ...prior,
      originLocation: type === 'origin' ? captured : prior.originLocation || null,
      destinationLocation: type === 'destination' ? captured : prior.destinationLocation || null,
      pendingLocationRequest: false,
      locationRequestType: null,
      locationCapturedAt: captured.capturedAt,
      locationCapturedByUserId: user.id,
      locationCapturedForCompanyId: prior.activeCompanyId || user.activeCompanyId || user.companyId || null,
      auditTrail: [
        ...((prior.auditTrail as any[]) || []),
        { node: 'handleLocation', type, source: 'whatsapp_location', at: captured.capturedAt },
      ].slice(-200),
    };
    await this.saveCheckpointPatch(session.id, statePatch);
    return this.chat(phone, `[Ubicacion de ${type} recibida]`, user, session);
  }

  private async persistState(session: any, state: AgentState, checkpointStore?: WhatsAppSessionCheckpointStore): Promise<void> {
    if (!session?.id || state.shouldPersist === false) return;
    const store = checkpointStore || new WhatsAppSessionCheckpointStore(this.prisma, this.logger);
    await store.save(session.id, state);
  }

  private async saveCheckpointPatch(sessionId: string, agentV2: Record<string, unknown>): Promise<void> {
    const current = await this.prisma.whatsAppSession.findUnique({
      where: { id: sessionId },
      select: { flowState: true },
    });
    const flowState = (current?.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        flowState: {
          ...flowState,
          agentV2: {
            ...agentV2,
            updatedAt: new Date().toISOString(),
          },
        },
      },
    }).catch((e) => this.logger.warn(`Agent V2 state persist failed: ${e.message}`));
  }
}
