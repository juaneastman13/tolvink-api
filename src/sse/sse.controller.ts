import { Controller, Get, Query, Res, Logger, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtService } from '@nestjs/jwt';
import { Response } from 'express';
import { SseService } from './sse.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';

@ApiTags('SSE')
@SkipThrottle()
@Controller('sse')
export class SseController {
  private readonly logger = new Logger(SseController.name);

  constructor(
    private sseService: SseService,
    private jwt: JwtService,
    private companyRes: CompanyResolutionService,
  ) {}

  @Get('stream')
  @ApiOperation({ summary: 'SSE stream for real-time updates' })
  async stream(@Query('token') token: string, @Res() res: Response) {
    if (!token) {
      throw new UnauthorizedException('Token required');
    }

    let user: any;
    try {
      user = this.jwt.verify(token);
    } catch {
      throw new UnauthorizedException('Invalid token');
    }

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
