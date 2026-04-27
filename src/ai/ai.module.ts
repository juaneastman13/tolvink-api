// =====================================================================
// TOLVINK — AI Module
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { SharedLinksModule } from '../shared-links/shared-links.module';
import { FreightLocationsModule } from '../freight-locations/freight-locations.module';
import { AgentService } from './agent.service';
import { GeminiClient } from './core/gemini.client';
import { ToolExecutorService } from './tools/tool-executor';

@Module({
  imports: [forwardRef(() => FreightsModule), SharedLinksModule, FreightLocationsModule],
  providers: [
    AgentService,
    GeminiClient,
    ToolExecutorService,
  ],
  exports: [AgentService, GeminiClient],
})
export class AiModule {}
