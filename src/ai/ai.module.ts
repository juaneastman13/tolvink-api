import { Module, forwardRef } from '@nestjs/common';
import { AiService } from './ai.service';
import { FreightsModule } from '../freights/freights.module';
import { PrismaService } from '../database/prisma.service';

@Module({
  imports: [forwardRef(() => FreightsModule)],
  providers: [PrismaService, AiService],
  exports: [AiService],
})
export class AiModule {}
