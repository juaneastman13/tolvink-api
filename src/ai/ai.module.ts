// =====================================================================
// TOLVINK — AI Module
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { AgentService } from './agent.service';
import { ClaudeClient } from './core/claude.client';
import { ToolExecutorService } from './tools/tool-executor';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [
    AgentService,
    ClaudeClient,
    ToolExecutorService,
  ],
  exports: [AgentService],
})
export class AiModule {}
