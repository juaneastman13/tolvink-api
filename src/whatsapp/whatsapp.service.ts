// =====================================================================
// TOLVINK — WhatsApp Service via Meta Cloud API
// Sends messages with native interactive buttons and lists
// =====================================================================

import { Injectable, Logger, OnModuleInit, OnModuleDestroy, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { SelectionItem, SelectionConfig, SelectionResult } from '../common/selection-helpers';
import { getCompanyTypes } from '../common/company-type-helpers';

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
  private reminderTimer: ReturnType<typeof setInterval> | null = null;
  private dailySummaryTimer: ReturnType<typeof setInterval> | null = null;
  /** Track sent reminders: key = `${freightId}:${status}`, value = timestamp */
  private readonly sentReminders = new Map<string, number>();
  private lastSummaryDate: string | null = null;

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

    // Stale freight reminders — DISABLED during testing phase
    // this.reminderTimer = setInterval(() => this.checkStaleFreights().catch(e => this.logger.error('Reminder check failed', e.stack)), 15 * 60_000);
    // this.logger.log('Stale freight reminder scheduler started (every 15 min)');

    // Daily summary — DISABLED during testing phase
    // this.dailySummaryTimer = setInterval(() => this.checkDailySummary().catch(e => this.logger.error('Daily summary check failed', e.stack)), 60_000);
    // this.logger.log('Daily summary scheduler started (every 60s)');
  }

  onModuleDestroy() {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    if (this.dailySummaryTimer) clearInterval(this.dailySummaryTimer);
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
      // Delete expired LiveLocation records
      const liveResult = await this.prisma.liveLocation.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      // Archive old FreightTracking records (>90 days)
      const cutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      // Batch delete to avoid long-running locks (PostgreSQL)
      let trackDeleted = 0;
      for (let i = 0; i < 20; i++) {
        const batch: number = await this.prisma.$executeRaw`DELETE FROM freight_tracking WHERE id IN (SELECT id FROM freight_tracking WHERE created_at < ${cutoff} LIMIT 5000)`;
        trackDeleted += batch;
        if (batch < 5000) break;
      }
      const trackResult = { count: trackDeleted };
      // Clean old WhatsApp message logs (>90 days) — batched to avoid long-running locks
      let waLogDeleted = 0;
      for (let i = 0; i < 20; i++) {
        const batch: number = await this.prisma.$executeRaw`DELETE FROM whatsapp_message_logs WHERE id IN (SELECT id FROM whatsapp_message_logs WHERE created_at < ${cutoff} LIMIT 5000)`;
        waLogDeleted += batch;
        if (batch < 5000) break;
      }
      const waLogResult = { count: waLogDeleted };
      // Clean old analytics events (>180 days)
      const analyticsCutoff = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
      const analyticsResult = await this.prisma.analyticsEvent.deleteMany({
        where: { createdAt: { lt: analyticsCutoff } },
      });
      // Clean old read notifications (>90 days)
      const notifCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const notifResult = await this.prisma.notification.deleteMany({
          where: { read: true, createdAt: { lt: notifCutoff } },
      });
      // Clean expired/used password reset codes
      const resetResult = await this.prisma.passwordResetCode.deleteMany({
        where: { OR: [
          { expiresAt: { lt: now } },
          { used: true, createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
        ]},
      });
      const totalCleaned = sessResult.count + tokResult.count + liveResult.count + trackResult.count + waLogResult.count + analyticsResult.count + notifResult.count + resetResult.count;
      if (totalCleaned > 0) {
        this.logger.log(`Cleanup: ${sessResult.count} sessions, ${tokResult.count} tokens, ${liveResult.count} live locs, ${trackResult.count} old tracking, ${waLogResult.count} old WA logs, ${analyticsResult.count} old analytics, ${notifResult.count} old notifications, ${resetResult.count} expired reset codes deleted`);
      }
    } catch (e) {
      this.logger.error(`Cleanup failed: ${e.message}`);
    }
  }

  // ======================== STALE FREIGHT REMINDERS =======================

  private async checkStaleFreights() {
    if (!this.enabled) return;

    const now = new Date();
    const FOUR_HOURS = 4 * 60 * 60 * 1000;

    // Purge expired reminder entries (older than 4 hours)
    for (const [key, ts] of this.sentReminders) {
      if (now.getTime() - ts > FOUR_HOURS) this.sentReminders.delete(key);
    }

    // 1. Freights stuck in "assigned" for >2 hours with active assignments
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const staleAssigned = await this.prisma.freight.findMany({
      where: {
        status: 'assigned',
        updatedAt: { lt: twoHoursAgo },
        assignments: { some: { status: 'active' } },
      },
      include: {
        items: { take: 1 },
        assignments: {
          where: { status: 'active' },
          include: {
            transportCompany: { select: { id: true } },
          },
        },
      },
      take: 50,
    });

    for (const freight of staleAssigned) {
      const key = `${freight.id}:assigned`;
      if (this.sentReminders.has(key)) continue;

      const grain = freight.items[0]?.grain || 'N/A';
      const tons = freight.items[0]?.tons || '0';
      const date = freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : 'N/A';
      const message = `⏰ Recordatorio: Tiene un flete pendiente de aceptar.\n📦 ${freight.code}: ${grain} ${tons}tn\n🗓️ ${date}\nResponda desde el menú o escriba el código del flete.`;

      // Find transporter company users with phone numbers
      const transporterCompanyIds = [...new Set(freight.assignments.map(a => a.transportCompanyId))];
      const users = await this.prisma.user.findMany({
        where: {
          active: true,
          phone: { not: null },
          OR: [
            { companyId: { in: transporterCompanyIds } },
            { memberships: { some: { companyId: { in: transporterCompanyIds }, active: true } } },
          ],
        },
        select: { phone: true },
      });

      for (const u of users) {
        if (u.phone) {
          this.sendText(u.phone, message).catch(e => this.logger.warn(`Reminder send failed: ${e.message}`));
        }
      }

      this.sentReminders.set(key, now.getTime());
    }

    // 2. Freights stuck in "accepted" for >1 hour where nobody started the trip
    const oneHourAgo = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const staleAccepted = await this.prisma.freight.findMany({
      where: {
        status: 'accepted',
        updatedAt: { lt: oneHourAgo },
      },
      include: {
        items: { take: 1 },
        assignments: {
          where: { status: 'accepted' },
          include: {
            driver: { select: { phone: true } },
          },
        },
      },
      take: 50,
    });

    for (const freight of staleAccepted) {
      const key = `${freight.id}:accepted`;
      if (this.sentReminders.has(key)) continue;

      const grain = freight.items[0]?.grain || 'N/A';
      const tons = freight.items[0]?.tons || '0';
      const date = freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : 'N/A';
      const message = `⏰ Recordatorio: Tiene un flete aceptado sin iniciar.\n📦 ${freight.code}: ${grain} ${tons}tn\n🗓️ ${date}`;

      for (const assignment of freight.assignments) {
        const driverPhone = assignment.driver?.phone;
        if (driverPhone) {
          this.sendText(driverPhone, message).catch(e => this.logger.warn(`Reminder send failed: ${e.message}`));
        }
      }

      this.sentReminders.set(key, now.getTime());
    }

    const total = staleAssigned.length + staleAccepted.length;
    if (total > 0) {
      this.logger.log(`Stale freight check: ${staleAssigned.length} assigned, ${staleAccepted.length} accepted reminders processed`);
    }
  }

  // ======================== DAILY SUMMARY ================================

  private async checkDailySummary() {
    if (!this.enabled) return;

    // Check if it's 10:00 AM Uruguay time (UTC-3)
    const uyTime = new Date().toLocaleString('en-US', { timeZone: 'America/Montevideo' });
    const uyDate = new Date(uyTime);
    const hour = uyDate.getHours();
    const minute = uyDate.getMinutes();
    const todayStr = uyDate.toISOString().split('T')[0];

    // Only send at 10:00 AM (allow 1 minute window)
    if (hour !== 10 || minute > 0) return;

    // Only send once per day
    if (this.lastSummaryDate === todayStr) return;
    this.lastSummaryDate = todayStr;

    this.logger.log('Sending daily summary messages...');

    // Get today's date range in UTC
    const todayStart = new Date(todayStr + 'T00:00:00-03:00');
    const todayEnd = new Date(todayStr + 'T23:59:59-03:00');

    // Get all active users with phone numbers and their company memberships
    const users = await this.prisma.user.findMany({
      where: { active: true, phone: { not: null } },
      select: {
        id: true,
        phone: true,
        companyId: true,
        company: { select: { id: true, type: true, types: true } },
        memberships: {
          where: { active: true },
          select: { companyId: true, company: { select: { id: true, type: true, types: true } } },
        },
      },
      take: 500,
    });

    // N+1: queries freights per user's companies — low volume (daily cron, max 500 users), batch later
    for (const user of users) {
      try {
        // Collect all companies and their resolved types (prefer types[] array, fallback to type)
        const companies: { id: string; types: string[] }[] = [];
        if (user.company) companies.push({ id: user.company.id, types: getCompanyTypes(user.company) });
        for (const m of user.memberships) {
          if (m.company) companies.push({ id: m.company.id, types: getCompanyTypes(m.company) });
        }

        // Producer summary
        const producerCompanies = companies.filter(c => c.types.includes('producer'));
        if (producerCompanies.length > 0) {
          const producerIds = producerCompanies.map(c => c.id);
          const freights = await this.prisma.freight.findMany({
            where: {
              originCompanyId: { in: producerIds },
              loadDate: { gte: todayStart, lte: todayEnd },
              status: { not: 'canceled' },
            },
            select: { status: true },
          });

          if (freights.length > 0) {
            const total = freights.length;
            const pending = freights.filter(f => f.status === 'pending_assignment').length;
            const assigned = freights.filter(f => f.status === 'assigned').length;
            const accepted = freights.filter(f => f.status === 'accepted').length;
            const inProgress = freights.filter(f => ['in_progress', 'loaded'].includes(f.status)).length;

            const message = `☀️ Buenos días. Resumen del día:\n📦 ${total} fletes programados para hoy\n⏳ ${pending} pendientes de asignar\n🚛 ${assigned} asignados\n✅ ${accepted} aceptados\n🚀 ${inProgress} a campo`;
            this.sendText(user.phone!, message).catch(e => this.logger.warn(`Summary send failed: ${e.message}`));
          }
        }

        // Transporter summary
        const transporterCompanies = companies.filter(c => c.types.includes('transporter'));
        if (transporterCompanies.length > 0) {
          const transporterIds = transporterCompanies.map(c => c.id);
          const assignments = await this.prisma.freightAssignment.findMany({
            where: {
              transportCompanyId: { in: transporterIds },
              freight: {
                loadDate: { gte: todayStart, lte: todayEnd },
                status: { not: 'canceled' },
              },
            },
            select: { status: true },
          });

          if (assignments.length > 0) {
            const total = assignments.length;
            const pending = assignments.filter(a => a.status === 'active').length;
            const accepted = assignments.filter(a => a.status === 'accepted').length;
            const inProgress = assignments.filter(a => ['accepted'].includes(a.status)).length;

            const message = `☀️ Buenos días. Resumen del día:\n📦 ${total} fletes asignados\n⏳ ${pending} pendientes de responder\n✅ ${accepted} aceptados\n🚀 ${inProgress} a campo`;
            this.sendText(user.phone!, message).catch(e => this.logger.warn(`Summary send failed: ${e.message}`));
          }
        }
      } catch (e) {
        this.logger.warn(`Daily summary failed for user ${user.id}: ${e.message}`);
      }
    }

    this.logger.log('Daily summary messages sent');
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
    // WhatsApp interactive body limit: 1024 chars. Truncate if needed.
    const body = bodyText.length > 1024 ? bodyText.slice(0, 1021) + '...' : bodyText;
    return this.send(phone, {
      messaging_product: 'whatsapp',
      to: this.normalizePhone(phone),
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
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

  // ======================== TYPING INDICATOR ===============================

  /** Send "typing" indicator so user sees the bot is composing a response */
  async sendTypingIndicator(phone: string): Promise<void> {
    if (!this.enabled || !phone) return;
    try {
      await fetch(`${META_API}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: this.normalizePhone(phone),
          typing_action: 'typing',
        }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (e) {
      this.logger.debug(`Typing indicator failed: ${e.message}`);
    }
  }

  // ======================== DOWNLOAD MEDIA =================================

  async downloadMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    if (!this.enabled) throw new InternalServerErrorException('WhatsApp not configured');

    // Step 1: Get media URL from Meta
    const metaRes = await fetch(`${META_API}/${mediaId}`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!metaRes.ok) {
      const errBody = await metaRes.text();
      throw new BadRequestException(`Media metadata fetch failed (${metaRes.status}): ${errBody.slice(0, 200)}`);
    }
    const metaData = await metaRes.json() as any;
    const url = metaData.url;
    const mimeType = metaData.mime_type || 'audio/ogg';

    // Validate URL points to a known Meta CDN domain over HTTPS (SSRF protection)
    const ALLOWED_HOSTS = ['lookaside.fbsbx.com', 'scontent.whatsapp.net', 'media.fna.whatsapp.net'];
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        throw new BadRequestException('Non-HTTPS media URL rejected');
      }
      if (!ALLOWED_HOSTS.some(h => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
        throw new BadRequestException(`Unexpected media host: ${parsed.hostname}`);
      }
    } catch (e) {
      if (e instanceof TypeError) throw new BadRequestException(`Invalid media URL from Meta`);
      throw e;
    }

    // Step 2: Download the actual file
    const fileRes = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!fileRes.ok) {
      throw new BadRequestException(`Media download failed (${fileRes.status})`);
    }
    const MAX_MEDIA_SIZE = 25 * 1024 * 1024; // 25MB
    const contentLength = parseInt(fileRes.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_MEDIA_SIZE) {
      throw new BadRequestException(`Media too large: ${contentLength} bytes (max ${MAX_MEDIA_SIZE})`);
    }

    // Stream response body and abort if accumulated bytes exceed MAX_MEDIA_SIZE
    const reader = fileRes.body?.getReader();
    if (!reader) throw new BadRequestException('No se pudo leer la respuesta de media');
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.length;
      if (totalSize > MAX_MEDIA_SIZE) {
        reader.cancel();
        throw new BadRequestException(`Media download exceeded limit: ${totalSize} bytes (max ${MAX_MEDIA_SIZE})`);
      }
      chunks.push(value);
    }
    const buffer = Buffer.concat(chunks);

    return { buffer, mimeType };
  }

  // ======================== UPLOAD TO SUPABASE STORAGE =====================

  async uploadToStorage(buffer: Buffer, path: string, mimeType: string): Promise<string> {
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    const supabaseKey = this.config.get<string>('SUPABASE_SERVICE_KEY');

    if (!supabaseUrl || !supabaseKey) {
      throw new InternalServerErrorException('Supabase Storage not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
    }

    const bucket = 'freight-docs';
    const res = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        'Content-Type': mimeType,
      },
      body: new Uint8Array(buffer),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new BadRequestException(`Storage upload failed (${res.status}): ${errBody.slice(0, 200)}`);
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

    const MAX_RETRIES = 3;
    const RETRY_DELAYS = [1000, 3000, 9000];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
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
          const status = res.status;

          // Don't retry client errors (4xx) except 429 (rate limit)
          if (status >= 400 && status < 500 && status !== 429) {
            this.logger.error(`Meta API ${status}: ${errorBody.slice(0, 300)}`);
            break;
          }

          // Retry on 429 or 5xx
          lastError = new Error(`Meta API ${status}: ${errorBody.slice(0, 200)}`);
          if (attempt < MAX_RETRIES - 1) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
            const delay = retryAfter > 0 ? retryAfter * 1000 : RETRY_DELAYS[attempt];
            this.logger.warn(`Meta API ${status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          break;
        }

        const data = await res.json();
        const waMessageId = data?.messages?.[0]?.id || null;

        this.prisma.whatsAppMessageLog.create({
          data: {
            waMessageId,
            phone: normalized,
            direction: 'outbound',
            type: payload.type || 'text',
            content: { type: payload.type },
            status: 'sent',
          },
        }).catch(e => this.logger.warn(`WA log write failed: ${e.message}`));

        return waMessageId;
      } catch (e) {
        lastError = e;
        if (attempt < MAX_RETRIES - 1) {
          this.logger.warn(`WhatsApp send attempt ${attempt + 1} failed: ${e.message}, retrying...`);
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        }
      }
    }

    const masked = normalized.length > 4 ? '*'.repeat(normalized.length - 4) + normalized.slice(-4) : normalized;
    this.logger.error(`WhatsApp send to ${masked} failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);

    // P1-7: Report to Sentry if available — send failures are critical (user gets silence)
    try {
      const Sentry = require('@sentry/node');
      if (Sentry.isInitialized?.() || process.env.SENTRY_DSN) {
        Sentry.captureException(lastError || new Error(`WhatsApp send failed to ${masked}`), {
          tags: { service: 'whatsapp', action: 'send' },
          extra: { phone: masked, messageType: payload.type, attempts: MAX_RETRIES },
        });
      }
    } catch { /* Sentry not available */ }

    this.prisma.whatsAppMessageLog.create({
      data: {
        phone: normalized,
        direction: 'outbound',
        type: payload.type || 'text',
        content: { type: payload.type },
        status: 'failed',
      },
    }).catch(e => this.logger.warn(`WA log write failed: ${e.message}`));

    return null;
  }

  /** Normalize phone to E.164 digits (no +), Uruguay default +598 */
  normalizePhone(phone: string): string {
    let p = phone.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('whatsapp:')) p = p.replace('whatsapp:', '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('598')) { /* already prefixed */ }
    else if (p.startsWith('0')) p = '598' + p.slice(1);
    else if (p.length === 8 || p.length === 9) p = '598' + p;
    // Validate E.164 length (10-15 digits) — return original digits if invalid
    if (p.length < 10 || p.length > 15) {
      this.logger.warn(`normalizePhone: invalid length ${p.length} for input "${phone.slice(0, 20)}"`);
    }
    // Strip any remaining non-digits
    return p.replace(/\D/g, '');
  }
}
