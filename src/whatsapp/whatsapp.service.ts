// =====================================================================
// TOLVINK — WhatsApp Business API Service (Meta Cloud API)
// Sends messages via Meta Graph API v21.0
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';

const META_API = 'https://graph.facebook.com/v21.0';

export interface WAButton {
  id: string;   // callback payload (max 256 chars)
  title: string; // button label (max 20 chars)
}

export interface WAListRow {
  id: string;          // callback payload (max 200 chars)
  title: string;       // row title (max 24 chars)
  description?: string; // optional description (max 72 chars)
}

export interface WAListSection {
  title: string;       // section header (max 24 chars)
  rows: WAListRow[];
}

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly phoneNumberId: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly enabled: boolean;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    this.enabled = !!(this.phoneNumberId && this.accessToken);

    if (this.enabled) {
      this.logger.log('WhatsApp Business API configured');
    } else {
      this.logger.warn('WhatsApp not configured — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN missing');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ======================== SEND TEXT MESSAGE ============================

  async sendText(phone: string, text: string): Promise<string | null> {
    return this.send(phone, {
      type: 'text',
      text: { preview_url: false, body: text },
    });
  }

  // ======================== SEND BUTTONS (max 3) ========================

  async sendButtons(phone: string, bodyText: string, buttons: WAButton[]): Promise<string | null> {
    if (buttons.length > 3) {
      this.logger.warn(`Button limit exceeded (${buttons.length}), truncating to 3`);
      buttons = buttons.slice(0, 3);
    }

    return this.send(phone, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
  }

  // ======================== SEND LIST (max 10 rows total) ===============

  async sendList(
    phone: string,
    bodyText: string,
    buttonLabel: string,
    sections: WAListSection[],
  ): Promise<string | null> {
    return this.send(phone, {
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: sections.map(s => ({
            title: s.title.slice(0, 24),
            rows: s.rows.map(r => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
  }

  // ======================== SEND TEMPLATE ================================

  async sendTemplate(
    phone: string,
    templateName: string,
    languageCode: string,
    components?: any[],
  ): Promise<string | null> {
    return this.send(phone, {
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
  }

  // ======================== MARK AS READ ================================

  async markRead(waMessageId: string): Promise<void> {
    if (!this.enabled) return;

    try {
      await this.callApi({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      });
    } catch (e) {
      this.logger.error(`markRead failed: ${e.message}`);
    }
  }

  // ======================== INTERNAL: SEND & LOG ========================

  private async send(phone: string, messagePayload: any): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug(`WhatsApp disabled, skipping message to ${phone}`);
      return null;
    }

    const normalized = this.normalizePhone(phone);

    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalized,
      ...messagePayload,
    };

    try {
      const data = await this.callApi(body);
      const waMessageId = data?.messages?.[0]?.id || null;

      // Log outbound message (fire-and-forget)
      this.prisma.whatsAppMessageLog.create({
        data: {
          waMessageId,
          phone: normalized,
          direction: 'outbound',
          type: messagePayload.type || 'text',
          content: messagePayload,
          status: 'sent',
        },
      }).catch(e => this.logger.error(`WA log write failed: ${e.message}`));

      return waMessageId;
    } catch (e) {
      this.logger.error(`WhatsApp send to ${normalized} failed: ${e.message}`);

      this.prisma.whatsAppMessageLog.create({
        data: {
          phone: normalized,
          direction: 'outbound',
          type: messagePayload.type || 'text',
          content: messagePayload,
          status: 'failed',
        },
      }).catch(() => {});

      return null;
    }
  }

  private async callApi(body: any): Promise<any> {
    const url = `${META_API}/${this.phoneNumberId}/messages`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Meta API ${res.status}: ${errorBody}`);
    }

    return res.json();
  }

  /** Normalize phone to E.164 format (Uruguay default: +598) */
  normalizePhone(phone: string): string {
    let p = phone.replace(/[\s\-\(\)]/g, '');
    // Already E.164
    if (p.startsWith('+')) return p.replace('+', '');
    // With country code but no +
    if (p.startsWith('598')) return p;
    // Local Uruguay (09x...)
    if (p.startsWith('0')) return '598' + p.slice(1);
    // Short form (9x...)
    if (p.length === 8 || p.length === 9) return '598' + p;
    return p;
  }
}
