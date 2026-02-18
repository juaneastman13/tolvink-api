import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { PrismaService } from './database/prisma.service';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { FreightsModule } from './freights/freights.module';
import { HealthModule } from './health/health.module';
import { CatalogController } from './catalog.controller';
import { FieldsController } from './fields/fields.controller';
import { FieldsService } from './fields/fields.service';
import { TrucksController, TrucksService } from './trucks/trucks.controller';
import { PlantAccessController, PlantAccessService } from './plant-access/plant-access.controller';
import { ConversationsController, ConversationsService } from './conversations/conversations.controller';
import { AdminController, AdminService } from './admin/admin.controller';
import { NotificationModule } from './notifications/notification.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { SseModule } from './sse/sse.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Global rate limiting: 100 req/min per IP (applied via APP_GUARD)
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    DatabaseModule,
    CommonModule,
    AuthModule,
    FreightsModule,
    HealthModule,
    NotificationModule,
    AnalyticsModule,
    SseModule,
  ],
  controllers: [
    CatalogController,
    FieldsController,
    TrucksController,
    PlantAccessController,
    ConversationsController,
    AdminController,
  ],
  providers: [
    PrismaService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    FieldsService,
    TrucksService,
    PlantAccessService,
    ConversationsService,
    AdminService,
  ],
})
export class AppModule {}
