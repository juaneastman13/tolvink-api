import { Module, forwardRef } from '@nestjs/common';
import { AiService } from './ai.service';
import { FreightsModule } from '../freights/freights.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { OcrModule } from '../ocr/ocr.module';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';
import { ResponseFormatterService } from './response/response-formatter.service';
import { SessionManagerService } from './session/session-manager.service';
import { PromptBuilderService } from './prompt/prompt-builder.service';
import { IntentRouterService } from './routing/intent-router.service';

@Module({
  imports: [forwardRef(() => FreightsModule), forwardRef(() => WhatsAppModule), OcrModule],
  providers: [AiService, FieldsService, TrucksService, AdminService, ResponseFormatterService, SessionManagerService, PromptBuilderService, IntentRouterService],
  exports: [AiService],
})
export class AiModule {}
