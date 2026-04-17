import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { FreightsModule } from './freights/freights.module';
import { HealthModule } from './health/health.module';
import { CatalogController } from './catalog.controller';
import { FieldsController } from './fields/fields.controller';
import { FieldsService } from './fields/fields.service';
import { TrucksController, TrucksService } from './trucks/trucks.controller';
import { PlantAccessController, PlantAccessService } from './plant-access/plant-access.controller';
import { CompanyAccessController, CompanyAccessService } from './company-access/company-access.controller';
import { ConversationsController, ConversationsService } from './conversations/conversations.controller';
import { AdminController, AdminService } from './admin/admin.controller';
import { NotificationModule } from './notifications/notification.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SseModule } from './sse/sse.module';
import { WhatsAppModule } from './whatsapp/whatsapp.module';
import { OcrModule } from './ocr/ocr.module';
import { WeighTicketsModule } from './weigh-tickets/weigh-tickets.module';
import { WebChatModule } from './web-chat/web-chat.module';
import { SharedLinksModule } from './shared-links/shared-links.module';
import { ModulesController, ModulesService } from './modules/modules.controller';
import { MachinesController, MachineTemplatesController, MachinesService } from './machines/machines.controller';
import { MaintenanceController, MaintenanceService } from './maintenance/maintenance.controller';
import { MechanicDashboardController, MechanicDashboardService } from './mechanic-dashboard/mechanic-dashboard.controller';
import { StockModule } from './stock/stock.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global rate limiting: 500 req/min (applied via APP_GUARD)
    // With 15s polling (freights + notifications + chat) = ~12 req/min baseline
    // + user actions = ~50-100 req/min normal usage per user
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 500 }]),
    DatabaseModule,
    CommonModule,
    AuthModule,
    FreightsModule,
    HealthModule,
    NotificationModule,
    AnalyticsModule,
    SseModule,
    WhatsAppModule,
    OcrModule,
    WeighTicketsModule,
    WebChatModule,
    SharedLinksModule,
    StockModule,
  ],
  controllers: [
    CatalogController,
    FieldsController,
    TrucksController,
    PlantAccessController,
    CompanyAccessController,
    ConversationsController,
    AdminController,
    ModulesController,
    MachineTemplatesController,
    MachinesController,
    MaintenanceController,
    MechanicDashboardController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    FieldsService,
    ModulesService,
    MachinesService,
    MaintenanceService,
    MechanicDashboardService,
    TrucksService,
    PlantAccessService,
    CompanyAccessService,
    ConversationsService,
    AdminService,
  ],
})
export class AppModule {}
