import { Injectable } from '@nestjs/common';
import { AgentExecutionContext, AiRouteDecision } from '../contracts/agent.types';

@Injectable()
export class ClarificationService {
  buildQuestion(route: AiRouteDecision, context: AgentExecutionContext): string | null {
    if (route.clarificationQuestion) {
      return route.clarificationQuestion;
    }

    const state = (context.session?.flowState as any) || {};
    if (route.intent === 'freight_update' && !route.entityHints?.freightRef && !state._lastFreightId) {
      return '¿Sobre qué flete querés operar? Decime el código o buscámelo primero.';
    }

    if (route.intent === 'freight_create' && !((context.session?.flowState as any)?.selectedCompanyId)) {
      return 'Antes de crear el flete necesito saber con qué empresa querés operar.';
    }

    return null;
  }
}
