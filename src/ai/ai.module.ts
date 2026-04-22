// =====================================================================
// TOLVINK — AI Module
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { AgentService } from './agent.service';
import { GeminiClient } from './core/gemini.client';
import { ToolExecutorService } from './tools/tool-executor';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [
    AgentService,
    GeminiClient,
    ToolExecutorService,
  ],
  exports: [AgentService, GeminiClient],
})
export class AiModule {}
