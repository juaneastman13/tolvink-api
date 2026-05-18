import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
// TODO: Etapa 0 - Router and Flow services removed pending agent system rebuild
// import { WhatsAppRouterService } from './whatsapp-router.service';
// import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsModule } from '../freights/freights.module';
import { AgentModule } from '../agent/agent.module';

@Module({
  imports: [FreightsModule, AgentModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    // WhatsAppRouterService,
    // WhatsAppFlowService,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
