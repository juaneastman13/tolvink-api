import { Injectable, Logger } from '@nestjs/common';
import { UserContextService } from '../tools/context/user-context.service';
import { AgentOrchestratorService, AgentReply } from '../orchestrator/agent-orchestrator.service';

export type { AgentReply };

interface MessagePayload {
  [key: string]: any;
  body?: string;
  title?: string;
  latitude?: number;
  longitude?: number;
  id?: string;
}

@Injectable()
export class AgentHandlerService {
  private readonly logger = new Logger(AgentHandlerService.name);

  constructor(
    private userContext: UserContextService,
    private orchestrator: AgentOrchestratorService,
  ) {}

  async handle(phone: string, type: string, payload: MessagePayload): Promise<AgentReply> {
    try {
      const userCtx = await this.userContext.getUserContext(phone);
      if (!userCtx) {
        return {
          type: 'text',
          text: 'No encontré tu cuenta en Tolvink. ¿Registraste tu número de celular?',
        };
      }
      return this.orchestrator.handle(phone, type, payload, userCtx);
    } catch (error) {
      this.logger.error(
        `Unhandled error in handler: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : '',
      );
      return { type: 'text', text: 'Algo no salió bien. Probá de nuevo.' };
    }
  }
}
