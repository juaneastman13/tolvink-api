import { Module, forwardRef } from '@nestjs/common';
import { AiService } from './ai.service';
import { FreightsModule } from '../freights/freights.module';
import { PrismaService } from '../database/prisma.service';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [PrismaService, AiService, FieldsService, TrucksService, AdminService],
  exports: [AiService],
})
export class AiModule {}
