import { Module, Global, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SseService } from './sse.service';
import { SseController } from './sse.controller';

@Global()
@Module({
  controllers: [SseController],
  providers: [SseService],
  exports: [SseService],
})
export class SseModule implements OnModuleInit, OnModuleDestroy {
  private heartbeatInterval: ReturnType<typeof setInterval>;

  constructor(private sseService: SseService) {}

  onModuleInit() {
    // Heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval(() => this.sseService.heartbeat(), 30000);
  }

  onModuleDestroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
  }
}
