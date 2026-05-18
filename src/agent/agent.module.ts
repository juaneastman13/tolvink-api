import { Module } from '@nestjs/common';
import { LlmService } from './llm/llm.service';
import { ConversationService } from './memory/conversation.service';
import { FlowStateService } from './memory/flow-state.service';
import { AgentHandlerService } from './whatsapp/agent-handler.service';
import { UserContextService } from './tools/context/user-context.service';
import { IntentRouterService } from './routing/intent-router.service';
import { CreateFreightFlow } from './flows/create-freight/create-freight.flow';
import { CreateFreightTool } from './tools/fletes/create-freight.tool';
import { FlowManagerService } from './flows/flow-manager.service';
import { FreightsModule } from '../freights/freights.module';

@Module({
  imports: [FreightsModule],
  providers: [
    LlmService,
    ConversationService,
    FlowStateService,
    AgentHandlerService,
    UserContextService,
    IntentRouterService,
    CreateFreightFlow,
    CreateFreightTool,
    FlowManagerService,
  ],
  exports: [AgentHandlerService],
})
export class AgentModule {}
