import { Module, Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { SseService } from '../sse/sse.service';
import { Response } from 'express';

// NOTE: This endpoint is intentionally public (no auth) for Railway health checks and monitoring.
// It exposes basic metrics (memory, uptime, SSE clients, DB pool) which is acceptable for ops visibility.
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
  async check(@Res() res: Response) {
    const dbOk = await this.prisma.ping();

    const mem = process.memoryUsage();
    const body: any = {
      status: dbOk ? 'ok' : 'error',
      db: dbOk ? 'connected' : 'disconnected',
      memory: {
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
      sse: { clients: this.sse.getClientCount() },
      uptime: Math.round(process.uptime()),
      startedAt: this.startedAt.toISOString(),
      timestamp: new Date().toISOString(),
    };

    if (dbOk) {
      try {
        const poolInfo: any[] = await this.prisma.$queryRaw`
          SELECT count(*)::int as active_connections
          FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active'
        `;
        body.pool = { active: poolInfo[0]?.active_connections || 0 };
      } catch {
        // Pool info is optional — don't fail health check for it
      }
    }

    // Return 503 when DB is disconnected so Railway restarts the container
    res.status(dbOk ? 200 : 503).json(body);
  }

  @Get('ping')
  ping() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('version')
  version() {
    return {
      status: 'ok',
      app: 'tolvink-api',
      version: process.env.npm_package_version || 'unknown',
      commit:
        process.env.RAILWAY_GIT_COMMIT_SHA ||
        process.env.SOURCE_COMMIT ||
        process.env.GIT_COMMIT ||
        'unknown',
      branch:
        process.env.RAILWAY_GIT_BRANCH ||
        process.env.GIT_BRANCH ||
        'unknown',
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || 'unknown',
      serviceId: process.env.RAILWAY_SERVICE_ID || 'unknown',
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID || 'unknown',
      nodeEnv: process.env.NODE_ENV || 'unknown',
      startedAt: this.startedAt.toISOString(),
      timestamp: new Date().toISOString(),
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
