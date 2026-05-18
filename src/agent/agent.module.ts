import { Module } from '@nestjs/common';
import { LlmService } from './llm/llm.service';
import { ConversationService } from './memory/conversation.service';
import { AgentHandlerService } from './whatsapp/agent-handler.service';

@Module({
  providers: [LlmService, ConversationService, AgentHandlerService],
  exports: [AgentHandlerService],
})
export class AgentModule {}
