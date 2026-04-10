import { Injectable } from '@nestjs/common';
import { AgentMemoryService } from '../memory/agent-memory.service';
import { AgentExecutionContext, AiRouteDecision, PendingAction } from '../contracts/agent.types';

@Injectable()
export class PendingActionService {
  constructor(private memory: AgentMemoryService) {}

  shouldRequireConfirmation(route: AiRouteDecision): boolean {
    return route.mode === 'openai_tools'
      && route.shouldEscalate === true
      && route.risk === 'high'
      && (route.intent === 'freight_create' || route.intent === 'freight_update');
  }

  async stage(sessionId: string, message: string, route: AiRouteDecision) {
    const pendingAction: PendingAction = {
      kind: 'executor_confirmation',
      originalMessage: message,
      route,
      summary: this.buildSummary(message, route),
      createdAt: new Date().toISOString(),
    };
    await this.memory.setPendingAction(sessionId, pendingAction);
    return pendingAction;
  }

  get(session: any) {
    return this.memory.getPendingAction(session);
  }

  async clear(sessionId: string) {
    await this.memory.clearPendingAction(sessionId);
  }

  isConfirmation(message: string): boolean {
    return /^(si|sí|dale|confirmo|confirmar|ok|de acuerdo|hacelo|hace eso)$/i.test((message || '').trim());
  }

  isCancellation(message: string): boolean {
    return /^(no|cancelar|cancelá|cancelalo|cancelalo|anular|dejalo)$/i.test((message || '').trim());
  }

  buildPromptForUser(pendingAction: PendingAction, _context: AgentExecutionContext): string {
    return `${pendingAction.summary}\n\nRespondé "sí" para confirmar o "cancelar" para abortar.`;
  }

  private buildSummary(message: string, route: AiRouteDecision): string {
    if (route.intent === 'freight_create') {
      return `Voy a preparar la creación de un flete con este pedido: "${message.trim()}".`;
    }
    if (route.intent === 'freight_update') {
      return `Voy a ejecutar esta acción operativa: "${message.trim()}".`;
    }
    return `Voy a ejecutar esta acción: "${message.trim()}".`;
  }
}
