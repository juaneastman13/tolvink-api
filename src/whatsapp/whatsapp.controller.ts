// =====================================================================
// TOLVINK — WhatsApp Webhook Controller (Meta Cloud API)
// Handles Meta webhook: GET verification + POST incoming messages
// =====================================================================

import { Controller, Get, Post, Req, Res, Body, Param, Logger, HttpCode, Query, BadRequestException, NotFoundException } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { PrismaService } from '../database/prisma.service';
import { verifySignedToken } from '../common/signed-token';

@SkipThrottle()
@Controller('whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);
  private readonly appSecret: string | undefined;
  private readonly verifyToken: string | undefined;
  // Deduplication: track recently processed message IDs (Meta can send duplicates)
  private readonly processedMessages = new Map<string, number>();
  private readonly DEDUP_TTL_MS = 60_000; // 1 minute

  constructor(
    private config: ConfigService,
    private wa: WhatsAppService,
    private router: WhatsAppRouterService,
    private prisma: PrismaService,
  ) {
    this.appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');
    this.verifyToken = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
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
    if (mode === 'subscribe' && token === this.verifyToken) {
      this.logger.log('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      this.logger.warn(`Webhook verification failed — mode: ${mode}, token match: ${token === this.verifyToken}`);
      res.status(403).send('Forbidden');
    }
  }

  // ======================== RECEIVE MESSAGES ==============================
  // Meta sends POST with JSON body for incoming messages

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Res() res: Response) {
    // Always respond 200 immediately (Meta requires fast response)
    res.status(200).send('EVENT_RECEIVED');

    // Verify HMAC-SHA256 signature
    if (this.appSecret) {
      if (!this.verifyMetaSignature(req)) {
        this.logger.warn('Webhook signature verification failed');
        return;
      }
    }

    try {
      const body = req.body;
      this.logger.log(`Body received: ${JSON.stringify(body).slice(0, 500)}`);

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
      this.logger.log(`Message from ${phone}, type: ${message.type}`);

      // Deduplication — Meta can send the same webhook multiple times
      if (waMessageId && this.processedMessages.has(waMessageId)) {
        this.logger.log(`Duplicate message ${waMessageId}, skipping`);
        return;
      }
      if (waMessageId) {
        this.processedMessages.set(waMessageId, Date.now());
        // Cleanup old entries every 100 messages
        if (this.processedMessages.size > 100) {
          const now = Date.now();
          for (const [id, ts] of this.processedMessages) {
            if (now - ts > this.DEDUP_TTL_MS) this.processedMessages.delete(id);
          }
        }
      }

      // Parse message type and payload
      const { type, payload } = this.parseMessage(message);

      // Log inbound message
      this.prisma.whatsAppMessageLog.create({
        data: {
          waMessageId,
          phone,
          direction: 'inbound',
          type,
          content: payload,
          status: 'received',
        },
      }).catch(e => this.logger.error(`WA inbound log failed: ${e.message}`));

      // Route the message
      this.logger.log(`Routing message type=${type} to handler`);
      await this.router.handleMessage(phone, type, payload, waMessageId);
      this.logger.log('Handler completed successfully');
    } catch (e) {
      this.logger.error(`Webhook processing error: ${e.message}`, e.stack);
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
        return { type: 'text', payload: { body: '' } };

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

    // Validate internal caller: must provide appSecret
    const appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!appSecret || body.internalKey !== appSecret) {
      throw new BadRequestException('Unauthorized');
    }

    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: body.sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const token = crypto.randomUUID();
    const purposeLabel = (body.purpose || 'campo').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
    const slug = `${purposeLabel}-${crypto.randomBytes(2).toString('hex')}`;
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

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.vercel.app';
    return {
      token,
      slug,
      url: `${frontendUrl}/campo/${slug}/ubicacion`,
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

    // Find session with this token using PostgreSQL JSON containment (indexed)
    const sessions = await this.prisma.$queryRaw<any[]>`
      SELECT id, flow_state FROM whatsapp_sessions
      WHERE flow_state::jsonb @> ${JSON.stringify({ locationToken: { token: body.token } })}::jsonb
      AND expires_at > ${new Date(Date.now() - 60 * 60 * 1000)}
      LIMIT 1
    `;

    const session = sessions[0];
    if (!session) {
      this.logger.warn(`save-location: token not found — ${body.token}`);
      throw new NotFoundException('Token invalido o expirado');
    }

    // Check token age (max 30 minutes)
    const state = session.flow_state || {};
    if (!state.locationToken?.createdAt) {
      throw new BadRequestException('Token invalido o expirado');
    }
    const tokenCreated = new Date(state.locationToken.createdAt).getTime();
    const tokenAgeMin = (Date.now() - tokenCreated) / 60000;
    if (tokenAgeMin > 30) {
      throw new BadRequestException('Token expirado (max 30 min)');
    }

    // Re-read full session via Prisma for safe update
    const fullSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const fullState = (fullSession?.flowState as any) || {};

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...fullState,
          lastLocation: {
            lat: body.lat,
            lng: body.lng,
            name: body.name || '',
            address: body.address || '',
          },
          locationToken: null, // one-time use
        },
      },
    });

    this.logger.log(`Location saved for session ${session.id}: ${body.lat},${body.lng}`);

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

    const sessions = await this.prisma.$queryRaw<any[]>`
      SELECT id, flow_state FROM whatsapp_sessions
      WHERE flow_state::jsonb @> ${JSON.stringify({ locationToken: { slug: body.slug } })}::jsonb
      AND expires_at > ${new Date(Date.now() - 60 * 60 * 1000)}
      LIMIT 1
    `;

    const session = sessions[0];
    if (!session) {
      this.logger.warn(`save-location-by-slug: slug not found — ${body.slug}`);
      throw new NotFoundException('Enlace invalido o expirado');
    }

    const state = session.flow_state || {};
    if (!state.locationToken?.createdAt) {
      throw new BadRequestException('Enlace invalido o expirado');
    }
    const tokenCreated = new Date(state.locationToken.createdAt).getTime();
    const tokenAgeMin = (Date.now() - tokenCreated) / 60000;
    if (tokenAgeMin > 30) {
      throw new BadRequestException('Enlace expirado (max 30 min)');
    }

    const fullSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const fullState = (fullSession?.flowState as any) || {};

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...fullState,
          lastLocation: {
            lat: body.lat,
            lng: body.lng,
            name: body.name || '',
            address: body.address || '',
          },
          locationToken: null,
        },
      },
    });

    this.logger.log(`Location saved by slug for session ${session.id}: ${body.lat},${body.lng}`);

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
    if (!secret) throw new BadRequestException('Configuracion del servidor incompleta');

    const payload = verifySignedToken(token, secret);
    if (!payload) throw new BadRequestException('Token invalido o expirado');

    const { cid } = payload;
    if (!cid) throw new BadRequestException('Token invalido');

    // Compute "today" in Uruguay timezone (UTC-3)
    const nowUy = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const today = new Date(nowUy.getFullYear(), nowUy.getMonth(), nowUy.getDate());
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

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuracion del servidor incompleta');

    const payload = verifySignedToken(body.t, secret);
    if (!payload) throw new BadRequestException('Token invalido o expirado');

    const { uid, fid, role, name } = payload;
    if (!uid || !fid) throw new BadRequestException('Token invalido');

    // Verify freight exists and is active
    const freight = await this.prisma.freight.findUnique({
      where: { id: fid },
      select: { id: true, status: true },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (['finished', 'canceled'].includes(freight.status)) {
      throw new BadRequestException('El flete no esta activo');
    }

    await this.prisma.liveLocation.upsert({
      where: { freightId_userId: { freightId: fid, userId: uid } },
      update: {
        lat: body.lat,
        lng: body.lng,
        speed: body.speed ?? null,
        heading: body.heading ?? null,
        active: true,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2h
      },
      create: {
        freightId: fid,
        userId: uid,
        userName: name || 'Usuario',
        userRole: role || 'unknown',
        lat: body.lat,
        lng: body.lng,
        speed: body.speed ?? null,
        heading: body.heading ?? null,
        active: true,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
      },
    });

    return { success: true };
  }

  @Get('live-locations')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  async getLiveLocations(@Query('t') token: string) {
    if (!token) throw new BadRequestException('Token requerido');

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) throw new BadRequestException('Configuracion del servidor incompleta');

    const payload = verifySignedToken(token, secret);
    if (!payload) throw new BadRequestException('Token invalido o expirado');

    const { fid } = payload;
    if (!fid) throw new BadRequestException('Token invalido');

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
    if (!secret) throw new BadRequestException('Configuracion del servidor incompleta');

    const payload = verifySignedToken(body.t, secret);
    if (!payload) throw new BadRequestException('Token invalido o expirado');

    const { uid, fid } = payload;
    if (!uid || !fid) throw new BadRequestException('Token invalido');

    await this.prisma.liveLocation.updateMany({
      where: { freightId: fid, userId: uid },
      data: { active: false },
    });

    return { success: true };
  }
}
