// =====================================================================
// TOLVINK — Web Chat Service
// Bridges the web frontend to the AI agent (reuses AiService.chat)
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AiService } from '../ai/ai.service';
import { SseService } from '../sse/sse.service';
import { buildSyntheticUser } from '../common/build-synthetic-user';
import OpenAI from 'openai';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WEB_PHONE = 'web'; // Distinguishes web sessions from WhatsApp
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB (Whisper limit ~25MB)

@Injectable()
export class WebChatService {
  private readonly logger = new Logger(WebChatService.name);
  private openai: OpenAI | null = null;

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private sse: SseService,
    private config: ConfigService,
  ) {
    const openaiKey = this.config.get<string>('OPENAI_API_KEY');
    if (openaiKey) {
      this.openai = new OpenAI({ apiKey: openaiKey });
    }
  }

  /** Load full DB user with company/membership data (same pattern as WhatsApp router) */
  private async loadFullUser(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } } },
        },
      },
    });
  }

  /** Find or create an AI session for the web channel */
  private async getOrCreateSession(userId: string) {
    let session = await this.prisma.whatsAppSession.findFirst({
      where: {
        userId,
        phone: WEB_PHONE,
        flowType: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!session) {
      session = await this.prisma.whatsAppSession.create({
        data: {
          userId,
          phone: WEB_PHONE,
          flowType: null,
          flowStep: '0',
          flowState: {},
          expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
        },
      });
    }

    return session;
  }

  /** Shared: call AI, handle _pendingSelection, emit response via SSE */
  private async processAndEmit(dbUser: any, text: string): Promise<void> {
    const session = await this.getOrCreateSession(dbUser.id);
    const synUser = buildSyntheticUser(dbUser);

    // Stream text deltas to the frontend as Claude generates them
    const onDelta = (chunk: string, start?: boolean) => {
      this.sse.emitToUser(dbUser.id, 'ai:chunk', { text: chunk, start: !!start });
    };

    const result = await this.ai.chat(WEB_PHONE, text, synUser, session, onDelta);

    // Handle pending selection (set by AI tools like switch_company)
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const latestState = (freshSession?.flowState as any) || {};
    if (latestState._pendingSelection) {
      const { _pendingSelection, ...cleanState } = latestState;
      const selButtons = (_pendingSelection.items || []).slice(0, 10).map((item: any) => ({
        id: item.id || item.title,
        title: item.title || item.name || String(item.id),
      }));
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: cleanState },
      });
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: result.text,
        buttons: selButtons,
      });
      return;
    }

    this.sse.emitToUser(dbUser.id, 'ai:response', {
      text: result.text,
      buttons: result.buttons || [],
    });
  }

  /** Shared: validate user is active, emit error if not */
  private async validateUser(jwtUser: any): Promise<any | null> {
    const dbUser = await this.loadFullUser(jwtUser.sub);
    if (!dbUser || !dbUser.active) {
      this.sse.emitToUser(jwtUser.sub, 'ai:response', {
        text: 'Tu cuenta no se encuentra activa.',
        error: true,
      });
      return null;
    }
    return dbUser;
  }

  /** Process a text message from the web chat */
  async handleTextMessage(jwtUser: any, text: string): Promise<void> {
    const dbUser = await this.validateUser(jwtUser);
    if (!dbUser) return;

    try {
      await this.processAndEmit(dbUser, text);
    } catch (e) {
      this.logger.error(`Web chat error for user=${dbUser.id}: ${e.message}`, e.stack?.slice(0, 300));
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'Ocurrió un error procesando tu mensaje. Intentá de nuevo.',
        error: true,
      });
    }
  }

  /** Process an audio message: transcribe with Whisper then pass to AI */
  async handleAudioMessage(jwtUser: any, buffer: Buffer, mimeType: string): Promise<void> {
    const dbUser = await this.validateUser(jwtUser);
    if (!dbUser) return;

    if (!this.openai) {
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'El procesamiento de audio no se encuentra disponible.',
        error: true,
      });
      return;
    }

    if (buffer.length > MAX_AUDIO_BYTES) {
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'El audio excede el límite permitido. Enviá un mensaje más breve o escribí como texto.',
        error: true,
      });
      return;
    }

    try {
      // Determine extension from MIME
      const ext = mimeType.includes('webm') ? 'webm'
        : mimeType.includes('ogg') ? 'ogg'
        : mimeType.includes('mp4') ? 'mp4'
        : mimeType.includes('mpeg') ? 'mp3'
        : mimeType.includes('wav') ? 'wav'
        : 'webm';

      const uint8 = new Uint8Array(buffer);
      const file = new File([uint8], `audio.${ext}`, { type: mimeType });
      const transcription = await this.openai.audio.transcriptions.create({
        model: 'whisper-1',
        file,
        language: 'es',
      });

      const text = transcription.text?.trim();
      if (!text) {
        this.sse.emitToUser(dbUser.id, 'ai:response', {
          text: 'No fue posible procesar el audio. Intentá de nuevo o escribí como texto.',
          error: true,
        });
        return;
      }

      this.logger.log(`Web audio transcribed (${buffer.length} bytes, ${text.length} chars)`);

      // Notify client of transcription (so they can display it)
      this.sse.emitToUser(dbUser.id, 'ai:transcription', { text });

      // Process through AI with audio tag
      await this.processAndEmit(dbUser, `[Audio transcripto] ${text}`);
    } catch (e) {
      this.logger.error(`Web audio error for user=${dbUser.id}: ${e.message}`, e.stack?.slice(0, 300));
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'No fue posible procesar el audio. Intentá de nuevo o escribí como texto.',
        error: true,
      });
    }
  }

  /** Get conversation history for the current session */
  async getHistory(jwtUser: any): Promise<{ messages: any[] }> {
    const session = await this.prisma.whatsAppSession.findFirst({
      where: {
        userId: jwtUser.sub,
        phone: WEB_PHONE,
        flowType: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { updatedAt: 'desc' },
    });

    if (!session) return { messages: [] };

    const state = (session.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Convert AI message history to chat format
    // aiMessages format: [{ role: 'user'|'assistant', content: string|array }]
    const messages = aiMessages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant')
      .map((m: any, i: number) => {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        }
        // Skip tool_use / tool_result blocks for display
        if (!text) return null;
        return { id: `${session.id}-${i}`, role: m.role, text };
      })
      .filter(Boolean);

    return { messages };
  }
}
