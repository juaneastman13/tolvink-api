// =====================================================================
// TOLVINK — AI Module
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { AgentService } from './agent.service';
import { ToolExecutorService } from './tools/tool-executor';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [
    AgentService,
    ToolExecutorService,
  ],
  exports: [AgentService],
})
export class AiModule {}
