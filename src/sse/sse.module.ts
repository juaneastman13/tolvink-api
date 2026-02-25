import { Module, Global, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SseService } from './sse.service';
import { SseController } from './sse.controller';
import { PrismaService } from '../database/prisma.service';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [SseController],
  providers: [SseService, PrismaService],
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
