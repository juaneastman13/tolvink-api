// =====================================================================
// TOLVINK — Web Chat Service
// Bridges the web frontend to the AI agent (reuses AiService.chat)
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AiService } from '../ai/ai.service';
import { SseService } from '../sse/sse.service';
import OpenAI from 'openai';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WEB_PHONE = 'web'; // Distinguishes web sessions from WhatsApp
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB (Whisper limit ~25MB)
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class WebChatService {
  private readonly logger = new Logger(WebChatService.name);
  private openai: OpenAI | null = null;
  // In-memory cache for user data to avoid repeated DB queries within a chat session
  private userCache = new Map<string, { data: any; expiresAt: number }>();

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

  /** Load full DB user with company/membership data (cached for 5 min) */
  private async loadFullUser(userId: string) {
    const now = Date.now();
    const cached = this.userCache.get(userId);
    if (cached && now < cached.expiresAt) return cached.data;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, types: true, hasInternalFleet: true } } },
        },
      },
    });
    if (user) {
      this.userCache.set(userId, { data: user, expiresAt: now + USER_CACHE_TTL_MS });
      // Evict old entries if cache grows too large
      if (this.userCache.size > 500) {
        for (const [k, v] of this.userCache) {
          if (now > v.expiresAt) this.userCache.delete(k);
        }
      }
    }
    return user;
  }

  /** Find or create an AI session for the web channel (isolated by company) */
  private async getOrCreateSession(userId: string, companyId?: string) {
    const where: any = {
      userId,
      phone: WEB_PHONE,
      flowType: null,
      expiresAt: { gt: new Date() },
    };
    // Include companyId in session lookup for company isolation
    if (companyId) {
      where.flowState = { path: ['selectedCompanyId'], equals: companyId };
    }

    let session = await this.prisma.whatsAppSession.findFirst({
      where,
      orderBy: { updatedAt: 'desc' },
    });

    if (!session) {
      session = await this.prisma.whatsAppSession.create({
        data: {
          userId,
          phone: WEB_PHONE,
          flowType: null,
          flowStep: '0',
          flowState: companyId ? { selectedCompanyId: companyId } : {},
          expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
        },
      });
    }

    return session;
  }

  /** Shared: call AI, handle _pendingSelection, emit response via SSE (fetches own session) */
  private async processAndEmit(dbUser: any, text: string): Promise<void> {
    this.sse.emitToUser(dbUser.id, 'ai:thinking', {});
    const companyId = dbUser.activeCompanyId || dbUser.companyId || undefined;
    const session = await this.getOrCreateSession(dbUser.id, companyId);
    return this.processAndEmitWithSession(dbUser, text, session);
  }

  /** Core: call AI with pre-fetched session, handle _pendingSelection, emit response via SSE */
  private async processAndEmitWithSession(dbUser: any, text: string, session: any): Promise<void> {
    // Stream text deltas to the frontend as Claude generates them
    const onDelta = (chunk: string, start?: boolean) => {
      this.sse.emitToUser(dbUser.id, 'ai:chunk', { text: chunk, start: !!start });
    };

    const chatStart = Date.now();
    this.logger.log(`Web chat start: user=${dbUser.id} text="${text.slice(0, 50)}"`);
    // Pass full dbUser (not synUser) — ai.service needs name, memberships, company for prompt building
    const result = await this.ai.chat(WEB_PHONE, text, dbUser, session, onDelta);
    this.logger.log(`Web chat done: user=${dbUser.id} ${Date.now() - chatStart}ms`);

    // Buttons (including pending selections) are already merged by ai.chat()
    this.sse.emitToUser(dbUser.id, 'ai:response', {
      text: result.text,
      buttons: result.buttons || [],
      navigate: result.navigate || undefined,
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
    // Emit thinking ASAP — before any DB queries
    this.sse.emitToUser(jwtUser.sub, 'ai:thinking', {});

    // Load user first to get companyId for session isolation
    const dbUser = await this.loadFullUser(jwtUser.sub);

    if (!dbUser || !dbUser.active) {
      this.sse.emitToUser(jwtUser.sub, 'ai:response', {
        text: 'Tu cuenta no se encuentra activa.',
        error: true,
      });
      return;
    }

    const companyId = dbUser.activeCompanyId || dbUser.companyId || undefined;
    const session = await this.getOrCreateSession(dbUser.id, companyId);

    try {
      await this.processAndEmitWithSession(dbUser, text, session);
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
    // Load fresh user from DB to get current activeCompanyId (JWT may be stale)
    const freshUser = await this.loadFullUser(jwtUser.sub);
    const companyId = freshUser?.activeCompanyId || freshUser?.companyId || jwtUser.companyId;
    const where: any = {
      userId: jwtUser.sub,
      phone: WEB_PHONE,
      flowType: null,
      expiresAt: { gt: new Date() },
    };
    if (companyId) {
      where.flowState = { path: ['selectedCompanyId'], equals: companyId };
    }
    const session = await this.prisma.whatsAppSession.findFirst({
      where,
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
