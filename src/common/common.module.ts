import { Global, Module } from '@nestjs/common';
import { CompanyResolutionService } from './services/company-resolution.service';

@Global()
@Module({
  providers: [CompanyResolutionService],
  exports: [CompanyResolutionService],
})
export class CommonModule {}
