// =====================================================================
// TOLVINK — WhatsApp Webhook Controller (Meta Cloud API)
// Handles Meta webhook: GET verification + POST incoming messages
// =====================================================================

import { Controller, Get, Post, Req, Res, Logger, HttpCode, Query } from '@nestjs/common';
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
    if (this.appSecret && !this.verifyMetaSignature(req)) {
      this.logger.warn('Meta webhook signature verification failed');
      return;
    }

    try {
      const body = req.body;
      if (!body?.entry?.[0]?.changes?.[0]?.value) return;

      const value = body.entry[0].changes[0].value;

      // Status updates (sent, delivered, read, failed)
      if (value.statuses?.[0]) {
        this.handleStatusUpdate(value.statuses[0]);
        return;
      }

      // Incoming messages
      const message = value.messages?.[0];
      if (!message) return;

      const phone = message.from; // E.164 without + (e.g., "59898247552")
      const waMessageId = message.id;

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
      await this.router.handleMessage(phone, type, payload, waMessageId);
    } catch (e) {
      this.logger.error(`Webhook processing error: ${e.message}`, e.stack);
    }
  }

  // ======================== PARSE MESSAGE =================================

  private parseMessage(message: any): { type: string; payload: any } {
    switch (message.type) {
      case 'text':
        return { type: 'text', payload: { body: message.text?.body || '' } };

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

      case 'button':
        // Quick reply buttons from template messages
        return {
          type: 'button_reply',
          payload: {
            id: message.button?.payload || '',
            title: message.button?.text || '',
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
}
