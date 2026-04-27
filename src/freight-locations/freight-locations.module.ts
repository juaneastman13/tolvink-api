import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CommonModule } from '../common/common.module';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';
import { FreightLocationsController, FreightMapPublicController } from './freight-locations.controller';
import { FreightLocationsService } from './freight-locations.service';

@Module({
  imports: [DatabaseModule, CommonModule],
  controllers: [FreightLocationsController, FreightMapPublicController],
  providers: [FreightLocationsService, FreightAccessGuard],
  exports: [FreightLocationsService],
})
export class FreightLocationsModule {}
