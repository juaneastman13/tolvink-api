import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { PendingAction } from '../contracts/agent.types';

const MAX_HISTORY = 20;

@Injectable()
export class AgentMemoryService {
  constructor(private prisma: PrismaService) {}

  getState(session: any): any {
    return (session?.flowState as any) || {};
  }

  getAiMessages(session: any): Array<{ role: 'user' | 'assistant'; content: string }> {
    const state = this.getState(session);
    const rawMessages = Array.isArray(state.aiMessages) ? state.aiMessages : [];

    return rawMessages
      .filter((item: any) => item?.role === 'user' || item?.role === 'assistant')
      .map((item: any) => ({
        role: item.role,
        content: this.extractText(item.content),
      }))
      .filter((item: any) => item.content);
  }

  async appendTurn(sessionId: string, userMessage: string, assistantMessage: string, extraState?: Record<string, unknown>) {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new Error(`AI session not found: ${sessionId}`);
    }

    const state = this.getState(session);
    const aiMessages = this.getAiMessages(session);
    const nextMessages = [
      ...aiMessages,
      { role: 'user' as const, content: userMessage },
      { role: 'assistant' as const, content: assistantMessage },
    ].slice(-MAX_HISTORY);

    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        flowState: {
          ...state,
          ...extraState,
          aiMessages: nextMessages,
          lastMessageAt: new Date().toISOString(),
        },
      },
    });
  }

  async mergeState(sessionId: string, patch: Record<string, unknown>) {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new Error(`AI session not found: ${sessionId}`);
    }

    const state = this.getState(session);
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        flowState: {
          ...state,
          ...patch,
        },
      },
    });
  }

  getPendingAction(session: any): PendingAction | null {
    const state = this.getState(session);
    const pendingAction = state.pendingAction;
    if (!pendingAction || typeof pendingAction !== 'object') return null;
    if (pendingAction.kind !== 'executor_confirmation') return null;
    return pendingAction as PendingAction;
  }

  async setPendingAction(sessionId: string, pendingAction: PendingAction) {
    await this.mergeState(sessionId, { pendingAction });
  }

  async clearPendingAction(sessionId: string) {
    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw new Error(`AI session not found: ${sessionId}`);
    }

    const state = this.getState(session);
    const { pendingAction, ...rest } = state;
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        flowState: rest,
      },
    });
  }

  async rememberEntities(sessionId: string, entities: {
    plant?: { id: string; name?: string | null } | null;
    field?: { id: string; name?: string | null } | null;
    lot?: { id: string; name?: string | null } | null;
    truck?: { id: string; plate?: string | null } | null;
    driver?: { id: string; name?: string | null } | null;
  }) {
    const patch: Record<string, unknown> = {};
    if (entities.plant) {
      patch._lastPlantId = entities.plant.id;
      patch._lastPlantName = entities.plant.name || null;
    }
    if (entities.field) {
      patch._lastFieldId = entities.field.id;
      patch._lastFieldName = entities.field.name || null;
    }
    if (entities.lot) {
      patch._lastLotId = entities.lot.id;
      patch._lastLotName = entities.lot.name || null;
    }
    if (entities.truck) {
      patch._lastTruckId = entities.truck.id;
      patch._lastTruckPlate = entities.truck.plate || null;
    }
    if (entities.driver) {
      patch._lastDriverId = entities.driver.id;
      patch._lastDriverName = entities.driver.name || null;
    }
    if (Object.keys(patch).length > 0) {
      await this.mergeState(sessionId, patch);
    }
  }

  private extractText(content: any): string {
    if (typeof content === 'string') return content.trim();
    if (!Array.isArray(content)) return '';

    return content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
      .trim();
  }
}
