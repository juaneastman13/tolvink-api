// =====================================================================
// TOLVINK — WhatsApp Service via Meta Cloud API
// Sends messages with native interactive buttons and lists
// =====================================================================

import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SelectionItem, SelectionConfig, SelectionResult } from '../common/selection-helpers';

const META_API = 'https://graph.facebook.com/v22.0';

export interface WAButton {
  id: string;    // callback payload (max 256 chars)
  title: string; // button label (max 20 chars)
}

export interface WAListRow {
  id: string;          // callback payload (max 200 chars)
  title: string;       // row title (max 24 chars)
  description?: string; // row description (max 72 chars)
}

export interface WAListSection {
  title: string; // section title (max 24 chars)
  rows: WAListRow[];
}

@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly phoneNumberId: string | undefined;
  private readonly accessToken: string | undefined;
  private readonly enabled: boolean;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
  ) {
    this.phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    this.accessToken = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    this.enabled = !!(this.phoneNumberId && this.accessToken);

    if (this.enabled) {
      this.logger.log(`WhatsApp (Meta Cloud API) configured — phone ID: ${this.phoneNumberId}`);
    } else {
      this.logger.warn('WhatsApp not configured — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN missing');
    }
  }

  onModuleInit() {
    // Cleanup expired sessions and refresh tokens every 30 minutes
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30 * 60 * 1000);
    this.logger.log('Session/token cleanup scheduler started (every 30 min)');
  }

  onModuleDestroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
  }

  private async cleanupExpired() {
    try {
      const now = new Date();
      // Delete expired WhatsApp sessions (older than 2 hours past expiry)
      const sessResult = await this.prisma.whatsAppSession.deleteMany({
        where: { expiresAt: { lt: new Date(now.getTime() - 2 * 60 * 60 * 1000) } },
      });
      // Delete expired refresh tokens
      const tokResult = await this.prisma.refreshToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      if (sessResult.count > 0 || tokResult.count > 0) {
        this.logger.log(`Cleanup: ${sessResult.count} expired sessions, ${tokResult.count} expired tokens deleted`);
      }
    } catch (e) {
      this.logger.error(`Cleanup failed: ${e.message}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  // ======================== SEND TEXT MESSAGE ============================

  async sendText(phone: string, text: string): Promise<string | null> {
    return this.send(phone, {
      messaging_product: 'whatsapp',
      to: this.normalizePhone(phone),
      type: 'text',
      text: { body: text },
    });
  }

  // ======================== SEND INTERACTIVE BUTTONS =====================
  // Max 3 buttons, each with max 20 char title

  async sendButtons(phone: string, bodyText: string, buttons: WAButton[]): Promise<string | null> {
    return this.send(phone, {
      messaging_product: 'whatsapp',
      to: this.normalizePhone(phone),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: {
              id: b.id.slice(0, 256),
              title: b.title.slice(0, 20),
            },
          })),
        },
      },
    });
  }

  // ======================== SEND INTERACTIVE LIST ========================
  // Max 10 rows per section, max 10 sections

  async sendList(
    phone: string,
    bodyText: string,
    buttonLabel: string,
    sections: WAListSection[],
  ): Promise<string | null> {
    return this.send(phone, {
      messaging_product: 'whatsapp',
      to: this.normalizePhone(phone),
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: sections.map(s => ({
            title: s.title.slice(0, 24),
            rows: s.rows.slice(0, 10).map(r => ({
              id: r.id.slice(0, 200),
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
  }

  // ======================== SEND SELECTION (always interactive list) ========
  // Always uses WhatsApp interactive list (max 10 rows).
  // If >10 items: shows 9 per page + "Mostrar más" row for pagination.

  async sendSelection(
    phone: string,
    items: SelectionItem[],
    config: SelectionConfig,
  ): Promise<SelectionResult> {
    const page = config.page || 1;
    const totalItems = items.length;
    const hasFooter = !!config.footer;

    // Items per page: leave room for footer + "Mostrar más" (max 10 rows total)
    const itemsPerPage = hasFooter ? 8 : 9;

    let pageItems: SelectionItem[];
    let showMore = false;
    let totalPages: number;

    if (totalItems + (hasFooter ? 1 : 0) <= 10) {
      // Everything fits in one list — no pagination
      pageItems = items;
      totalPages = 1;
    } else {
      // Last page can hold up to 10 items (or 9 with footer) since no "Mostrar más" needed
      const lastPageMax = hasFooter ? 9 : 10;
      totalPages = Math.ceil((totalItems - lastPageMax) / itemsPerPage) + 1;
      const currentPage = Math.min(page, totalPages);

      const startIdx = (currentPage - 1) * itemsPerPage;
      const remaining = totalItems - startIdx;

      if (remaining <= lastPageMax) {
        pageItems = items.slice(startIdx);
      } else {
        pageItems = items.slice(startIdx, startIdx + itemsPerPage);
        showMore = true;
      }
    }

    const currentPage = Math.min(page, totalPages);

    // Build rows
    const rows: WAListRow[] = pageItems.map((item) => ({
      id: item.id.slice(0, 200),
      title: item.title.slice(0, 24),
      description: item.description?.slice(0, 72),
    }));

    if (hasFooter) {
      rows.push({
        id: config.footer!.id.slice(0, 200),
        title: config.footer!.title.slice(0, 24),
        description: config.footer!.description?.slice(0, 72),
      });
    }

    if (showMore) {
      rows.push({
        id: '__show_more__',
        title: 'Mostrar más',
        description: `Página ${currentPage} de ${totalPages}`,
      });
    }

    let headerText = config.headerText;
    if (totalPages > 1) {
      headerText += `\n\n📄 Página ${currentPage}/${totalPages}`;
    }

    await this.sendList(
      phone,
      headerText,
      (config.listButtonLabel || 'Ver opciones').slice(0, 20),
      [{ title: (config.sectionTitle || 'Opciones').slice(0, 24), rows }],
    );

    const shownItems = hasFooter ? [...pageItems, config.footer!] : [...pageItems];
    return { mode: 'list', shownItems, page: currentPage, totalPages, totalItems };
  }

  // ======================== SEND TEMPLATE ================================

  async sendTemplate(
    phone: string,
    templateName: string,
    languageCode: string,
    components?: any[],
  ): Promise<string | null> {
    const payload: any = {
      messaging_product: 'whatsapp',
      to: this.normalizePhone(phone),
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
      },
    };
    if (components) {
      payload.template.components = components;
    }
    return this.send(phone, payload);
  }

  // ======================== MARK AS READ =================================

  async markRead(waMessageId: string): Promise<void> {
    if (!this.enabled || !waMessageId) return;

    try {
      await fetch(`${META_API}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: waMessageId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      this.logger.debug(`markRead failed: ${e.message}`);
    }
  }

  // ======================== DOWNLOAD MEDIA =================================

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!this.enabled) throw new Error('WhatsApp not configured');

    // Step 1: Get media URL from Meta
    const metaRes = await fetch(`${META_API}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!metaRes.ok) {
      const errBody = await metaRes.text();
      throw new Error(`Media metadata fetch failed (${metaRes.status}): ${errBody.slice(0, 200)}`);
    }
    const metaData = await metaRes.json() as any;
    const url = metaData.url;
    const mimeType = metaData.mime_type || 'audio/ogg';

    // Step 2: Download the actual file
    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileRes.ok) {
      throw new Error(`Media download failed (${fileRes.status})`);
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());

    return { buffer, mimeType };
  }

  // ======================== UPLOAD TO SUPABASE STORAGE =====================

  async uploadToStorage(buffer: Buffer, path: string, mimeType: string): Promise<string> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const supabaseKey = this.config.get<string>('SUPABASE_SERVICE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new Error('Supabase Storage not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    }

    const bucket = 'freight-docs';
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': mimeType,
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Storage upload failed (${res.status}): ${errBody.slice(0, 200)}`);
    }

    return `${supabaseUrl}/storage/v1/object/public/${bucket}/${path}`;
  }

  // ======================== INTERNAL: SEND VIA META API ===================

  private async send(phone: string, payload: any): Promise<string | null> {
    if (!this.enabled) {
      this.logger.debug(`WhatsApp disabled, skipping message to ${phone}`);
      return null;
    }

    const normalized = this.normalizePhone(phone);
    payload.to = normalized;

    try {
      const res = await fetch(`${META_API}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        this.logger.error(`Meta API error ${res.status}: ${errorBody.slice(0, 300)}`);
        throw new Error(`Meta API ${res.status}: ${errorBody}`);
      }

      const data = await res.json();
      const waMessageId = data?.messages?.[0]?.id || null;

      // Log outbound message (fire-and-forget)
      this.prisma.whatsAppMessageLog.create({
        data: {
          waMessageId,
          phone: normalized,
          direction: 'outbound',
          type: payload.type || 'text',
          content: { type: payload.type },
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
          type: payload.type || 'text',
          content: { type: payload.type },
          status: 'failed',
        },
      }).catch(() => {});

      return null;
    }
  }

  /** Normalize phone to E.164 digits (no +), Uruguay default +598 */
  normalizePhone(phone: string): string {
    let p = phone.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('whatsapp:')) p = p.replace('whatsapp:', '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('598')) { /* already prefixed */ }
    else if (p.startsWith('0')) p = '598' + p.slice(1);
    else if (p.length === 8 || p.length === 9) p = '598' + p;
    // Validate E.164 length (10-15 digits)
    if (p.length < 10 || p.length > 15) {
      this.logger.warn(`normalizePhone: invalid length ${p.length} for "${phone}"`);
    }
    return p;
  }
}
