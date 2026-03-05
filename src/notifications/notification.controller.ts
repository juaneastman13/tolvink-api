import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { IsNotEmpty, IsString, ValidateNested, IsUrl, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

class PushKeysDto {
  @IsNotEmpty() @IsString() p256dh: string;
  @IsNotEmpty() @IsString() auth: string;
}

class SubscribePushDto {
  @IsNotEmpty() @IsUrl({ require_protocol: true }) @MaxLength(500) endpoint: string;
  @ValidateNested() @Type(() => PushKeysDto) keys: PushKeysDto;
}

class UnsubscribePushDto {
  @IsNotEmpty() @IsUrl({ require_protocol: true }) @MaxLength(500) endpoint: string;
}

@Controller('notifications')
@UseGuards(JwtAuthGuard)
@Throttle({ default: { ttl: 60000, limit: 30 } })
export class NotificationController {
  constructor(private notificationService: NotificationService) {}

  @Post('subscribe')
  async subscribe(@Req() req: any, @Body() body: SubscribePushDto) {
    await this.notificationService.subscribe(req.user.sub, body);
    return { ok: true };
  }

  @Delete('subscribe')
  async unsubscribe(@Req() req: any, @Body() body: UnsubscribePushDto) {
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
  async markRead(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    await this.notificationService.markRead(req.user.sub, id);
    return { ok: true };
  }

  @Patch('read-all')
  async markAllRead(@Req() req: any) {
    await this.notificationService.markAllRead(req.user.sub);
    return { ok: true };
  }
}
