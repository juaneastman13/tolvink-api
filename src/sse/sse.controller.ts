import { Controller, Get, Post, Query, Res, Logger, UnauthorizedException, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Response, Request } from 'express';
import { randomBytes } from 'crypto';
import { SseService } from './sse.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

// In-memory single-use tickets: ticketId → { user, expiresAt }
const sseTickets = new Map<string, { user: any; expiresAt: number }>();
const TICKET_TTL_MS = 30_000; // 30 seconds

@ApiTags('SSE')
@SkipThrottle()
@Controller('sse')
export class SseController {
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

  @Post('ticket')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get a short-lived SSE ticket (avoids JWT in URL)' })
  async getTicket(@Req() req: Request) {
    const user = (req as any).user;
    const ticket = randomBytes(32).toString('hex');
    sseTickets.set(ticket, { user, expiresAt: Date.now() + TICKET_TTL_MS });
    return { ticket };
  }

  @Get('stream')
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
    sseTickets.delete(ticket); // Single-use

    // Resolve all company IDs for this user
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
