import { Module } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { AgentService } from './agent.service';
import { AgentMemoryService } from './memory/agent-memory.service';
import { GeminiRouterService } from './router/gemini-router.service';
import { ToolFilterService } from './filtering/tool-filter.service';
import { ToolCatalogService } from './tools/tool-catalog.service';
import { OpenAiAgentService } from './openai/openai-agent.service';
import { ConversationOrchestratorService } from './orchestration/conversation-orchestrator.service';
import { FreightReferenceService } from './resolution/freight-reference.service';
import { LogisticsEntityReferenceService } from './resolution/logistics-entity-reference.service';
import { ClarificationService } from './clarification/clarification.service';
import { PendingActionService } from './pending/pending-action.service';

@Module({
  imports: [FreightsModule],
  providers: [
    AgentService,
    AgentMemoryService,
    GeminiRouterService,
    ToolFilterService,
    ToolCatalogService,
    OpenAiAgentService,
    ConversationOrchestratorService,
    FreightReferenceService,
    LogisticsEntityReferenceService,
    ClarificationService,
    PendingActionService,
  ],
  exports: [AgentService],
})
export class AiModule {}
