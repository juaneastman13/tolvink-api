import { Module, forwardRef } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { DatabaseModule } from '../database/database.module';
import { FreightsModule } from '../freights/freights.module';
import { FreightLocationsModule } from '../freight-locations/freight-locations.module';
import { AgentV2Service } from './agent-v2.service';
import { AgentV2FreightTools } from './tools/freight.tools';
import { AgentV2CompanyTools } from './tools/company.tools';
import { AgentV2LocationTools } from './tools/location.tools';
import { AgentV2DocumentTools } from './tools/document.tools';
import { AgentV2NotificationTools } from './tools/notification.tools';

@Module({
  imports: [forwardRef(() => AiModule), DatabaseModule, FreightsModule, FreightLocationsModule],
  providers: [
    AgentV2Service,
    AgentV2FreightTools,
    AgentV2CompanyTools,
    AgentV2LocationTools,
    AgentV2DocumentTools,
    AgentV2NotificationTools,
  ],
  exports: [AgentV2Service],
})
export class AgentV2Module {}

