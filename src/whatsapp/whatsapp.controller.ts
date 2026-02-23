// =====================================================================
// TOLVINK — WhatsApp Webhook Controller (Meta Cloud API)
// Handles Meta webhook: GET verification + POST incoming messages
// =====================================================================

import { Controller, Get, Post, Req, Res, Body, Param, Logger, HttpCode, Query, BadRequestException, NotFoundException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { PrismaService } from '../database/prisma.service';

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
      const sigOk = this.verifyMetaSignature(req);
      console.log(`[WA-WEBHOOK] Signature verification: ${sigOk ? 'PASS' : 'FAIL'}`);
      if (!sigOk) {
        return;
      }
    } else {
      console.log('[WA-WEBHOOK] No APP_SECRET configured, skipping signature check');
    }

    try {
      const body = req.body;
      console.log('[WA-WEBHOOK] Body received:', JSON.stringify(body).slice(0, 500));

      if (!body?.entry?.[0]?.changes?.[0]?.value) {
        console.log('[WA-WEBHOOK] No entry/changes/value found, ignoring');
        return;
      }

      const value = body.entry[0].changes[0].value;

      // Status updates (sent, delivered, read, failed)
      if (value.statuses?.[0]) {
        console.log('[WA-WEBHOOK] Status update:', value.statuses[0].status);
        this.handleStatusUpdate(value.statuses[0]);
        return;
      }

      // Incoming messages
      const message = value.messages?.[0];
      if (!message) {
        console.log('[WA-WEBHOOK] No message in payload, ignoring');
        return;
      }

      const phone = message.from; // E.164 without + (e.g., "59898247552")
      const waMessageId = message.id;
      console.log(`[WA-WEBHOOK] Message from ${phone}, type: ${message.type}`);

      // Deduplication — Meta can send the same webhook multiple times
      if (waMessageId && this.processedMessages.has(waMessageId)) {
        console.log(`[WA-WEBHOOK] Duplicate message ${waMessageId}, skipping`);
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
      console.log(`[WA-WEBHOOK] Routing message type=${type} to handler`);
      await this.router.handleMessage(phone, type, payload, waMessageId);
      console.log(`[WA-WEBHOOK] Handler completed successfully`);
    } catch (e) {
      console.error(`[WA-WEBHOOK] ERROR: ${e.message}`, e.stack);
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
      this.logger.warn('Raw body not available for signature verification');
      return true; // Allow if raw body not captured (graceful degradation)
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
   * Called internally by AI service — no JWT auth needed.
   */
  @Post('location-token')
  @HttpCode(200)
  async createLocationToken(@Body() body: { sessionId: string; purpose?: string }) {
    if (!body.sessionId) throw new BadRequestException('sessionId required');

    const session = await this.prisma.whatsAppSession.findUnique({ where: { id: body.sessionId } });
    if (!session) throw new NotFoundException('Session not found');

    const token = crypto.randomUUID();
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: body.sessionId },
      data: {
        flowState: {
          ...state,
          locationToken: {
            token,
            purpose: body.purpose || 'general',
            createdAt: new Date().toISOString(),
          },
        },
      },
    });

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.vercel.app';
    return {
      token,
      url: `${frontendUrl}/pick-location?token=${token}`,
    };
  }

  /**
   * Save a picked location from the frontend map picker.
   * Public endpoint — validated only by the one-time token.
   */
  @Post('save-location')
  @HttpCode(200)
  async saveLocation(@Body() body: { token: string; lat: number; lng: number; name?: string; address?: string }) {
    if (!body.token || body.lat == null || body.lng == null) {
      throw new BadRequestException('token, lat, lng required');
    }

    // Find session with this token — search ALL sessions (including recently expired)
    const sessions = await this.prisma.whatsAppSession.findMany({
      where: {
        expiresAt: { gt: new Date(Date.now() - 60 * 60 * 1000) }, // include up to 1h expired
      },
    });

    const session = sessions.find((s: any) => {
      const state = (s.flowState as any) || {};
      return state.locationToken?.token === body.token;
    });

    if (!session) {
      throw new NotFoundException('Token invalido o expirado');
    }

    // Check token age (max 15 minutes)
    const state = (session.flowState as any) || {};
    const tokenCreated = new Date(state.locationToken.createdAt).getTime();
    if (Date.now() - tokenCreated > 15 * 60 * 1000) {
      throw new BadRequestException('Token expirado (max 15 min)');
    }

    // Save location and clear token
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
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
    return { success: true };
  }
}
