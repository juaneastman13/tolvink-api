// =====================================================================
// TOLVINK — AI Module (Gemini rebuild)
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FreightsModule } from '../freights/freights.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { OcrModule } from '../ocr/ocr.module';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';

// Core
import { AgentService } from './core/agent.service';
import { GeminiClient } from './core/gemini.client';

// Prompt
import { PromptBuilderService } from './prompt/prompt-builder';

// Conversation
import { SessionManagerService } from './conversation/session-manager';
import { HistoryManagerService } from './conversation/history-manager';
import { ContextBuilderService } from './conversation/context-builder';

// Tools
import { ToolRegistryService } from './tools/tool-registry';
import { ToolExecutorService } from './tools/tool-executor';

@Module({
  imports: [
    ConfigModule,
    forwardRef(() => FreightsModule),
    forwardRef(() => WhatsAppModule),
    OcrModule,
  ],
  providers: [
    AgentService,
    { provide: 'AiService', useExisting: AgentService },
    GeminiClient,
    PromptBuilderService,
    SessionManagerService,
    HistoryManagerService,
    ContextBuilderService,
    ToolRegistryService,
    ToolExecutorService,
    FieldsService,
    TrucksService,
    AdminService,
  ],
  exports: [AgentService, SessionManagerService],
})
export class AiModule {}
