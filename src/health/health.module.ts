import { Module, Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';

@ApiTags('Health')
@SkipThrottle()
@Controller('health')
class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;

      // Pool stats from PostgreSQL
      const poolInfo: any[] = await this.prisma.$queryRaw`
        SELECT count(*)::int as active_connections,
               (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') as max_connections
        FROM pg_stat_activity
        WHERE datname = current_database()
      `;

      const mem = process.memoryUsage();

      return {
        status: 'ok',
        db: 'connected',
        pool: {
          active: poolInfo[0]?.active_connections || 0,
          max: poolInfo[0]?.max_connections || 0,
        },
        memory: {
          heapMB: Math.round(mem.heapUsed / 1024 / 1024),
          rssMB: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
