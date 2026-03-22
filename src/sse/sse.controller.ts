import { Controller, Get, Post, Query, Res, Logger, UnauthorizedException, UseGuards, Req, OnModuleDestroy, HttpException, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { randomBytes } from 'crypto';
import { SseService } from './sse.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

// In-memory single-use tickets: ticketId → { user, expiresAt }
const sseTickets = new Map<string, { user: any; expiresAt: number }>();
const TICKET_TTL_MS = 30_000; // 30 seconds

// Per-user rate limiting for ticket creation
const ticketRateMap = new Map<string, { count: number; resetAt: number }>();
const TICKET_RATE_LIMIT = 10; // max tickets per window
const TICKET_RATE_WINDOW_MS = 60_000; // 60 seconds

@ApiTags('SSE')
@Controller('sse')
export class SseController implements OnModuleDestroy {
  private readonly logger = new Logger(SseController.name);
  private ticketCleanupTimer: ReturnType<typeof setInterval>;

  constructor(
    private sseService: SseService,
    private companyRes: CompanyResolutionService,
  ) {
    // Clean expired tickets every 60s
    this.ticketCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of sseTickets) {
        if (v.expiresAt < now) sseTickets.delete(k);
      }
    }, 60_000);
  }

  onModuleDestroy() {
    clearInterval(this.ticketCleanupTimer);
  }

  @Post('ticket')
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Get a short-lived SSE ticket (avoids JWT in URL)' })
  async getTicket(@Req() req: Request) {
    const user = (req as any).user;
    const userId = user.sub || user.id;

    // Per-user rate limiting for ticket creation
    const now = Date.now();
    const userRate = ticketRateMap.get(userId);
    if (userRate && now < userRate.resetAt) {
      if (userRate.count >= TICKET_RATE_LIMIT) {
        throw new HttpException('Demasiadas solicitudes de ticket SSE', HttpStatus.TOO_MANY_REQUESTS);
      }
      userRate.count++;
    } else {
      ticketRateMap.set(userId, { count: 1, resetAt: now + TICKET_RATE_WINDOW_MS });
    }
    // Periodic cleanup of rate map
    if (ticketRateMap.size > 1000) {
      for (const [k, v] of ticketRateMap) {
        if (now >= v.resetAt) ticketRateMap.delete(k);
      }
    }

    // Bound ticket map — evict expired first, then oldest by insertion order if still over cap
    if (sseTickets.size > 5_000) {
      const now = Date.now();
      for (const [k, v] of sseTickets) {
        if (v.expiresAt < now) sseTickets.delete(k);
      }
      // If still over cap after evicting expired, remove oldest entries (Map iterates in insertion order)
      if (sseTickets.size > 5_000) {
        let toRemove = sseTickets.size - 5_000;
        for (const k of sseTickets.keys()) {
          if (toRemove-- <= 0) break;
          sseTickets.delete(k);
        }
      }
    }
    const ticket = randomBytes(32).toString('hex');
    sseTickets.set(ticket, { user, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket };
  }

  @Get('stream')
  @SkipThrottle()
  @ApiOperation({ summary: 'SSE stream for real-time updates' })
  async stream(@Query('ticket') ticket: string, @Res() res: Response) {
    if (!ticket) {
      throw new UnauthorizedException('Ticket required');
    }

    const entry = sseTickets.get(ticket);
    if (!entry || entry.expiresAt < Date.now()) {
      sseTickets.delete(ticket);
      throw new UnauthorizedException('Invalid or expired ticket');
    }
    const user = entry.user;
    sseTickets.delete(ticket); // Single-use — delete BEFORE any await to prevent double-use

    // Resolve all company IDs for this user (safe: ticket already consumed above)
    const companyIds = await this.companyRes.resolveAllCompanyIds(user);

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ userId: user.sub })}\n\n`);

    // Register client
    this.sseService.addClient(user.sub, companyIds, res);
  }
}
