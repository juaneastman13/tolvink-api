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
import { AiContextService } from './tools/ai-context.service';
import { LocationToolsService } from './tools/location-tools.service';
import { AdminToolsService } from './tools/admin-tools.service';
import { TransportToolsService } from './tools/transport-tools.service';
import { FreightQueryToolsService } from './tools/freight-query-tools.service';
import { FreightActionToolsService } from './tools/freight-action-tools.service';
// Hybrid services — deterministic routing (90% of messages without LLM)
import { IntentDetectorService } from './hybrid/intent-detector.service';
import { FreightParserService } from './hybrid/freight-parser.service';
import { FlowService } from './hybrid/flow.service';
import { FreightFlowService } from './hybrid/freight-flow.service';
import { ResponseBuilderService } from './hybrid/response-builder.service';
import { MessageRouterService } from './hybrid/message-router.service';
import { AiInterpreterService } from './hybrid/ai-interpreter.service';

@Module({
  imports: [forwardRef(() => FreightsModule), forwardRef(() => WhatsAppModule), OcrModule],
  providers: [
    AiService, FieldsService, TrucksService, AdminService,
    ResponseFormatterService, SessionManagerService, PromptBuilderService, IntentRouterService,
    AiContextService, LocationToolsService, AdminToolsService, TransportToolsService,
    FreightQueryToolsService, FreightActionToolsService,
    // Hybrid deterministic + interpreter services
    IntentDetectorService, FreightParserService, FlowService,
    FreightFlowService, ResponseBuilderService, AiInterpreterService, MessageRouterService,
  ],
  exports: [
    AiService, MessageRouterService,
    // Shared services used by GeminiModule
    ResponseFormatterService, SessionManagerService, IntentRouterService,
    AiContextService, LocationToolsService,
  ],
})
export class AiModule {}
