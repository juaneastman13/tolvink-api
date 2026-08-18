import { Module } from '@nestjs/common';
import { BpsController } from './bps.controller';
import { BpsExcelController } from './bps-excel.controller';
import { BpsService } from './bps.service';
import { BpsClient } from './bps-client';
import { BpsSyncService } from './bps-sync.service';

@Module({
  controllers: [BpsController, BpsExcelController],
  providers: [BpsService, BpsClient, BpsSyncService],
  exports: [BpsService],
})
export class BpsModule {}
