import { Module, Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { SseService } from '../sse/sse.service';

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
class HealthController {
  private readonly startedAt = new Date();

  constructor(
    private prisma: PrismaService,
    private sse: SseService,
  ) {}

  @Get()
  async check() {
    try {
      const poolInfo: any[] = await this.prisma.$queryRaw`
        SELECT count(*)::int as active_connections
        FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active'
      `;

      const mem = process.memoryUsage();

      return {
        status: 'ok',
        db: 'connected',
        pool: { active: poolInfo[0]?.active_connections || 0 },
        memory: {
          heapMB: Math.round(mem.heapUsed / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        sse: { clients: this.sse.getClientCount() },
        uptime: Math.round(process.uptime()),
        startedAt: this.startedAt.toISOString(),
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  }

  @Get('ping')
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
