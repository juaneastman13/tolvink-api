import { Module, Global, forwardRef } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationController } from './notification.controller';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';

@Global()
@Module({
  imports: [forwardRef(() => WhatsAppModule)],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
