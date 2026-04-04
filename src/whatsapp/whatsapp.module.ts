import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsModule } from '../freights/freights.module';
import { AiModule } from '../ai/ai.module';
import { GeminiModule } from '../ai/gemini/gemini.module';
@Module({
  imports: [FreightsModule, forwardRef(() => AiModule), forwardRef(() => GeminiModule)],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppRouterService,
    WhatsAppFlowService,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
