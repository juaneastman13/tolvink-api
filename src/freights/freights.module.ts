import { Module } from '@nestjs/common';
import { FreightsController } from './freights.controller';
import { FreightTrackingController } from './freight-tracking.controller';
import { FreightPublicController } from './freight-public.controller';
import { FreightsService } from './freights.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { AssignmentSuggestionsService } from './assignment-suggestions.service';
import { FreightAccessGuard } from '../common/guards/freight-access.guard';

@Module({
  controllers: [FreightsController, FreightTrackingController, FreightPublicController],
  providers: [FreightsService, FreightStateMachine, AssignmentSuggestionsService, FreightAccessGuard],
  exports: [FreightsService, AssignmentSuggestionsService],
})
export class FreightsModule {}
