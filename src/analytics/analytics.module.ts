import {
  Module, Controller, Get, Post, Body, Query, Req, Logger, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs ========================================

class TrackDto {
  @IsNotEmpty() @IsString() @MaxLength(100)
  event: string;

  @IsOptional()
  data?: Record<string, any>;

  @IsOptional() @IsString() @MaxLength(100)
  sessionId?: string;
}

// ======================== CONTROLLER ==================================

@ApiTags('Analytics')
@Controller('analytics')
class AnalyticsController {
  private readonly logger = new Logger('Analytics');

  constructor(private prisma: PrismaService) {}

  @Post('track')
  @SkipThrottle()
  @ApiOperation({ summary: 'Track an analytics event (public, auth optional)' })
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

  @Get('events')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Query analytics events (admin only)' })
  @ApiQuery({ name: 'event', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'to', required: false, description: 'ISO date string' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async events(
    @CurrentUser() user: any,
    @Query('event') event?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    if (user.role !== 'platform_admin') {
      return { error: 'Solo administradores de plataforma' };
    }

    const p = parseInt(page || '1', 10) || 1;
    const l = Math.min(parseInt(limit || '50', 10) || 50, 200);
    const skip = (p - 1) * l;

    const where: any = {};
    if (event) where.event = event;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [data, total] = await Promise.all([
      this.prisma.analyticsEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: l,
        select: { id: true, event: true, data: true, userId: true, sessionId: true, createdAt: true },
      }),
      this.prisma.analyticsEvent.count({ where }),
    ]);

    return { data, total, page: p, limit: l, pages: Math.ceil(total / l) };
  }

  @Get('summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Analytics summary by event type (admin only)' })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  async summary(
    @CurrentUser() user: any,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (user.role !== 'platform_admin') {
      return { error: 'Solo administradores de plataforma' };
    }

    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const events = await this.prisma.analyticsEvent.groupBy({
      by: ['event'],
      where,
      _count: { event: true },
      orderBy: { _count: { event: 'desc' } },
    });

    const uniqueSessions = await this.prisma.analyticsEvent.groupBy({
      by: ['sessionId'],
      where: { ...where, sessionId: { not: null } },
    });

    const uniqueUsers = await this.prisma.analyticsEvent.groupBy({
      by: ['userId'],
      where: { ...where, userId: { not: null } },
    });

    return {
      events: events.map(e => ({ event: e.event, count: e._count.event })),
      totalEvents: events.reduce((s, e) => s + e._count.event, 0),
      uniqueSessions: uniqueSessions.length,
      uniqueUsers: uniqueUsers.length,
    };
  }
}

@Module({ controllers: [AnalyticsController] })
export class AnalyticsModule {}
