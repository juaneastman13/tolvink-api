// =====================================================================
// TOLVINK — WhatsApp Webhook Controller (Meta Cloud API)
// Handles Meta webhook: GET verification + POST incoming messages
// =====================================================================

import { Controller, Get, Post, Req, Res, Body, Param, Logger, HttpCode, Query, BadRequestException, NotFoundException, UnauthorizedException, OnModuleDestroy } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import * as crypto from 'crypto';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { PrismaService } from '../database/prisma.service';
import { verifySignedToken } from '../common/signed-token';
import { acquirePgLockWithWait, releasePgLock } from '../common/distributed-lock';
import { sanitizeErrorForLog } from '../ai/utils/error-handler';

@Controller('whatsapp')
export class WhatsAppController implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppController.name);
  private readonly appSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  // Deduplication: track recently processed message IDs (Meta can send duplicates)
  private readonly processedMessages = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 60_000; // 1 minute
  private readonly dedupCleanupTimer: ReturnType<typeof setInterval>;
  // Per-phone rate limiting for incoming messages
  private readonly phoneRateMap = new Map<string, { count: number; resetAt: number }>();
  private readonly PHONE_RATE_LIMIT = 20; // max messages per window
  private readonly PHONE_RATE_WINDOW_MS = 60_000; // 60 seconds

  private readonly internalKey: string | undefined;

  constructor(
    private config: ConfigService,
    private wa: WhatsAppService,
    private router: WhatsAppRouterService,
    private prisma: PrismaService,
  ) {
    this.appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');
    this.verifyToken = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    this.internalKey = this.config.get<string>('INTERNAL_API_KEY');
    if (!this.appSecret) {
      this.logger.error('WHATSAPP_APP_SECRET is not set — ALL webhook requests will be REJECTED');
    }
    // Periodic cleanup of dedup map
    this.dedupCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, ts] of this.processedMessages) {
        if (now - ts > this.DEDUP_TTL_MS) this.processedMessages.delete(id);
      }
    }, this.DEDUP_TTL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.dedupCleanupTimer);
  }

  // ======================== WEBHOOK VERIFICATION ==========================
  // Meta sends GET to verify the webhook URL during setup

  @Get('webhook')
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const tokenMatch = token && this.verifyToken &&
        token.length === this.verifyToken.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(this.verifyToken));
    if (mode === 'subscribe' && tokenMatch) {
      this.logger.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      this.logger.warn(`Webhook verification failed — mode: ${mode}, tokenMatch: ${!!tokenMatch}`);
      res.status(403).send('Forbidden');
    }
  }

  // ======================== RECEIVE MESSAGES ==============================
  // Meta sends POST with JSON body for incoming messages

  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Res() res: Response) {
    // Verify HMAC-SHA256 signature BEFORE responding (prevents forged webhooks)
    if (!this.appSecret || !this.verifyMetaSignature(req)) {
      this.logger.warn('Webhook signature verification failed');
      res.status(401).send('INVALID_SIGNATURE');
      return;
    }

    // Respond 200 immediately after signature is verified (Meta requires fast response)
    res.status(200).send('EVENT_RECEIVED');

    try {
      const body = req.body;
      this.logger.log('Webhook received: entries=' + (body?.entry?.length || 0));

      if (!body?.entry?.[0]?.changes?.[0]?.value) {
        this.logger.log('No entry/changes/value found, ignoring');
        return;
      }

      const value = body.entry[0].changes[0].value;

      // Status updates (sent, delivered, read, failed)
      if (value.statuses?.[0]) {
        this.logger.log(`Status update: ${value.statuses[0].status}`);
        this.handleStatusUpdate(value.statuses[0]);
        return;
      }

      // Incoming messages
      const message = value.messages?.[0];
      if (!message) {
        this.logger.log('No message in payload, ignoring');
        return;
      }

      const phone = message.from; // E.164 without + (e.g., "59898247552")
      const waMessageId = message.id;
      const maskedPhone = phone.length > 4 ? '*'.repeat(phone.length - 4) + phone.slice(-4) : phone;
      this.logger.log(`Message from ${maskedPhone}, type: ${message.type}`);

      const { type, payload } = this.parseMessage(message);
      const maskedPayload = type === 'location' ? { type: 'location' }
        : type === 'image' || type === 'document' || type === 'audio' ? { type, mime: payload?.mime_type }
        : type === 'text' ? { type: 'text', length: payload?.body?.length || 0 }
        : { type };

      // Deduplication — Meta can send the same webhook multiple times
      if (waMessageId && this.processedMessages.has(waMessageId)) {
        this.logger.log(`Duplicate message ${waMessageId}, skipping`);
        return;
      }
      if (waMessageId) {
        // Cross-instance dedup: lock message ID, then check persistent log.
        const msgLockKey = `wa_msg:${waMessageId}`;
        const hasMsgLock = await acquirePgLockWithWait(this.prisma as any, msgLockKey, 2000, 100);
        if (!hasMsgLock) {
          this.logger.log(`Duplicate/parallel message lock busy: ${waMessageId}`);
          return;
        }
        try {
          const existing = await this.prisma.whatsAppMessageLog.findFirst({
            where: { waMessageId, direction: 'inbound' },
            select: { id: true },
          });
          if (existing) {
            this.logger.log(`Duplicate message in DB ${waMessageId}, skipping`);
            return;
          }
          await this.prisma.whatsAppMessageLog.create({
            data: {
              waMessageId,
              phone,
              direction: 'inbound',
              type,
              content: maskedPayload,
              status: 'received',
            },
          });
        } finally {
          await releasePgLock(this.prisma as any, msgLockKey);
        }

        this.processedMessages.set(waMessageId, Date.now());
        // Cleanup expired entries; evict oldest if still over cap (LRU, never full clear)
        if (this.processedMessages.size > 100) {
          const now = Date.now();
          for (const [id, ts] of this.processedMessages) {
            if (now - ts > this.DEDUP_TTL_MS) this.processedMessages.delete(id);
          }
        }
        if (this.processedMessages.size > 5000) {
          this.logger.warn(`Dedup map overflow (${this.processedMessages.size}), evicting oldest`);
          const cutoff = Date.now() - 120_000; // 2 minutes
          for (const [k, v] of this.processedMessages) {
            if (v < cutoff) this.processedMessages.delete(k);
          }
          // If still over, remove oldest
          if (this.processedMessages.size > 4000) {
            const entries = [...this.processedMessages.entries()].sort((a, b) => a[1] - b[1]);
            entries.slice(0, entries.length - 4000).forEach(([k]) => this.processedMessages.delete(k));
          }
        }
      }

      // Per-phone rate limiting — prevent abuse/spam from a single number
      const now = Date.now();
      const phoneRate = this.phoneRateMap.get(phone);
      if (phoneRate && now < phoneRate.resetAt) {
        if (phoneRate.count >= this.PHONE_RATE_LIMIT) {
          this.logger.warn(`Per-phone rate limit exceeded for ${maskedPhone} (${phoneRate.count}/${this.PHONE_RATE_LIMIT} in 60s)`);
          if (phoneRate.count === this.PHONE_RATE_LIMIT) {
            this.wa.sendText(phone, 'Estas enviando muchos mensajes seguidos. Espera un momento y volvemos a intentar.')
              .catch((err) => this.logger.warn(`Rate-limit feedback failed: ${sanitizeErrorForLog(err?.message)}`));
          }
          phoneRate.count++;
          return; // Already responded 200 to Meta above
        }
        phoneRate.count++;
      } else {
        this.phoneRateMap.set(phone, { count: 1, resetAt: now + this.PHONE_RATE_WINDOW_MS });
      }
      // Periodic cleanup of phone rate map (piggyback on dedup cleanup interval)
      if (this.phoneRateMap.size > 1000) {
        for (const [p, r] of this.phoneRateMap) {
          if (now >= r.resetAt) this.phoneRateMap.delete(p);
        }
      }

      // Parse and log already done above (with cross-instance dedup guard)

      // Route the message
      this.logger.log(`Routing message type=${type} to handler`);
      await this.router.handleMessage(phone, type, payload, waMessageId);
      this.logger.log('Handler completed successfully');
    } catch (e) {
      this.logger.error(`Webhook processing error: ${sanitizeErrorForLog((e as any)?.message)}`, (e as any)?.stack);
    }
  }

  // ======================== PARSE MESSAGE =================================

  private parseMessage(message: any): { type: string; payload: any } {
    switch (message.type) {
      case 'text':
        return {
          type: 'text',
          payload: {
            body: message.text?.body || '',
            forwarded: !!(message.context?.forwarded || message.context?.frequently_forwarded),
          },
        };

      case 'interactive':
        if (message.interactive?.type === 'button_reply') {
          return {
            type: 'button_reply',
            payload: {
              id: message.interactive.button_reply.id,
              title: message.interactive.button_reply.title,
            },
          };
        }
        if (message.interactive?.type === 'list_reply') {
          return {
            type: 'list_reply',
            payload: {
              id: message.interactive.list_reply.id,
              title: message.interactive.list_reply.title,
              description: message.interactive.list_reply.description,
            },
          };
        }
        // P2-1: Unknown interactive subtype — log and treat as text with context
        this.logger.warn(`Unknown interactive type: ${message.interactive?.type}`);
        return { type: 'text', payload: { body: message.interactive?.body?.text || '' } };

      case 'location':
        return {
          type: 'location',
          payload: {
            latitude: message.location?.latitude,
            longitude: message.location?.longitude,
            name: message.location?.name || '',
            address: message.location?.address || '',
          },
        };

      case 'button':
        // Quick reply buttons from template messages
        return {
          type: 'button_reply',
          payload: {
            id: message.button?.payload || '',
            title: message.button?.text || '',
          },
        };

      case 'audio':
        return {
          type: 'audio',
          payload: {
            mediaId: message.audio?.id,
            mimeType: message.audio?.mime_type || 'audio/ogg',
          },
        };

      case 'image':
        return {
          type: 'image',
          payload: {
            mediaId: message.image?.id,
            mimeType: message.image?.mime_type || 'image/jpeg',
            caption: message.image?.caption || '',
          },
        };

      case 'document':
        return {
          type: 'document',
          payload: {
            mediaId: message.document?.id,
            mimeType: message.document?.mime_type || 'application/pdf',
            filename: message.document?.filename || 'documento',
            caption: message.document?.caption || '',
          },
        };

      default:
        return { type: message.type || 'unknown', payload: { body: '' } };
    }
  }

  // ======================== STATUS UPDATES ================================

  private handleStatusUpdate(status: any) {
    const waMessageId = status.id;
    const statusValue = status.status; // sent, delivered, read, failed

    if (!waMessageId || !statusValue) return;

    const VALID_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);
    if (!VALID_STATUSES.has(statusValue)) return;

    this.prisma.whatsAppMessageLog.updateMany({
      where: { waMessageId },
      data: { status: statusValue },
    }).catch(e => this.logger.error(`WA status update failed: ${e.message}`));
  }

  // ======================== META SIGNATURE VERIFICATION ====================
  // https://developers.facebook.com/docs/graph-api/webhooks/getting-started

  private verifyMetaSignature(req: Request): boolean {
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature || !this.appSecret) return false;

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      this.logger.warn('Raw body not available for signature verification — rejecting');
      return false;
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    try {
      return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expected),
      );
    } catch {
      return false;
    }
  }

  // ======================== LOCATION PICKER (public, token-based) =========

  /**
   * Generate a location-picker token for a WhatsApp session.
   * Called internally by AI service — validated via internal secret.
   */
  @Post('location-token')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  async createLocationToken(@Body() body: { sessionId: string; purpose?: string; internalKey?: string }) {
    if (!body.sessionId) throw new BadRequestException('sessionId required');

    // Validate internal caller: must provide internal API key (separate from webhook secret)
    const key = this.internalKey;
    const keyMatch = key && body.internalKey &&
        key.length === body.internalKey.length &&
        timingSafeEqual(Buffer.from(body.internalKey), Buffer.from(key));
    if (!keyMatch) {
      throw new UnauthorizedException('Unauthorized');
    }

    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: body.sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const token = crypto.randomUUID();
    const purposeLabel = (body.purpose || 'campo').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
    const slug = `${purposeLabel}-${crypto.randomBytes(4).toString('hex')}`;
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: body.sessionId },
      data: {
        flowState: {
          ...state,
          locationToken: {
            token,
            slug,
            purpose: body.purpose || 'general',
            createdAt: new Date().toISOString(),
          },
        },
      },
    });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    return {
      token,
      slug,
      url: `${frontendUrl}/ubicacion/${slug}`,
    };
  }

  /**
   * Save a picked location from the frontend map picker.
   * Public endpoint — validated only by the one-time token.
   */
  @Post('save-location')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  async saveLocation(@Body() body: { token: string; lat: number; lng: number; name?: string; address?: string }) {
    if (!body.token || body.lat == null || body.lng == null) {
      throw new BadRequestException('token, lat, lng required');
    }
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' || !isFinite(body.lat) || !isFinite(body.lng) || body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180) {
      throw new BadRequestException('Invalid coordinates');
    }
    if (body.name && body.name.length > 255) body.name = body.name.slice(0, 255);
    if (body.address && body.address.length > 500) body.address = body.address.slice(0, 500);

    // Find session with this token using PostgreSQL JSON containment (indexed)
    const sessions = await this.prisma.$queryRaw<any[]>`
      SELECT id, flow_state FROM whatsapp_sessions
      WHERE flow_state::jsonb @> ${JSON.stringify({ locationToken: { token: body.token } })}::jsonb
      AND expires_at > NOW()
      LIMIT 1
    `;

    const session = sessions[0];
    if (!session) {
      this.logger.warn('save-location: token not found — ' + (body.token?.slice(0, 8) || '') + '...');
      throw new NotFoundException('Token inválido o expirado');
    }

    // Check token age (max 30 minutes)
    const state = session.flow_state || {};
    if (!state.locationToken?.createdAt) {
      throw new BadRequestException('Token inválido o expirado');
    }
    const tokenCreated = new Date(state.locationToken.createdAt).getTime();
    const tokenAgeMin = (Date.now() - tokenCreated) / 60000;
    if (tokenAgeMin > 30) {
      throw new BadRequestException('Token expirado (max 30 min)');
    }

    // Atomic: consume token + save location in one UPDATE.
    // The WHERE clause ensures only one concurrent request can succeed.
    const updated = await this.prisma.$queryRaw<any[]>`
      UPDATE whatsapp_sessions
      SET flow_state = flow_state::jsonb || ${JSON.stringify({
        lastLocation: { lat: body.lat, lng: body.lng, name: body.name || '', address: body.address || '' },
        locationToken: null,
      })}::jsonb,
      updated_at = NOW()
      WHERE id::text = ${session.id}
      AND flow_state::jsonb @> ${JSON.stringify({ locationToken: { token: body.token } })}::jsonb
      RETURNING id
    `;
    if (!updated.length) {
      throw new BadRequestException('Token ya utilizado');
    }

    this.logger.log(`Location saved for session ${session.id}`);

    // Auto-trigger AI flow continuation (fire-and-forget)
    this.router.onLocationSaved(session.id).catch(err =>
      this.logger.error(`onLocationSaved failed: ${err.message}`),
    );

    return { success: true };
  }

  /**
   * Save a picked location from the frontend map picker — by slug (clean URL).
   * Same logic as save-location but finds session by slug instead of token.
   */
  @Post('save-location-by-slug')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  async saveLocationBySlug(@Body() body: { slug: string; lat: number; lng: number; name?: string; address?: string }) {
    if (!body.slug || body.lat == null || body.lng == null) {
      throw new BadRequestException('slug, lat, lng required');
    }
    if (typeof body.slug !== 'string' || !/^[a-z0-9-]{3,30}$/.test(body.slug)) {
      throw new BadRequestException('Invalid slug format');
    }
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' || !isFinite(body.lat) || !isFinite(body.lng) || body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180) {
      throw new BadRequestException('Invalid coordinates');
    }
    if (body.name && body.name.length > 255) body.name = body.name.slice(0, 255);
    if (body.address && body.address.length > 500) body.address = body.address.slice(0, 500);

    const sessions = await this.prisma.$queryRaw<any[]>`
      SELECT id, flow_state FROM whatsapp_sessions
      WHERE flow_state::jsonb @> ${JSON.stringify({ locationToken: { slug: body.slug } })}::jsonb
      AND expires_at > NOW()
      LIMIT 1
    `;

    const session = sessions[0];
    if (!session) {
      this.logger.warn('save-location-by-slug: token not found — ' + (body.slug?.slice(0, 8) || '') + '...');
      throw new NotFoundException('Enlace inválido o expirado');
    }

    const state = session.flow_state || {};
    if (!state.locationToken?.createdAt) {
      throw new BadRequestException('Enlace inválido o expirado');
    }
    const tokenCreated = new Date(state.locationToken.createdAt).getTime();
    const tokenAgeMin = (Date.now() - tokenCreated) / 60000;
    if (tokenAgeMin > 30) {
      throw new BadRequestException('Enlace expirado (max 30 min)');
    }

    // Atomic: consume slug + save location in one UPDATE.
    const updated = await this.prisma.$queryRaw<any[]>`
      UPDATE whatsapp_sessions
      SET flow_state = flow_state::jsonb || ${JSON.stringify({
        lastLocation: { lat: body.lat, lng: body.lng, name: body.name || '', address: body.address || '' },
        locationToken: null,
      })}::jsonb,
      updated_at = NOW()
      WHERE id::text = ${session.id}
      AND flow_state::jsonb @> ${JSON.stringify({ locationToken: { slug: body.slug } })}::jsonb
      RETURNING id
    `;
    if (!updated.length) {
      throw new BadRequestException('Enlace ya utilizado');
    }

    this.logger.log(`Location saved for session ${session.id}`);

    this.router.onLocationSaved(session.id).catch(err =>
      this.logger.error(`onLocationSaved failed: ${err.message}`),
    );

    return { success: true };
  }

  // ======================== DAILY MAP DATA ================================

  @Get('daily-map-data')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async getDailyMapData(@Query('t') token: string) {
    if (!token) throw new BadRequestException('Token requerido');

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuración del servidor incompleta');

    const payload = verifySignedToken(token, secret);
    if (!payload) throw new BadRequestException('Token inválido o expirado');

    const { cid } = payload;
    if (!cid) throw new BadRequestException('Token inválido');

    // Compute "today" in Uruguay timezone (America/Montevideo)
    const nowUyStr = new Date().toLocaleString('en-US', { timeZone: 'America/Montevideo' });
    const nowUy = new Date(nowUyStr);
    const today = new Date(Date.UTC(nowUy.getFullYear(), nowUy.getMonth(), nowUy.getDate()));
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const freights = await this.prisma.freight.findMany({
      where: {
        loadDate: { gte: today, lt: tomorrow },
        OR: [
          { originCompanyId: cid },
          { destCompanyId: cid },
          { assignments: { some: { transportCompanyId: cid, status: { in: ['active', 'accepted'] } } } },
        ],
      },
      select: {
        code: true,
        status: true,
        originName: true,
        originLat: true,
        originLng: true,
        destName: true,
        destLat: true,
        destLng: true,
        items: { select: { grain: true, tons: true }, take: 1 },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          take: 1,
          select: {
            transportCompany: { select: { name: true } },
            driverName: true,
            plate: true,
            driver: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return freights.map(f => {
      const a = f.assignments[0];
      const item = f.items[0];
      return {
        code: f.code,
        status: f.status,
        grain: item?.grain || null,
        tons: item?.tons ? Number(item.tons) : null,
        originName: f.originName,
        originLat: f.originLat ? Number(f.originLat) : null,
        originLng: f.originLng ? Number(f.originLng) : null,
        destName: f.destName,
        destLat: f.destLat ? Number(f.destLat) : null,
        destLng: f.destLng ? Number(f.destLng) : null,
        transporterName: a?.transportCompany?.name || null,
        driverName: a?.driver?.name || a?.driverName || null,
        plate: a?.plate || null,
      };
    });
  }

  // ======================== LIVE LOCATION =================================

  @Post('live-location')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  async upsertLiveLocation(@Body() body: { t: string; lat: number; lng: number; speed?: number; heading?: number }) {
    if (!body.t || body.lat == null || body.lng == null) {
      throw new BadRequestException('t, lat, lng requeridos');
    }

    // Validate coordinate bounds
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' ||
        body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180 ||
        !isFinite(body.lat) || !isFinite(body.lng)) {
      throw new BadRequestException('Coordenadas inválidas (lat: -90..90, lng: -180..180)');
    }

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuración del servidor incompleta');

    const payload = verifySignedToken(body.t, secret);
    if (!payload) throw new BadRequestException('Token inválido o expirado');

    const { uid, fid, role, name } = payload;
    if (!uid || !fid) throw new BadRequestException('Token inválido');

    // Verify freight exists and is active
    const freight = await this.prisma.freight.findUnique({
      where: { id: fid },
      select: { id: true, status: true },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (['finished', 'canceled'].includes(freight.status)) {
      throw new BadRequestException('El flete no está activo');
    }

    const safeSpeed = (typeof body.speed === 'number' && isFinite(body.speed) && body.speed >= 0) ? body.speed : null;
    const safeHeading = (typeof body.heading === 'number' && isFinite(body.heading) && body.heading >= 0 && body.heading <= 360) ? body.heading : null;

    await this.prisma.liveLocation.upsert({
      where: { freightId_userId: { freightId: fid, userId: uid } },
      update: {
        lat: body.lat,
        lng: body.lng,
        speed: safeSpeed,
        heading: safeHeading,
        active: true,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h
      },
      create: {
        freightId: fid,
        userId: uid,
        userName: (name || 'Usuario').slice(0, 100),
        userRole: role || 'unknown',
        lat: body.lat,
        lng: body.lng,
        speed: safeSpeed,
        heading: safeHeading,
        active: true,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });

    // Also write to FreightTracking for public tracking screen + historical audit trail
    this.prisma.freightTracking.create({
      data: {
        freightId: fid,
        userId: uid,
        lat: body.lat,
        lng: body.lng,
        speed: safeSpeed,
        heading: safeHeading,
      },
    }).catch((err) => {
      this.logger.warn(`FreightTracking write failed: ${err.message}`);
    });

    return { success: true };
  }

  @Get('live-locations')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async getLiveLocations(@Query('t') token: string) {
    if (!token) throw new BadRequestException('Token requerido');

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuración del servidor incompleta');

    const payload = verifySignedToken(token, secret);
    if (!payload) throw new BadRequestException('Token inválido o expirado');

    const { fid } = payload;
    if (!fid) throw new BadRequestException('Token inválido');

    // Get freight data for map context
    const freight = await this.prisma.freight.findUnique({
      where: { id: fid },
      select: {
        code: true, status: true,
        originName: true, originLat: true, originLng: true,
        destName: true, destLat: true, destLng: true,
        items: { select: { grain: true, tons: true }, take: 1 },
      },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    // Get active live locations
    const locations = await this.prisma.liveLocation.findMany({
      where: {
        freightId: fid,
        active: true,
        expiresAt: { gt: new Date() },
      },
      select: {
        userId: true,
        userName: true,
        userRole: true,
        lat: true,
        lng: true,
        speed: true,
        heading: true,
        updatedAt: true,
      },
    });

    const item = freight.items[0];
    return {
      freight: {
        code: freight.code,
        status: freight.status,
        grain: item?.grain || null,
        tons: item?.tons ? Number(item.tons) : null,
        originName: freight.originName,
        originLat: freight.originLat ? Number(freight.originLat) : null,
        originLng: freight.originLng ? Number(freight.originLng) : null,
        destName: freight.destName,
        destLat: freight.destLat ? Number(freight.destLat) : null,
        destLng: freight.destLng ? Number(freight.destLng) : null,
      },
      locations: locations.map(l => ({
        userId: l.userId,
        userName: l.userName,
        userRole: l.userRole,
        lat: Number(l.lat),
        lng: Number(l.lng),
        speed: l.speed ? Number(l.speed) : null,
        heading: l.heading ? Number(l.heading) : null,
        updatedAt: l.updatedAt.toISOString(),
      })),
    };
  }

  @Post('live-location/stop')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @HttpCode(200)
  async stopLiveLocation(@Body() body: { t: string }) {
    if (!body.t) throw new BadRequestException('Token requerido');

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuración del servidor incompleta');

    const payload = verifySignedToken(body.t, secret);
    if (!payload) throw new BadRequestException('Token inválido o expirado');

    const { uid, fid } = payload;
    if (!uid || !fid) throw new BadRequestException('Token inválido');

    await this.prisma.liveLocation.updateMany({
      where: { freightId: fid, userId: uid },
      data: { active: false },
    });

    return { success: true };
  }
}
