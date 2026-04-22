// =====================================================================
// TOLVINK — Web Chat Controller
// Endpoints for AI chat from the web frontend
// =====================================================================

import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WebChatService } from './web-chat.service';

const MAX_TEXT_LENGTH = 2000;
const MAX_AUDIO_SIZE = 24 * 1024 * 1024; // 24MB
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IDEMPOTENCY_TTL_MS = 60_000; // 1 minute

// Simple in-memory dedup set with TTL cleanup
const recentIdempotencyKeys = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of recentIdempotencyKeys) {
    if (now - ts > IDEMPOTENCY_TTL_MS) recentIdempotencyKeys.delete(key);
  }
}, IDEMPOTENCY_TTL_MS).unref();

@ApiTags('web-chat')
@ApiBearerAuth()
@Controller('web-chat')
@UseGuards(JwtAuthGuard)
export class WebChatController {
  private readonly logger = new Logger(WebChatController.name);

  constructor(private service: WebChatService) {}

  @Post('message')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Send text message to AI agent' })
  async sendMessage(
    @CurrentUser() user: any,
    @Body() body: { text: string; idempotencyKey?: string; module?: string },
  ) {
    // Dedup check
    if (body?.idempotencyKey) {
      if (recentIdempotencyKeys.has(body.idempotencyKey)) {
        return { ok: true, deduplicated: true };
      }
      recentIdempotencyKeys.set(body.idempotencyKey, Date.now());
    }

    const text = body?.text?.trim();
    if (!text) throw new BadRequestException('Texto requerido');
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(`Texto excede ${MAX_TEXT_LENGTH} caracteres`);
    }

    // Fire-and-forget: respond immediately, result comes via SSE
    this.service.handleTextMessage(user, text, body?.module).catch((e) => {
      this.logger.error(`handleTextMessage error: ${e.message}`);
    });

    return { ok: true };
  }

  @Post('audio')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @UseInterceptors(FileInterceptor('audio', {
    limits: { fileSize: MAX_AUDIO_SIZE },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype.startsWith('audio/')) {
        cb(null, true);
      } else {
        cb(new BadRequestException('Solo se aceptan archivos de audio'), false);
      }
    },
  }))
  @ApiOperation({ summary: 'Send audio message to AI agent (transcribed via Whisper)' })
  async sendAudio(
    @CurrentUser() user: any,
    @UploadedFile() file: Express.Multer.File,
    @Query('module') module?: string,
  ) {
    if (!file || !file.buffer) throw new BadRequestException('Archivo de audio requerido');

    // Whitelist allowed audio MIME types
    const ALLOWED_AUDIO_MIMES = ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/webm', 'audio/ogg', 'audio/x-m4a'];
    if (!ALLOWED_AUDIO_MIMES.includes(file.mimetype)) {
      throw new BadRequestException('Formato de audio no soportado. Use MP3, WAV, M4A, WebM u OGG.');
    }

    // Fire-and-forget: respond immediately, result comes via SSE
    this.service.handleAudioMessage(user, file.buffer, file.mimetype, module).catch((e) => {
      this.logger.error(`handleAudioMessage error: ${e.message}`);
    });

    return { ok: true };
  }

  @Post('file')
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({ summary: 'Notify AI agent of a file upload (URL from Supabase)' })
  async sendFile(
    @CurrentUser() user: any,
    @Body() body: { url: string; name: string; type: string; module?: string },
  ) {
    const url = body?.url?.trim();
    const name = body?.name?.trim();
    const type = body?.type || 'document';
    if (!url || !name) throw new BadRequestException('URL y nombre requeridos');
    if (url.length > 500) throw new BadRequestException('URL demasiado larga');

    this.service.handleFileMessage(user, { url, name, type }, body?.module).catch((e) => {
      this.logger.error(`handleFileMessage error: ${e.message}`);
    });

    return { ok: true };
  }

  @Get('history')
  @Throttle({ default: { ttl: 60000, limit: 30 } })
  @ApiOperation({ summary: 'Get AI chat history for current session' })
  async getHistory(@CurrentUser() user: any, @Query('module') module?: string) {
    return this.service.getHistory(user, module);
  }
}
