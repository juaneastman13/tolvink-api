import { Injectable } from '@nestjs/common';
import { AgentResult, AiChannel, AgentExecutionContext } from '../contracts/agent.types';
import { GeminiRouterService } from '../router/gemini-router.service';
import { ToolFilterService } from '../filtering/tool-filter.service';
import { ToolCatalogService } from '../tools/tool-catalog.service';
import { OpenAiAgentService } from '../openai/openai-agent.service';
import { ClarificationService } from '../clarification/clarification.service';
import { PendingActionService } from '../pending/pending-action.service';

@Injectable()
export class ConversationOrchestratorService {
  constructor(
    private router: GeminiRouterService,
    private filter: ToolFilterService,
    private toolCatalog: ToolCatalogService,
    private openAiAgent: OpenAiAgentService,
    private clarification: ClarificationService,
    private pendingActions: PendingActionService,
  ) {}

  async handle(
    channel: AiChannel,
    phone: string,
    message: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<AgentResult> {
    const context: AgentExecutionContext = { channel, phone, user, session };
    const route = await this.router.decide(message, context);
    const pendingAction = this.pendingActions.get(session);

    if (route.intent === 'cancel_pending_action' && pendingAction) {
      await this.pendingActions.clear(session.id);
      return this.respond('Perfecto, cancelé la acción pendiente.', route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    if (route.intent === 'confirm_pending_action' && pendingAction) {
      await this.pendingActions.clear(session.id);
      return this.executeWithStrongModel(context, pendingAction.originalMessage, pendingAction.route, onDelta);
    }

    if (route.intent === 'confirm_pending_action' && !pendingAction) {
      return this.respond('No tengo ninguna acción pendiente para confirmar.', route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    const clarificationQuestion = route.needsClarification ? this.clarification.buildQuestion(route, context) : null;
    if (clarificationQuestion) {
      return this.respond(clarificationQuestion, route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    if (route.mode === 'direct_response' && route.directReply) {
      return this.respond(route.directReply, route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    if (this.pendingActions.shouldRequireConfirmation(route)) {
      const staged = await this.pendingActions.stage(session.id, message, route);
      const text = this.pendingActions.buildPromptForUser(staged, context);
      return this.respond(text, route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    return this.executeWithStrongModel(context, message, route, onDelta);
  }

  private async executeWithStrongModel(
    context: AgentExecutionContext,
    message: string,
    route: AgentResult['route'],
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<AgentResult> {
    const toolDescriptors = this.filter.filter(route, context, this.toolCatalog.listDescriptors());
    if (toolDescriptors.length === 0) {
      const text = 'No tengo herramientas habilitadas para ejecutar esa acción con tu contexto actual. Si querés, pedime una consulta o decime la empresa con la que querés operar.';
      return this.respond(text, route, process.env.GEMINI_ROUTER_MODEL || 'gemini-3.1-flash-lite-preview', onDelta);
    }

    return this.openAiAgent.run({
      context,
      message,
      route,
      tools: toolDescriptors,
      onDelta,
    });
  }

  private respond(
    text: string,
    route: AgentResult['route'],
    model: string,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): AgentResult {
    if (onDelta) onDelta(text, true);
    return {
      text,
      buttons: [],
      navigate: undefined,
      route,
      model,
      toolsExposed: [],
      toolsUsed: [],
    };
  }
}
