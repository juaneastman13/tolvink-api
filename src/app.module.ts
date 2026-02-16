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
import { TrucksController } from './trucks/trucks.controller';
import { TrucksService } from './trucks/trucks.service';
import { PlantAccessController } from './plant-access/plant-access.controller';
import { PlantAccessService } from './plant-access/plant-access.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    FreightsModule,
    HealthModule,
  ],
  controllers: [
    CatalogController,
    FieldsController,
    TrucksController,
    PlantAccessController,
    ConversationsController,
  ],
  providers: [
    PrismaService,
    FieldsService,
    TrucksService,
    PlantAccessService,
    ConversationsService,
  ],
})
export class AppModule {}
