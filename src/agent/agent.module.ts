import { Module } from '@nestjs/common';
import { LlmService } from './llm/llm.service';
import { ConversationService } from './memory/conversation.service';
import { AgentHandlerService } from './whatsapp/agent-handler.service';
import { UserContextService } from './tools/context/user-context.service';
import { AgentOrchestratorService } from './orchestrator/agent-orchestrator.service';
import { DraftStore } from './orchestrator/draft-store.service';
import { FreightsModule } from '../freights/freights.module';

@Module({
  imports: [FreightsModule],
  providers: [
    LlmService,
    ConversationService,
    AgentHandlerService,
    UserContextService,
    AgentOrchestratorService,
    DraftStore,
  ],
  exports: [AgentHandlerService],
})
export class AgentModule {}
