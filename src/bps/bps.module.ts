import { Module } from '@nestjs/common';
import { BpsController } from './bps.controller';
import { BpsService } from './bps.service';
import { BpsClient } from './bps-client';
import { BpsSyncService } from './bps-sync.service';

@Module({
  controllers: [BpsController],
  providers: [BpsService, BpsClient, BpsSyncService],
  exports: [BpsService],
})
export class BpsModule {}
