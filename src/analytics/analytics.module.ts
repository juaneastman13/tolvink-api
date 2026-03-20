import {
  Module, Controller, Get, Post, Body, Query, Req, Logger, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsObject, MaxLength, ValidatorConstraint, ValidatorConstraintInterface, Validate } from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs ========================================

@ValidatorConstraint({ name: 'maxJsonSize', async: false })
class MaxJsonSize implements ValidatorConstraintInterface {
  validate(value: any) {
    if (!value) return true;
    try { return JSON.stringify(value).length <= 4096; } catch { return false; }
  }
  defaultMessage() { return 'data must be under 4KB'; }
}

class TrackDto {
  @IsNotEmpty() @IsString() @MaxLength(100)
  event: string;

  @IsOptional() @IsObject() @Validate(MaxJsonSize)
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

  // Allowlist of known event names to prevent arbitrary data pollution
  private static ALLOWED_EVENTS = new Set([
    'page_view', 'screen_view', 'login', 'logout', 'register',
    'freight_create', 'freight_view', 'freight_action', 'freight_search',
    'map_view', 'chat_open', 'notification_click', 'error',
    'wizard_step', 'filter_change', 'upload', 'ocr_scan',
  ]);

  @Post('track')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Track an analytics event (public, auth optional)' })
  async track(@Body() dto: TrackDto, @Req() req: any) {
    // Reject unknown event names to prevent pollution from unauthenticated callers
    if (!AnalyticsController.ALLOWED_EVENTS.has(dto.event)) {
      return { ok: true }; // Silent drop — don't reveal allowlist
    }
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
      throw new ForbiddenException('Solo administradores de plataforma');
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

  // ======================== FREIGHT ANALYTICS ============================

  @Get('freight-summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Freight analytics summary for company' })
  @ApiQuery({ name: 'period', required: false, enum: ['week', 'month', 'campaign'] })
  async freightSummary(
    @CurrentUser() user: any,
    @Query('period') period?: string,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company');
    const since = this.periodToDate(period || 'month');

    const freights = await this.prisma.freight.findMany({
      where: { participantCompanyIds: { has: companyId }, createdAt: { gte: since } },
      select: { id: true, status: true, items: { select: { tons: true } } },
    });

    const totalFreights = freights.length;
    const totalTons = freights.reduce((s, f) => s + f.items.reduce((ss, i) => ss + Number(i.tons || 0), 0), 0);
    const activeStatuses = ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded'];
    const activeFreights = freights.filter(f => activeStatuses.includes(f.status)).length;
    const finishedFreights = freights.filter(f => f.status === 'finished').length;

    return { totalFreights, totalTons: Math.round(totalTons * 100) / 100, activeFreights, finishedFreights, period: period || 'month' };
  }

  @Get('by-producer')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Volume by producer (for plants/hubs)' })
  @ApiQuery({ name: 'period', required: false, enum: ['week', 'month', 'campaign'] })
  async byProducer(
    @CurrentUser() user: any,
    @Query('period') period?: string,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company');
    const since = this.periodToDate(period || 'month');

    const freights = await this.prisma.freight.findMany({
      where: { participantCompanyIds: { has: companyId }, createdAt: { gte: since } },
      select: { originCompanyId: true, originCompany: { select: { id: true, name: true } }, items: { select: { tons: true } } },
    });

    const map = new Map<string, { name: string; tons: number; count: number }>();
    for (const f of freights) {
      const id = f.originCompanyId;
      const name = f.originCompany?.name || 'Desconocido';
      const cur = map.get(id) || { name, tons: 0, count: 0 };
      cur.tons += f.items.reduce((s, i) => s + Number(i.tons || 0), 0);
      cur.count++;
      map.set(id, cur);
    }

    return Array.from(map.entries()).map(([id, v]) => ({ companyId: id, name: v.name, tons: Math.round(v.tons * 100) / 100, count: v.count }))
      .sort((a, b) => b.tons - a.tons);
  }

  @Get('by-product')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Volume by product/grain' })
  @ApiQuery({ name: 'period', required: false, enum: ['week', 'month', 'campaign'] })
  async byProduct(
    @CurrentUser() user: any,
    @Query('period') period?: string,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company');
    const since = this.periodToDate(period || 'month');

    const items = await this.prisma.freightItem.findMany({
      where: { freight: { participantCompanyIds: { has: companyId }, createdAt: { gte: since } } },
      select: { grain: true, tons: true },
    });

    const map = new Map<string, number>();
    for (const i of items) {
      map.set(i.grain, (map.get(i.grain) || 0) + Number(i.tons || 0));
    }

    return Array.from(map.entries()).map(([grain, tons]) => ({ grain, tons: Math.round(tons * 100) / 100 }))
      .sort((a, b) => b.tons - a.tons);
  }

  @Get('by-month')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Monthly freight activity' })
  @ApiQuery({ name: 'months', required: false })
  async byMonth(
    @CurrentUser() user: any,
    @Query('months') months?: string,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company');
    const m = Math.min(parseInt(months || '12', 10) || 12, 24);
    const since = new Date();
    since.setMonth(since.getMonth() - m);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const freights = await this.prisma.freight.findMany({
      where: { participantCompanyIds: { has: companyId }, createdAt: { gte: since } },
      select: { createdAt: true, items: { select: { tons: true } } },
    });

    const map = new Map<string, { count: number; tons: number }>();
    for (const f of freights) {
      const key = `${f.createdAt.getFullYear()}-${String(f.createdAt.getMonth() + 1).padStart(2, '0')}`;
      const cur = map.get(key) || { count: 0, tons: 0 };
      cur.count++;
      cur.tons += f.items.reduce((s, i) => s + Number(i.tons || 0), 0);
      map.set(key, cur);
    }

    return Array.from(map.entries()).map(([month, v]) => ({ month, count: v.count, tons: Math.round(v.tons * 100) / 100 }))
      .sort((a, b) => a.month.localeCompare(b.month));
  }

  @Get('transporter-ranking')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Transporter ranking by completed freights' })
  @ApiQuery({ name: 'period', required: false, enum: ['week', 'month', 'campaign'] })
  async transporterRanking(
    @CurrentUser() user: any,
    @Query('period') period?: string,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No company');
    const since = this.periodToDate(period || 'month');

    const assignments = await this.prisma.freightAssignment.findMany({
      where: {
        freight: { participantCompanyIds: { has: companyId }, createdAt: { gte: since } },
        status: 'active',
      },
      select: {
        transportCompanyId: true,
        transportCompany: { select: { id: true, name: true } },
        tons: true,
        freight: { select: { status: true } },
      },
    });

    const map = new Map<string, { name: string; total: number; finished: number; tons: number }>();
    for (const a of assignments) {
      const id = a.transportCompanyId;
      const name = a.transportCompany?.name || 'Desconocido';
      const cur = map.get(id) || { name, total: 0, finished: 0, tons: 0 };
      cur.total++;
      if (a.freight.status === 'finished') cur.finished++;
      cur.tons += Number(a.tons || 0);
      map.set(id, cur);
    }

    return Array.from(map.entries()).map(([id, v]) => ({
      companyId: id, name: v.name, totalAssignments: v.total,
      finishedAssignments: v.finished, tons: Math.round(v.tons * 100) / 100,
    })).sort((a, b) => b.finishedAssignments - a.finishedAssignments);
  }

  private periodToDate(period: string): Date {
    const now = new Date();
    if (period === 'week') { now.setDate(now.getDate() - 7); return now; }
    if (period === 'campaign') {
      // Campaign = from March 1 of current year (or previous if before March)
      const year = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
      return new Date(year, 2, 1);
    }
    // Default: month
    now.setMonth(now.getMonth() - 1);
    return now;
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
      throw new ForbiddenException('Solo administradores de plataforma');
    }

    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }

    const [events, uniqueSessions, uniqueUsers] = await Promise.all([
      this.prisma.analyticsEvent.groupBy({
        by: ['event'],
        where,
        _count: { event: true },
        orderBy: { _count: { event: 'desc' } },
      }),
      this.prisma.analyticsEvent.groupBy({
        by: ['sessionId'],
        where: { ...where, sessionId: { not: null } },
      }),
      this.prisma.analyticsEvent.groupBy({
        by: ['userId'],
        where: { ...where, userId: { not: null } },
      }),
    ]);

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
