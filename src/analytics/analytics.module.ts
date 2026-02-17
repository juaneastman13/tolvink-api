import { Module, Controller, Post, Body, Req, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

class TrackDto {
  event: string;
  data?: Record<string, any>;
  sessionId?: string;
}

@Controller('analytics')
class AnalyticsController {
  private readonly logger = new Logger('Analytics');

  constructor(private prisma: PrismaService) {}

  @Post('track')
  async track(@Body() dto: TrackDto, @Req() req: any) {
    const userId = req.user?.sub || null;
    this.prisma.analyticsEvent.create({
      data: {
        event: dto.event,
        data: dto.data || {},
        userId,
        sessionId: dto.sessionId || null,
      },
    }).catch((e) => this.logger.warn(`Failed to store event: ${e.message}`));
    return { ok: true };
  }
}

@Module({ controllers: [AnalyticsController] })
export class AnalyticsModule {}
