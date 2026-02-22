// =====================================================================
// TOLVINK — WhatsApp Webhook Controller (Twilio)
// Handles Twilio WhatsApp webhook: incoming messages + status callbacks
// =====================================================================

import { Controller, Post, Req, Res, Logger, HttpCode } from '@nestjs/common';
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
  private readonly authToken: string | undefined;

  constructor(
    private config: ConfigService,
    private wa: WhatsAppService,
    private router: WhatsAppRouterService,
    private prisma: PrismaService,
  ) {
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
  }

  // ======================== RECEIVE MESSAGES ============================
  // Twilio sends POST with application/x-www-form-urlencoded
  // Fields: From, To, Body, MessageSid, NumMedia, SmsStatus, etc.

  @Post('webhook')
  @HttpCode(200)
  async receive(@Req() req: Request, @Res() res: Response) {
    // Respond with empty TwiML to acknowledge (Twilio expects XML or empty 200)
    res.set('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');

    // Verify Twilio signature if auth token configured
    if (this.authToken && !this.verifyTwilioSignature(req)) {
      this.logger.warn('Twilio webhook signature verification failed');
      return;
    }

    try {
      const body = req.body;
      if (!body) return;

      // Twilio sends status callbacks for outbound messages
      if (body.SmsStatus && body.MessageSid && !body.Body && body.SmsStatus !== 'received') {
        this.handleStatusCallback(body);
        return;
      }

      // Incoming message
      const from = body.From; // "whatsapp:+598XXXXXXXX"
      const msgBody = body.Body || '';
      const messageSid = body.MessageSid || '';

      if (!from || !msgBody) return;

      // Extract phone from Twilio format "whatsapp:+598..."
      const phone = from.replace('whatsapp:', '').replace('+', '');

      await this.processMessage(phone, messageSid, msgBody);
    } catch (e) {
      this.logger.error(`Webhook processing error: ${e.message}`, e.stack);
    }
  }

  // ======================== STATUS CALLBACK =============================
  // Twilio sends callbacks for outbound message status changes

  @Post('status')
  @HttpCode(200)
  statusCallback(@Req() req: Request, @Res() res: Response) {
    res.status(200).send('OK');

    try {
      this.handleStatusCallback(req.body);
    } catch (e) {
      this.logger.error(`Status callback error: ${e.message}`);
    }
  }

  // ======================== PROCESS MESSAGE =============================

  private async processMessage(phone: string, messageSid: string, text: string) {
    // Check if the text is a numbered reply to a previous buttons/list message
    const resolved = this.wa.resolveNumberedReply(phone, text);

    let type: string;
    let payload: any;

    if (resolved) {
      // User replied with a number → treat as button/list reply
      type = resolved.type;
      payload = resolved.payload;
    } else {
      // Regular text message
      type = 'text';
      payload = { body: text };
    }

    // Log inbound message
    this.prisma.whatsAppMessageLog.create({
      data: {
        waMessageId: messageSid,
        phone,
        direction: 'inbound',
        type,
        content: payload,
        status: 'received',
      },
    }).catch(e => this.logger.error(`WA inbound log failed: ${e.message}`));

    // Route the message
    await this.router.handleMessage(phone, type, payload, messageSid);
  }

  // ======================== STATUS UPDATES ==============================

  private handleStatusCallback(body: any) {
    const messageSid = body.MessageSid;
    const status = body.SmsStatus || body.MessageStatus; // queued, sent, delivered, read, failed, undelivered

    if (!messageSid || !status) return;

    this.prisma.whatsAppMessageLog.updateMany({
      where: { waMessageId: messageSid },
      data: { status },
    }).catch(e => this.logger.error(`WA status update failed: ${e.message}`));
  }

  // ======================== TWILIO SIGNATURE VERIFICATION ================
  // https://www.twilio.com/docs/usage/security#validating-requests

  private verifyTwilioSignature(req: Request): boolean {
    const signature = req.headers['x-twilio-signature'] as string;
    if (!signature || !this.authToken) return false;

    // Build the full URL that Twilio used to call us
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const url = `${protocol}://${req.headers.host}${req.originalUrl}`;

    // Sort POST parameters and concatenate
    const params = req.body || {};
    const sortedKeys = Object.keys(params).sort();
    let dataString = url;
    for (const key of sortedKeys) {
      dataString += key + params[key];
    }

    const expected = crypto
      .createHmac('sha1', this.authToken)
      .update(dataString)
      .digest('base64');

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
