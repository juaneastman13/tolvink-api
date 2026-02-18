import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SseService } from '../sse/sse.service';
import * as webpush from 'web-push';
import { NotificationType } from '@prisma/client';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private pushEnabled = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    @Inject(forwardRef(() => SseService)) private sse: SseService,
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
  ) {
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        OR: [
          { companyId },
          { memberships: { some: { companyId, active: true } } },
        ],
      },
      select: { id: true },
    });
    const userIds = Array.from(new Set(users.map((u: any) => u.id)))
      .filter(uid => uid !== excludeUserId);

    if (userIds.length === 0) return;

    // Batch insert all notifications in one query instead of N individual creates
    await this.prisma.notification.createMany({
      data: userIds.map(userId => ({ userId, type, title, body, entityId, companyId })),
    });

    // Fire-and-forget: push + SSE per user (non-blocking)
    for (const uid of userIds) {
      this.sendPush(uid, { title, body, url: entityId ? `/freight/${entityId}` : '/' })
        .catch((e) => this.logger.error(`Push send failed for user ${uid}: ${e.message}`));
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
              await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
              this.logger.log(`Removed expired subscription for user ${userId}`);
            } else {
              this.logger.error(`Push failed for user ${userId}: ${err.message}`);
            }
          }),
      ),
    );
  }
}
