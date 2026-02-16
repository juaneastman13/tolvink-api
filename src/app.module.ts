import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { FreightsModule } from './freights/freights.module';
import { HealthModule } from './health/health.module';
import { CatalogController } from './catalog.controller';
import { PrismaService } from './database/prisma.service';

// Domain controllers & services
import { FieldsController } from './fields/fields.controller';
import { FieldsService } from './fields/fields.service';
import { TrucksController, TrucksService } from './trucks/trucks.controller';
import { PlantAccessController, PlantAccessService } from './plant-access/plant-access.controller';
import { ConversationsController, ConversationsService } from './conversations/conversations.controller';

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
