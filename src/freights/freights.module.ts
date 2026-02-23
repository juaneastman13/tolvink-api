import { Module } from '@nestjs/common';
import { FreightsController } from './freights.controller';
import { FreightTrackingController } from './freight-tracking.controller';
import { FreightsService } from './freights.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';

@Module({
  controllers: [FreightsController, FreightTrackingController],
  providers: [FreightsService, FreightStateMachine, FreightAccessGuard],
  exports: [FreightsService],
})
export class FreightsModule {}
