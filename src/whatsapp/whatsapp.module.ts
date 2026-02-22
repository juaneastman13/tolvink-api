import { Module } from '@nestjs/common';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { WhatsAppFlowService } from './whatsapp-flow.service';
import { FreightsModule } from '../freights/freights.module';
import { PrismaService } from '../database/prisma.service';

@Module({
  imports: [FreightsModule],
  controllers: [WhatsAppController],
  providers: [
    PrismaService,
    WhatsAppService,
    WhatsAppRouterService,
    WhatsAppFlowService,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
