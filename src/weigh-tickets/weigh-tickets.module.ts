import { Module } from '@nestjs/common';
import { WeighTicketsController } from './weigh-tickets.controller';
import { WeighTicketsService } from './weigh-tickets.service';
import { OcrModule } from '../ocr/ocr.module';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';

@Module({
  imports: [OcrModule],
  controllers: [WeighTicketsController],
  providers: [WeighTicketsService, FreightAccessGuard],
  exports: [WeighTicketsService],
})
export class WeighTicketsModule {}
