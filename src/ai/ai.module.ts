// =====================================================================
// TOLVINK — AI Module
// =====================================================================

import { Module, forwardRef } from '@nestjs/common';
import { FreightsModule } from '../freights/freights.module';
import { AgentService } from './agent.service';
import { ToolExecutorService } from './tools/tool-executor';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [
    AgentService,
    ToolExecutorService,
    FieldsService,
    TrucksService,
  ],
  exports: [AgentService],
})
export class AiModule {}
