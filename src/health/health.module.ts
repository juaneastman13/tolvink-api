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
      return { status: 'ok', db: 'connected', timestamp: new Date().toISOString() };
    } catch (e) {
      return { status: 'error', db: 'disconnected', timestamp: new Date().toISOString() };
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
