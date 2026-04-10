import { Injectable, Logger } from '@nestjs/common';
import { ConversationOrchestratorService } from './orchestration/conversation-orchestrator.service';
import { AgentMemoryService } from './memory/agent-memory.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private orchestrator: ConversationOrchestratorService,
    private memory: AgentMemoryService,
  ) {}

  isEnabled(): boolean {
    return true;
  }

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }>; navigate?: any }> {
    if (!session?.id) {
      throw new Error('AI session is required');
    }

    const channel = phone === 'web' ? 'web' : 'whatsapp';
    const startedAt = Date.now();
    const result = await this.orchestrator.handle(channel, phone, userMessage, user, session, onDelta);

    await this.memory.appendTurn(session.id, userMessage, result.text, {
      _lastAiRoute: {
        mode: result.route.mode,
        intent: result.route.intent,
        reason: result.route.reason,
        model: result.model,
        toolsExposed: result.toolsExposed,
        toolsUsed: result.toolsUsed,
        createdAt: new Date().toISOString(),
      },
    });

    this.logger.log(JSON.stringify({
      event: 'ai_turn_completed',
      channel,
      phone: this.maskPhone(phone),
      sessionId: session.id,
      routeMode: result.route.mode,
      routeIntent: result.route.intent,
      routeReason: result.route.reason,
      toolsExposed: result.toolsExposed,
      toolsUsed: result.toolsUsed,
      durationMs: Date.now() - startedAt,
      model: result.model,
    }));
    return {
      text: result.text,
      buttons: result.buttons,
      navigate: result.navigate,
    };
  }

  private maskPhone(phone: string): string {
    if (!phone || phone === 'web') return phone || 'unknown';
    return phone.length > 4 ? `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}` : phone;
  }
}
