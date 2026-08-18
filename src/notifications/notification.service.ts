import { Injectable, Logger, Inject, forwardRef, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SseService } from '../sse/sse.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import * as webpush from 'web-push';
import { NotificationType } from '@prisma/client';

/** Max push subscriptions per user to prevent unbounded queries */
const MAX_PUSH_SUBS = 10;
/** Batch size for cleanup deletes to avoid long-running locks */
const CLEANUP_BATCH = 5000;
/** Small delay between WhatsApp sends to avoid Meta rate limits */
const WA_SEND_DELAY_MS = 100;

@Injectable()
export class NotificationService implements OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);
  private pushEnabled = false;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @Inject(forwardRef(() => SseService)) private sse: SseService,
    @Inject(forwardRef(() => WhatsAppService)) @Optional() private wa: WhatsAppService | null,
  ) {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT') || 'mailto:soporte@tolvink.app';

    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.pushEnabled = true;
      this.logger.log('Web Push configured');
    } else {
      this.logger.warn('VAPID keys not set — push notifications disabled');
    }

    // Cleanup old notifications and tracking points every 6 hours (+ on startup after 30s)
    this.cleanupInterval = setInterval(() => this.cleanupOldRecords(), 6 * 60 * 60 * 1000);
    setTimeout(() => this.cleanupOldRecords(), 30_000);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /** Remove read notifications older than 30 days and tracking points older than 90 days (batched) */
  private async cleanupOldRecords() {
    try {
      const notifCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const trackingCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      // Batch delete to avoid long-running locks on large tables
      let totalNotifs = 0;
      let totalTracking = 0;
      let batch: number;

      // Notifications cleanup (batched)
      do {
        const ids = await this.prisma.notification.findMany({
          where: { read: true, createdAt: { lt: notifCutoff } },
          select: { id: true },
          take: CLEANUP_BATCH,
        });
        if (ids.length === 0) break;
        batch = (await this.prisma.notification.deleteMany({
          where: { id: { in: ids.map(n => n.id) } },
        })).count;
        totalNotifs += batch;
      } while (batch >= CLEANUP_BATCH);

      // Tracking cleanup (batched)
      do {
        const ids = await this.prisma.freightTracking.findMany({
          where: { createdAt: { lt: trackingCutoff } },
          select: { id: true },
          take: CLEANUP_BATCH,
        });
        if (ids.length === 0) break;
        batch = (await this.prisma.freightTracking.deleteMany({
          where: { id: { in: ids.map(t => t.id) } },
        })).count;
        totalTracking += batch;
      } while (batch >= CLEANUP_BATCH);

      // Clear stale rate-limit entries
      this.proactiveLastSent.clear();

      if (totalNotifs > 0 || totalTracking > 0) {
        this.logger.log(`Cleanup: removed ${totalNotifs} old notifications, ${totalTracking} old tracking points`);
      }
    } catch (e) {
      this.logger.warn(`Cleanup failed: ${e.message}`);
    }
  }

  // ======================== PUSH SUBSCRIPTION ============================

  async subscribe(userId: string, sub: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    return this.prisma.pushSubscription.upsert({
      where: { userId_endpoint: { userId, endpoint: sub.endpoint } },
      create: { userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      update: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    });
  }

  async unsubscribe(userId: string, endpoint: string) {
    return this.prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
  }

  // ======================== NOTIFY USER ==================================

  /** Deep link del push según el tipo: las notificaciones BPS viven en Mi Flota */
  private pushUrl(type: NotificationType, entityId?: string): string {
    if (String(type).startsWith('bps_')) return '/trucks';
    return entityId ? `/freight/${entityId}` : '/';
  }

  async notify(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    companyId?: string,
  ) {
    // Save to DB
    const notification = await this.prisma.notification.create({
      data: { userId, type, title, body, entityId, companyId },
    });

    // Send push (fire-and-forget, log errors)
    this.sendPush(userId, { title, body, url: this.pushUrl(type, entityId) })
      .catch((e) => this.logger.error(`Push send failed for user ${userId}: ${e.message}`));

    // WhatsApp notification (fire-and-forget)
    this.sendWhatsApp(userId, type, title, body, entityId)
      .catch((e) => this.logger.error(`WhatsApp send failed for user ${userId}: ${e.message}`));

    // SSE: notify user about new notification
    this.sse.emitToUser(userId, 'notification:new', { type, title, entityId });

    return notification;
  }

  // ======================== NOTIFY COMPANY ===============================

  async notifyCompany(
    companyId: string,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    excludeUserId?: string,
    actionRecipient = false,
  ) {
    // Only include users with ACTIVE membership in this company (not legacy companyId alone)
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        memberships: { some: { companyId, active: true } },
      },
      select: { id: true, phone: true },
    });
    // Deduplicate by user id and build a map of id->phone
    const userMap = new Map<string, string | null>();
    for (const u of users) {
      if (u.id !== excludeUserId) userMap.set(u.id, u.phone);
    }
    const userIds = Array.from(userMap.keys());

    if (userIds.length === 0) return;

    // Batch insert all notifications in one query instead of N individual creates
    await this.prisma.notification.createMany({
      data: userIds.map(userId => ({ userId, type, title, body, entityId, companyId })),
    });

    // Fire-and-forget: push + SSE per user (non-blocking)
    for (const uid of userIds) {
      this.sendPush(uid, { title, body, url: this.pushUrl(type, entityId) })
        .catch((e) => this.logger.error(`Push send failed for user ${uid}: ${e.message}`));
      this.sse.emitToUser(uid, 'notification:new', { type, title, entityId });
    }

    // WhatsApp: send with small delay between messages to avoid Meta rate limits
    this.sendWhatsAppBatch(userIds, userMap, type, title, body, entityId, actionRecipient)
      .catch((e) => this.logger.error(`WhatsApp batch send failed: ${e.message}`));
  }

  /** Send WhatsApp notifications with throttling to avoid Meta rate limits */
  private async sendWhatsAppBatch(
    userIds: string[],
    userMap: Map<string, string | null>,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    actionRecipient = false,
  ) {
    for (let i = 0; i < userIds.length; i++) {
      const uid = userIds[i];
      const phone = userMap.get(uid) || null;
      await this.sendWhatsAppDirect(uid, phone, type, title, body, entityId, actionRecipient)
        .catch((e) => this.logger.error(`WhatsApp send failed for user ${uid}: ${e.message}`));
      // Small delay between sends (skip after last)
      if (i < userIds.length - 1 && WA_SEND_DELAY_MS > 0) {
        await new Promise(r => setTimeout(r, WA_SEND_DELAY_MS));
      }
    }
  }

  // ======================== GET NOTIFICATIONS ============================

  async getNotifications(userId: string, limit = 50) {
    const safeLim = Math.min(Math.max(1, limit || 50), 200);
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: safeLim,
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, read: false } });
  }

  async markRead(userId: string, notificationId: string) {
    return this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true },
    });
  }

  async markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    });
  }

  // ======================== WHATSAPP =====================================

  private async sendWhatsApp(
    userId: string,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
  ) {
    // Delegate to sendWhatsAppDirect with phone=null (will query DB)
    return this.sendWhatsAppDirect(userId, null, type, title, body, entityId);
  }

  /** Rate limit: max 1 proactive WA message per user per minute */
  private proactiveLastSent = new Map<string, number>();

  /** Check if user has interacted with the bot in the last 24h (Meta session window) */
  private async canSendProactive(phone: string): Promise<boolean> {
    // TODO: Etapa 0 - whatsAppMessageLog table removed. Will be replaced in Etapa 1
    // For now, allow proactive sends (assume user has interacted recently)
    // const lastInbound = await this.prisma.whatsAppMessageLog.findFirst({
    //   where: {
    //     phone,
    //     direction: 'inbound',
    //     createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    //   },
    //   orderBy: { createdAt: 'desc' },
    //   select: { id: true },
    // });
    // return !!lastInbound;
    return true; // Temporary: allow all proactive sends
  }

  /** Send WhatsApp notification — accepts pre-fetched phone to avoid extra DB query */
  private async sendWhatsAppDirect(
    userId: string,
    phone: string | null,
    type: NotificationType,
    title: string,
    body: string,
    entityId?: string,
    actionRecipient = false,
  ) {
    if (!this.wa) return;
    if (!this.wa.isEnabled()) return;

    // Use pre-fetched phone or fall back to DB query
    let userPhone = phone;
    if (!userPhone) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      });
      userPhone = user?.phone || null;
    }
    if (!userPhone) return;

    // Check 24h session window — Meta rejects messages outside it without approved templates
    const canSend = await this.canSendProactive(userPhone);
    if (!canSend) {
      this.logger.debug(`WhatsApp skipped for ${userPhone.slice(-4)}: no 24h session`);
      return;
    }

    // Rate limit: max 1 message per user per minute to avoid flood
    const lastSent = this.proactiveLastSent.get(userPhone) || 0;
    if (Date.now() - lastSent < 60_000) {
      this.logger.debug(`WhatsApp skipped for ${userPhone.slice(-4)}: rate limited`);
      return;
    }

    // Build message with action buttons based on notification type
    const buttons = this.getWhatsAppButtons(type, entityId, actionRecipient);
    const text = `*${title}*\n${body}`;

    try {
      if (buttons.length > 0 && entityId) {
        await this.wa.sendButtons(userPhone, text, buttons);
      } else {
        await this.wa.sendText(userPhone, text);
      }
      this.proactiveLastSent.set(userPhone, Date.now());
    } catch (err) {
      this.logger.warn(`WhatsApp send failed for ${userPhone.slice(-4)}: ${err.message}`);
      // Best-effort — never throw
    }
  }

  /**
   * Get WhatsApp buttons for a notification.
   * actionRecipient=true → action buttons (Aceptar, Confirmar, Reasignar, etc.)
   * actionRecipient=false → only "Ver detalle" (informational)
   */
  private getWhatsAppButtons(type: NotificationType, entityId?: string, actionRecipient = false): Array<{ id: string; title: string }> {
    if (!entityId) return [];

    // Action buttons only for the targeted recipient
    if (actionRecipient) {
      switch (type) {
        case 'freight_assigned':
          return [
            { id: `assign_truck:${entityId}`, title: 'Asignar camión' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_loaded':
          return [
            { id: `confirm_loaded:${entityId}`, title: 'Confirmar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_confirmed':
          return [
            { id: `confirm_finished:${entityId}`, title: 'Confirmar entrega' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        // Rejection: only the counterpart (producer/plant) gets Reasignar
        case 'freight_rejected':
          return [
            { id: `reassign:${entityId}`, title: 'Reasignar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
      }
    }

    // Informational: "Ver detalle" only (or nothing for cancellations)
    switch (type) {
      case 'freight_rejected':
        // Non-action recipients (the transporter who rejected) just see detail
        return [
          { id: `detail:${entityId}`, title: 'Ver detalle' },
        ];
      case 'freight_canceled':
        return [];
      default:
        return [
          { id: `detail:${entityId}`, title: 'Ver detalle' },
        ];
    }
  }

  // ======================== WEB PUSH =====================================

  private async sendPush(userId: string, payload: { title: string; body: string; url?: string }) {
    if (!this.pushEnabled) return;

    const subs = await this.prisma.pushSubscription.findMany({
      where: { userId },
      take: MAX_PUSH_SUBS,
      orderBy: { createdAt: 'desc' },
    });
    if (subs.length === 0) return;

    // Send all push notifications in parallel (not sequential)
    await Promise.allSettled(
      subs.map((sub) =>
        webpush
          .sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
          )
          .catch(async (err: any) => {
            if (err.statusCode === 404 || err.statusCode === 410) {
              await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } }).catch(e => this.logger.warn(e.message));
              this.logger.log(`Removed expired subscription for user ${userId}`);
            } else {
              this.logger.error(`Push failed for user ${userId}: ${err.message}`);
            }
          }),
      ),
    );
  }
}
