import { Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { AgentState } from '../schemas/agent-state.schema';
import { AgentCheckpoint, AgentCheckpointStore } from './agent-checkpoint.store';

export class WhatsAppSessionCheckpointStore implements AgentCheckpointStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: Logger,
  ) {}

  async load(threadId: string): Promise<AgentCheckpoint | null> {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: threadId },
      select: { flowState: true },
    });
    const agentV2 = ((session?.flowState as any) || {}).agentV2;
    if (!agentV2) return null;
    return {
      threadId,
      state: agentV2,
      updatedAt: agentV2.updatedAt || new Date(0).toISOString(),
    };
  }

  async save(threadId: string, state: AgentState): Promise<void> {
    const current = await this.prisma.whatsAppSession.findUnique({
      where: { id: threadId },
      select: { flowState: true },
    });
    const flowState = (current?.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: threadId },
      data: {
        flowState: {
          ...flowState,
          agentV2: toPersistedAgentState(state),
        },
      },
    }).catch((e) => this.logger.warn(`Agent V2 checkpoint save failed: ${e.message}`));
  }
}

export function toPersistedAgentState(state: AgentState): Record<string, unknown> {
  return {
    currentIntent: state.currentIntent,
    currentFlow: state.currentFlow,
    currentStep: state.currentStep,
    awaitingSlot: state.awaitingSlot,
    slots: state.slots || {},
    originText: state.originText || null,
    destinationText: state.destinationText || null,
    originLocation: state.originLocation || null,
    destinationLocation: state.destinationLocation || null,
    pendingLocationRequest: state.pendingLocationRequest || false,
    locationRequestToken: state.locationRequestToken || null,
    locationRequestType: state.locationRequestType || null,
    locationCapturedAt: state.locationCapturedAt || null,
    locationCapturedByUserId: state.locationCapturedByUserId || null,
    locationCapturedForCompanyId: state.locationCapturedForCompanyId || null,
    activeFreightCode: state.activeFreightCode || null,
    pendingAction: state.pendingAction || null,
    pendingConfirmation: state.pendingConfirmation || false,
    executedActionId: state.executedActionId || null,
    executedResult: state.executedResult || null,
    auditTrail: (state.auditTrail || []).slice(-200),
    nodeHistory: (state.nodeHistory || []).slice(-200),
    toolCalls: (state.toolCalls || []).slice(-100),
    errors: (state.errors || []).slice(-50),
    updatedAt: new Date().toISOString(),
  };
}

