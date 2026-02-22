// =====================================================================
// TOLVINK — WhatsApp Webhook Controller
// Handles Meta webhook verification + incoming messages
// =====================================================================

import { Controller, Get, Post, Req, Res, Logger, HttpCode } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { WhatsAppRouterService } from './whatsapp-router.service';
import { PrismaService } from '../database/prisma.service';

@SkipThrottle()
@Controller('whatsapp')
export class WhatsAppController {
  private readonly logger = new Logger(WhatsAppController.name);
  private readonly verifyToken: string;
  private readonly appSecret: string | undefined;

  constructor(
    private config: ConfigService,
    private router: WhatsAppRouterService,
    private prisma: PrismaService,
  ) {
    this.verifyToken = this.config.get<string>('WHATSAPP_VERIFY_TOKEN') || 'tolvink_wa_verify';
    this.appSecret = this.config.get<string>('WHATSAPP_APP_SECRET');
  }

  // ======================== WEBHOOK VERIFICATION ========================
  // Meta sends GET to verify the webhook URL during setup

  @Get('webhook')
  verify(@Req() req: Request, @Res() res: Response) {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === this.verifyToken) {
      this.logger.log('WhatsApp webhook verified');
      return res.status(200).send(challenge);
    }

    this.logger.warn(`WhatsApp webhook verification failed: mode=${mode}, token=${token}`);
    return res.status(403).send('Forbidden');
  }

  // ======================== RECEIVE MESSAGES ============================
  // Meta sends POST with incoming messages + status updates

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Res() res: Response) {
    // Always respond 200 immediately (Meta requires fast response)
    res.status(200).send('OK');

    // Verify HMAC signature if app secret configured
    if (this.appSecret && !this.verifySignature(req)) {
      this.logger.warn('WhatsApp webhook signature verification failed');
      return;
    }

    try {
      const body = req.body;
      if (!body?.entry?.[0]?.changes?.[0]?.value) return;

      const value = body.entry[0].changes[0].value;

      // Handle status updates (delivered, read, etc.)
      if (value.statuses) {
        for (const status of value.statuses) {
          this.handleStatusUpdate(status);
        }
      }

      // Handle incoming messages
      if (value.messages) {
        for (const message of value.messages) {
          const phone = message.from;
          const waMessageId = message.id;
          const contactName = value.contacts?.[0]?.profile?.name || '';

          await this.processMessage(phone, waMessageId, message, contactName);
        }
      }
    } catch (e) {
      this.logger.error(`Webhook processing error: ${e.message}`, e.stack);
    }
  }

  // ======================== PROCESS MESSAGE =============================

  private async processMessage(phone: string, waMessageId: string, message: any, contactName: string) {
    let type: string;
    let payload: any;

    switch (message.type) {
      case 'text':
        type = 'text';
        payload = { body: message.text?.body || '' };
        break;

      case 'interactive':
        if (message.interactive?.type === 'button_reply') {
          type = 'button_reply';
          payload = {
            id: message.interactive.button_reply.id,
            title: message.interactive.button_reply.title,
          };
        } else if (message.interactive?.type === 'list_reply') {
          type = 'list_reply';
          payload = {
            id: message.interactive.list_reply.id,
            title: message.interactive.list_reply.title,
            description: message.interactive.list_reply.description,
          };
        } else {
          type = 'interactive';
          payload = message.interactive;
        }
        break;

      default:
        // image, audio, document, location, etc. — ignore for now
        type = message.type;
        payload = {};
        break;
    }

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
  }

  // ======================== STATUS UPDATES ==============================

  private handleStatusUpdate(status: any) {
    const waMessageId = status.id;
    const newStatus = status.status; // sent, delivered, read, failed

    if (!waMessageId || !newStatus) return;

    this.prisma.whatsAppMessageLog.updateMany({
      where: { waMessageId },
      data: { status: newStatus },
    }).catch(e => this.logger.error(`WA status update failed: ${e.message}`));
  }

  // ======================== HMAC VERIFICATION ===========================

  private verifySignature(req: Request): boolean {
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature || !this.appSecret) return false;

    const rawBody = (req as any).rawBody;
    if (!rawBody) {
      this.logger.warn('No raw body available for HMAC verification');
      return false;
    }

    const expected = 'sha256=' + crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  }
}
