import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { PrismaService } from './database/prisma.service';
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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    FreightsModule,
    HealthModule,
    NotificationModule,
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
    FieldsService,
    TrucksService,
    PlantAccessService,
    ConversationsService,
    AdminService,
  ],
})
export class AppModule {}
