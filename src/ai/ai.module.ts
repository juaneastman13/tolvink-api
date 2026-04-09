// =====================================================================
// TOLVINK — AI Module (Claude Sonnet rewrite)
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
import { ClaudeClient } from './core/claude.client';

// Prompt
import { PromptBuilderService } from './prompt/prompt-builder';

// Conversation
import { SessionManagerService } from './conversation/session-manager';

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
    ClaudeClient,
    PromptBuilderService,
    SessionManagerService,
    ToolRegistryService,
    ToolExecutorService,
    FieldsService,
    TrucksService,
    AdminService,
  ],
  exports: [AgentService, SessionManagerService],
})
export class AiModule {}
