// =====================================================================
// TOLVINK — Flow Service (State Engine)
// Manages multi-step deterministic flows WITHOUT LLM
// Tracks flow state, collected data, missing fields, confirmations
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export type FlowType = 'create_freight' | 'assign_transport' | null;

export interface FlowState {
  flowType: FlowType;
  step: string;
  collected: Record<string, any>;
  missing: string[];
  awaitingConfirmation: boolean;
  awaitingField: string | null;   // the specific field we're asking for
  summary: string | null;         // human-readable summary for confirmation
  createdAt: number;
  updatedAt: number;
}

@Injectable()
export class FlowService {
  private readonly logger = new Logger(FlowService.name);

  constructor(private prisma: PrismaService) {}

  /** Create a new flow state */
  createFlow(flowType: FlowType, collected: Record<string, any> = {}, missing: string[] = []): FlowState {
    return {
      flowType,
      step: 'collecting',
      collected,
      missing,
      awaitingConfirmation: false,
      awaitingField: null,
      summary: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  /** Update flow with new field data */
  updateCollected(flow: FlowState, field: string, value: any): FlowState {
    flow.collected[field] = value;
    flow.missing = flow.missing.filter(f => f !== field);
    flow.awaitingField = null;
    flow.updatedAt = Date.now();
    return flow;
  }

  /** Set the next field to ask for */
  setAwaitingField(flow: FlowState, field: string): FlowState {
    flow.awaitingField = field;
    flow.updatedAt = Date.now();
    return flow;
  }

  /** Transition to confirmation step */
  setAwaitingConfirmation(flow: FlowState, summary: string): FlowState {
    flow.step = 'confirming';
    flow.awaitingConfirmation = true;
    flow.summary = summary;
    flow.updatedAt = Date.now();
    return flow;
  }

  /** Check if the flow has timed out (10 min inactivity) */
  isExpired(flow: FlowState): boolean {
    return Date.now() - flow.updatedAt > 10 * 60 * 1000;
  }

  /** Save flow state to session */
  async saveFlowToSession(sessionId: string, flow: FlowState | null): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session) return;

    const state = (session.flowState as any) || {};
    if (flow) {
      state._hybridFlow = flow;
    } else {
      delete state._hybridFlow;
    }

    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowState: state },
    });
  }

  /** Load flow state from session. Returns null if expired. */
  getFlowFromSession(session: any): FlowState | null {
    const state = (session?.flowState as any) || {};
    const flow = state._hybridFlow;
    if (!flow || !flow.flowType) return null;
    if (this.isExpired(flow)) return null; // Caller checks raw flow separately for notification
    return flow as FlowState;
  }

  /** Check if a raw flow object from session exists and is expired (for notification purposes) */
  hasExpiredFlow(session: any): boolean {
    const state = (session?.flowState as any) || {};
    const flow = state._hybridFlow;
    if (!flow || !flow.flowType) return false;
    return this.isExpired(flow);
  }

  /** Clear flow from session */
  async clearFlow(sessionId: string): Promise<void> {
    await this.saveFlowToSession(sessionId, null);
  }
}
