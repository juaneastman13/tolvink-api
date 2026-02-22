// =====================================================================
// TOLVINK — WhatsApp Service via Twilio
// Sends messages via Twilio WhatsApp API
// Buttons/lists are rendered as numbered text options
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

const TWILIO_API = 'https://api.twilio.com/2010-04-01/Accounts';

export interface WAButton {
  id: string;    // callback payload
  title: string; // button label
}

export interface WAListRow {
  id: string;
  title: string;
  description?: string;
}

export interface WAListSection {
  title: string;
  rows: WAListRow[];
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly accountSid: string | undefined;
  private readonly authToken: string | undefined;
  private readonly fromNumber: string | undefined;
  private readonly enabled: boolean;

  // In-memory mapping: phone → last sent options (for numbered reply resolution)
  private pendingOptions = new Map<string, Array<{ id: string; title: string }>>();

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.accountSid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    this.authToken = this.config.get<string>('TWILIO_AUTH_TOKEN');
    this.fromNumber = this.config.get<string>('TWILIO_WHATSAPP_NUMBER');
    this.enabled = !!(this.accountSid && this.authToken && this.fromNumber);

    if (this.enabled) {
      this.logger.log(`WhatsApp (Twilio) configured — from: ${this.fromNumber}`);
    } else {
      this.logger.warn('WhatsApp not configured — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_WHATSAPP_NUMBER missing');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ======================== SEND TEXT MESSAGE ============================

  async sendText(phone: string, text: string): Promise<string | null> {
    return this.send(phone, text);
  }

  // ======================== SEND BUTTONS (as numbered text) ==============
  // Twilio sandbox doesn't support native interactive buttons,
  // so we render them as numbered options and resolve replies later.

  async sendButtons(phone: string, bodyText: string, buttons: WAButton[]): Promise<string | null> {
    const normalized = this.normalizePhone(phone);

    // Build text with numbered options
    const optionLines = buttons.map((b, i) => `*${i + 1}.* ${b.title}`).join('\n');
    const text = `${bodyText}\n\n${optionLines}`;

    // Store options for numbered reply resolution
    this.pendingOptions.set(normalized, buttons.map(b => ({ id: b.id, title: b.title })));

    return this.send(phone, text);
  }

  // ======================== SEND LIST (as numbered text) =================

  async sendList(
    phone: string,
    bodyText: string,
    _buttonLabel: string,
    sections: WAListSection[],
  ): Promise<string | null> {
    const normalized = this.normalizePhone(phone);

    // Flatten all rows across sections
    const allRows: Array<{ id: string; title: string; description?: string }> = [];
    for (const section of sections) {
      for (const row of section.rows) {
        allRows.push(row);
      }
    }

    // Build text with numbered options
    const optionLines = allRows.map((r, i) =>
      `*${i + 1}.* ${r.title}${r.description ? ` — ${r.description}` : ''}`,
    ).join('\n');
    const text = `${bodyText}\n\n${optionLines}`;

    // Store for numbered reply resolution
    this.pendingOptions.set(normalized, allRows.map(r => ({ id: r.id, title: r.title })));

    return this.send(phone, text);
  }

  // ======================== SEND TEMPLATE (as plain text) ================

  async sendTemplate(
    phone: string,
    _templateName: string,
    _languageCode: string,
    _components?: any[],
  ): Promise<string | null> {
    // Twilio sandbox doesn't use Meta templates — just send as text
    // The caller should also pass the text content directly via sendText/sendButtons
    return null;
  }

  // ======================== MARK AS READ (no-op for Twilio) ==============

  async markRead(_waMessageId: string): Promise<void> {
    // Twilio doesn't support marking messages as read
  }

  // ======================== RESOLVE NUMBERED REPLY =======================
  // When user replies "1", "2", etc., resolve to the original button/list option

  resolveNumberedReply(phone: string, text: string): { type: string; payload: any } | null {
    const normalized = this.normalizePhone(phone);
    const options = this.pendingOptions.get(normalized);
    if (!options) return null;

    const num = parseInt(text.trim(), 10);
    if (isNaN(num) || num < 1 || num > options.length) return null;

    const selected = options[num - 1];
    this.pendingOptions.delete(normalized);

    return {
      type: 'button_reply',
      payload: { id: selected.id, title: selected.title },
    };
  }

  // ======================== INTERNAL: SEND VIA TWILIO ====================

  private async send(phone: string, body: string): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug(`WhatsApp disabled, skipping message to ${phone}`);
      return null;
    }

    const normalized = this.normalizePhone(phone);
    const to = `whatsapp:+${normalized}`;
    const from = `whatsapp:${this.fromNumber!.startsWith('+') ? this.fromNumber : '+' + this.fromNumber}`;

    try {
      const data = await this.callTwilio(to, from, body);
      const messageSid = data?.sid || null;

      // Log outbound message (fire-and-forget)
      this.prisma.whatsAppMessageLog.create({
        data: {
          waMessageId: messageSid,
          phone: normalized,
          direction: 'outbound',
          type: 'text',
          content: { body },
          status: 'sent',
        },
      }).catch(e => this.logger.error(`WA log write failed: ${e.message}`));

      return messageSid;
    } catch (e) {
      this.logger.error(`WhatsApp send to ${normalized} failed: ${e.message}`);

      this.prisma.whatsAppMessageLog.create({
        data: {
          phone: normalized,
          direction: 'outbound',
          type: 'text',
          content: { body },
          status: 'failed',
        },
      }).catch(() => {});

      return null;
    }
  }

  private async callTwilio(to: string, from: string, body: string): Promise<any> {
    const url = `${TWILIO_API}/${this.accountSid}/Messages.json`;
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');

    const formBody = new URLSearchParams({ To: to, From: from, Body: body });

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Twilio API ${res.status}: ${errorBody}`);
    }

    return res.json();
  }

  /** Normalize phone to E.164 digits (no +), Uruguay default +598 */
  normalizePhone(phone: string): string {
    let p = phone.replace(/[\s\-\(\)]/g, '');
    // Remove whatsapp: prefix if present (Twilio format)
    if (p.startsWith('whatsapp:')) p = p.replace('whatsapp:', '');
    // Remove +
    if (p.startsWith('+')) p = p.slice(1);
    // Already has country code
    if (p.startsWith('598')) return p;
    // Local Uruguay (09x...)
    if (p.startsWith('0')) return '598' + p.slice(1);
    // Short form (9x...)
    if (p.length === 8 || p.length === 9) return '598' + p;
    return p;
  }
}
