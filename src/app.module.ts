import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { FreightsModule } from './freights/freights.module';
import { FieldsModule } from './fields/fields.module';
import { HealthModule } from './health/health.module';
import { CatalogController } from './catalog.controller';
import { PrismaService } from './database/prisma.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    AuthModule,
    FreightsModule,
    FieldsModule,
    HealthModule,
  ],
  controllers: [CatalogController],
  providers: [PrismaService],
})
export class AppModule {}
