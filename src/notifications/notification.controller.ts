import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private notificationService: NotificationService) {}

  @Post('subscribe')
  async subscribe(@Req() req: any, @Body() body: { endpoint: string; keys: { p256dh: string; auth: string } }) {
    await this.notificationService.subscribe(req.user.sub, body);
    return { ok: true };
  }

  @Delete('subscribe')
  async unsubscribe(@Req() req: any, @Body() body: { endpoint: string }) {
    await this.notificationService.unsubscribe(req.user.sub, body.endpoint);
    return { ok: true };
  }

  @Get()
  async list(@Req() req: any) {
    const [notifications, unreadCount] = await Promise.all([
      this.notificationService.getNotifications(req.user.sub),
      this.notificationService.getUnreadCount(req.user.sub),
    ]);
    return { notifications, unreadCount };
  }

  @Patch(':id/read')
  async markRead(@Req() req: any, @Param('id') id: string) {
    await this.notificationService.markRead(req.user.sub, id);
    return { ok: true };
  }

  @Patch('read-all')
  async markAllRead(@Req() req: any) {
    await this.notificationService.markAllRead(req.user.sub);
    return { ok: true };
  }
}
