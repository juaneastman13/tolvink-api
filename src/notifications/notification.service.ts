import { Injectable, Logger, Inject, forwardRef, Optional, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SseService } from '../sse/sse.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import * as webpush from 'web-push';
import { NotificationType } from '@prisma/client';

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

    // Cleanup old notifications and tracking points every 6 hours
    this.cleanupInterval = setInterval(() => this.cleanupOldRecords(), 6 * 60 * 60 * 1000);
  }

  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  /** Remove read notifications older than 30 days and tracking points older than 90 days */
  private async cleanupOldRecords() {
    try {
      const notifCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const trackingCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      const [notifResult, trackResult] = await Promise.all([
        this.prisma.notification.deleteMany({ where: { read: true, createdAt: { lt: notifCutoff } } }),
        this.prisma.freightTracking.deleteMany({ where: { createdAt: { lt: trackingCutoff } } }),
      ]);
      if (notifResult.count > 0 || trackResult.count > 0) {
        this.logger.log(`Cleanup: removed ${notifResult.count} old notifications, ${trackResult.count} old tracking points`);
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
    this.sendPush(userId, { title, body, url: entityId ? `/freight/${entityId}` : '/' })
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
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        OR: [
          { companyId },
          { memberships: { some: { companyId, active: true } } },
        ],
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

    // Fire-and-forget: push + SSE + WhatsApp per user (non-blocking)
    for (const uid of userIds) {
      this.sendPush(uid, { title, body, url: entityId ? `/freight/${entityId}` : '/' })
        .catch((e) => this.logger.error(`Push send failed for user ${uid}: ${e.message}`));
      const phone = userMap.get(uid) || null;
      this.sendWhatsAppDirect(uid, phone, type, title, body, entityId, actionRecipient)
        .catch((e) => this.logger.error(`WhatsApp send failed for user ${uid}: ${e.message}`));
      this.sse.emitToUser(uid, 'notification:new', { type, title, entityId });
    }
  }

  // ======================== GET NOTIFICATIONS ============================

  async getNotifications(userId: string, limit = 50) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
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
    if (!this.wa) {
      this.logger.debug(`WhatsApp notification skipped for user ${userId}: service not available`);
      return;
    }
    if (!this.wa.isEnabled()) {
      this.logger.debug(`WhatsApp notification skipped for user ${userId}: not enabled`);
      return;
    }

    // Use pre-fetched phone or fall back to DB query
    let userPhone = phone;
    if (!userPhone) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { phone: true },
      });
      userPhone = user?.phone || null;
    }
    if (!userPhone) {
      this.logger.debug(`WhatsApp notification skipped for user ${userId}: no phone`);
      return;
    }

    // Build message with action buttons based on notification type
    const buttons = this.getWhatsAppButtons(type, entityId, actionRecipient);

    const text = `*${title}*\n${body}`;

    if (buttons.length > 0 && entityId) {
      await this.wa.sendButtons(userPhone, text, buttons);
    } else {
      await this.wa.sendText(userPhone, text);
    }
  }

  /**
   * Get WhatsApp buttons for a notification.
   * actionRecipient=true → include action buttons (Aceptar, Confirmar, etc.)
   * actionRecipient=false → only "Ver detalle" (informational)
   */
  private getWhatsAppButtons(type: NotificationType, entityId?: string, actionRecipient = false): Array<{ id: string; title: string }> {
    if (!entityId) return [];

    // Action buttons only for the targeted recipient
    if (actionRecipient) {
      switch (type) {
        case 'freight_assigned':
          return [
            { id: `accept:${entityId}`, title: 'Aceptar' },
            { id: `reject:${entityId}`, title: 'Rechazar' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_loaded':
          return [
            { id: `confirm_loaded:${entityId}`, title: 'Confirmar carga' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
        case 'freight_confirmed':
          return [
            { id: `confirm_finished:${entityId}`, title: 'Confirmar entrega' },
            { id: `detail:${entityId}`, title: 'Ver detalle' },
          ];
      }
    }

    // Informational: "Ver detalle" only (or nothing for rejections/cancellations)
    switch (type) {
      case 'freight_rejected':
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

    const subs = await this.prisma.pushSubscription.findMany({ where: { userId } });
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
              await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(e => this.logger.warn(e.message));
              this.logger.log(`Removed expired subscription for user ${userId}`);
            } else {
              this.logger.error(`Push failed for user ${userId}: ${err.message}`);
            }
          }),
      ),
    );
  }
}
