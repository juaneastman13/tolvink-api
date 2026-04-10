// =====================================================================
// TOLVINK — AI Module (stub — agent disabled, pending rebuild)
// =====================================================================

import { Module } from '@nestjs/common';
import { AgentService } from './agent.stub';

@Module({
  providers: [AgentService],
  exports: [AgentService],
})
export class AiModule {}
