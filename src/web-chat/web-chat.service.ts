// =====================================================================
// TOLVINK — Web Chat Service
// Bridges the web frontend to the AI agent (reuses AiService.chat)
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../ai/agent.service';
import { GeminiClient, GeminiMessage, GeminiResponse } from '../ai/core/gemini.client';
import { SseService } from '../sse/sse.service';
import OpenAI from 'openai';
import { OcrService } from '../ocr/ocr.service';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WEB_PHONE = 'web'; // Distinguishes web sessions from WhatsApp
const WEB_MECHANIC_PHONE = 'web:mechanic';
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB (Whisper limit ~25MB)
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MECHANIC_HISTORY_MESSAGES = 20;

type WebChatModuleName = 'logistics' | 'mechanic';

function normalizeModule(module?: string): WebChatModuleName {
  return module === 'mechanic' ? 'mechanic' : 'logistics';
}

function phoneForModule(module: WebChatModuleName): string {
  return module === 'mechanic' ? WEB_MECHANIC_PHONE : WEB_PHONE;
}

@Injectable()
export class WebChatService {
  private readonly logger = new Logger(WebChatService.name);
  private openai: OpenAI | null = null;
  // In-memory cache for user data to avoid repeated DB queries within a chat session
  private userCache = new Map<string, { data: any; expiresAt: number }>();

  constructor(
    private prisma: PrismaService,
    private ai: AgentService,
    private gemini: GeminiClient,
    private sse: SseService,
    private config: ConfigService,
    private ocr: OcrService,
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
  private async getOrCreateSession(userId: string, companyId?: string, module: WebChatModuleName = 'logistics') {
    const where: any = {
      userId,
      phone: phoneForModule(module),
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
          phone: phoneForModule(module),
          flowType: null,
          flowStep: '0',
          flowState: { ...(companyId ? { selectedCompanyId: companyId } : {}), aiModule: module },
          expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
        },
      });
    }

    return session;
  }

  /** Shared: call AI, handle _pendingSelection, emit response via SSE (fetches own session) */
  private async processAndEmit(dbUser: any, text: string, module: WebChatModuleName = 'logistics'): Promise<void> {
    this.sse.emitToUser(dbUser.id, 'ai:thinking', {});
    const companyId = dbUser.activeCompanyId || dbUser.companyId || undefined;
    const session = await this.getOrCreateSession(dbUser.id, companyId, module);
    return this.processAndEmitWithSession(dbUser, text, session, module);
  }

  /** Core: call AI with pre-fetched session, handle _pendingSelection, emit response via SSE */
  private async processAndEmitWithSession(dbUser: any, text: string, session: any, module: WebChatModuleName = 'logistics'): Promise<void> {
    if (module === 'mechanic') {
      return this.processMechanicAndEmit(dbUser, text, session);
    }

    // Stream text deltas to the frontend as the AI provider generates them
    const onDelta = (chunk: string, start?: boolean) => {
      this.sse.emitToUser(dbUser.id, 'ai:chunk', { text: chunk, start: !!start });
    };

    const chatStart = Date.now();
    this.logger.log(`Web chat start: user=${dbUser.id} text="${text.slice(0, 50)}"`);
    // Pass full dbUser (not synUser) — ai/gemini service needs name, memberships, company for prompt building
    const result = await this.ai.chat(WEB_PHONE, text, dbUser, session, onDelta);
    this.logger.log(`Web chat done: user=${dbUser.id} ${Date.now() - chatStart}ms`);

    // Buttons (including pending selections) are already merged by ai.chat()
    this.sse.emitToUser(dbUser.id, 'ai:response', {
      text: result.text,
      buttons: result.buttons || [],
      navigate: (result as any).navigate || undefined,
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
  async handleTextMessage(jwtUser: any, text: string, moduleParam?: string): Promise<void> {
    const module = normalizeModule(moduleParam);
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
    const session = await this.getOrCreateSession(dbUser.id, companyId, module);

    try {
      await this.processAndEmitWithSession(dbUser, text, session, module);
    } catch (e) {
      this.logger.error(`Web chat error for user=${dbUser.id}: ${e.message}`, e.stack?.slice(0, 300));
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'Ocurrió un error procesando tu mensaje. Intentá de nuevo.',
        error: true,
      });
    }
  }

  /** Process an audio message: transcribe with Whisper then pass to AI */
  async handleAudioMessage(jwtUser: any, buffer: Buffer, mimeType: string, moduleParam?: string): Promise<void> {
    const module = normalizeModule(moduleParam);
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
        language: 'es', // Primary user base is Spanish (Uruguay/Argentina); Whisper handles accents well
        prompt: 'Tolvink, flete, planta, camión, productor, cosechadora, tractor',  // Domain vocabulary hint
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
      await this.processAndEmit(dbUser, `[Audio transcripto] ${text}`, module);
    } catch (e) {
      this.logger.error(`Web audio error for user=${dbUser.id}: ${e.message}`, e.stack?.slice(0, 300));
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'No fue posible procesar el audio. Intentá de nuevo o escribí como texto.',
        error: true,
      });
    }
  }

  /** Process a file uploaded by the user — runs OCR for images, sets pendingDocument */
  async handleFileMessage(jwtUser: any, doc: { url: string; name: string; type: string }, moduleParam?: string): Promise<void> {
    const module = normalizeModule(moduleParam);
    const dbUser = await this.validateUser(jwtUser);
    if (!dbUser) return;

    this.sse.emitToUser(dbUser.id, 'ai:thinking', {});

    const companyId = dbUser.activeCompanyId || dbUser.companyId || undefined;
    const session = await this.getOrCreateSession(dbUser.id, companyId, module);

    // Store pendingDocument in session so AI knows to use attach_document
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: { ...state, pendingDocument: { url: doc.url, name: doc.name, type: doc.type } },
      },
    });

    const updatedSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });

    const isImage = doc.type === 'photo' || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(doc.name);

    // For images: run OCR and include result in the message so AI can process inline
    let messageText: string;
    if (isImage) {
      try {
        const ocrResult = await this.ocr.analyzeFromUrl(doc.url);
        const ocrSummary = ocrResult?.textoOriginal
          ? `Contenido detectado: ${ocrResult.textoOriginal.slice(0, 500)}`
          : 'No se detectó texto en la imagen.';
        const docTypeLabel = ocrResult?.tipoDocumento ? ` (tipo: ${ocrResult.tipoDocumento})` : '';
        messageText = `Subí una imagen: ${doc.name}${docTypeLabel}. ${ocrSummary}`;
      } catch (e) {
        this.logger.warn(`OCR failed for ${doc.name}: ${e.message}`);
        messageText = `Subí una imagen: ${doc.name}`;
      }
    } else {
      messageText = `Subí un documento: ${doc.name}`;
    }

    try {
      await this.processAndEmitWithSession(dbUser, messageText, updatedSession, module);
    } catch (e) {
      this.logger.error(`Web file error for user=${dbUser.id}: ${e.message}`, e.stack?.slice(0, 300));
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'No fue posible procesar el archivo. Intentá de nuevo.',
        error: true,
      });
    }
  }

  /** Get conversation history for the current session */
  async getHistory(jwtUser: any, moduleParam?: string): Promise<{ messages: any[]; navigate?: any }> {
    const module = normalizeModule(moduleParam);
    // Load fresh user from DB to get current activeCompanyId (JWT may be stale)
    const freshUser = await this.loadFullUser(jwtUser.sub);
    const companyId = freshUser?.activeCompanyId || freshUser?.companyId || jwtUser.companyId;
    const where: any = {
      userId: jwtUser.sub,
      phone: phoneForModule(module),
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
    // aiMessages format: Anthropic legacy content or Gemini native parts
    const messages = aiMessages
      .filter((m: any) => m.role === 'user' || m.role === 'assistant' || m.role === 'model')
      .map((m: any, i: number) => {
        let text = '';
        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
        } else if (Array.isArray(m.parts)) {
          text = m.parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n');
        }
        // Skip tool_use / tool_result blocks for display
        if (!text) return null;
        // Strip injected system context prefixes from user messages (e.g. [Contexto activo: ...], [FLETE ACTIVO: ...], [Sistema: ...])
        if (m.role === 'user') {
          // Strip ALL injected system context prefixes (may be stacked: [Sistema: ...]\n\n[FLETE ACTIVO: ...]\n\nactual message)
          text = text.replace(/\[(?:Contexto activo|FLETE ACTIVO|Sistema|Audio transcripto)[^\]]*\]\s*/g, '').trim();
        }
        if (!text) return null;
        return { id: `${session.id}-${i}`, role: m.role === 'model' ? 'assistant' : m.role, text };
      })
      .filter(Boolean);

    // Include pending navigate so polling fallback can trigger navigation
    const navigate = state._lastNavigate || undefined;
    // Clear it after reading so it only fires once
    if (state._lastNavigate) {
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: { ...state, _lastNavigate: null } },
      });
    }

    return { messages, navigate };
  }

  private async processMechanicAndEmit(dbUser: any, text: string, session: any): Promise<void> {
    if (!this.gemini.isEnabled()) {
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'El asistente mecanico no esta disponible en este momento.',
        error: true,
      });
      return;
    }

    const state = (session.flowState as any) || {};
    const storedMessages = this.sanitizeGeminiHistory(state.aiMessages || []);
    const userMessage: GeminiMessage = { role: 'user', parts: [{ text: text.slice(0, 5000) }] };
    const messages: GeminiMessage[] = [...storedMessages, userMessage];
    const system = await this.buildMechanicPrompt(dbUser);

    const started = Date.now();
    this.logger.log(`Mechanic chat start: user=${dbUser.id} text="${text.slice(0, 50)}"`);

    let response: GeminiResponse;
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Gemini timeout after 30s')), 30_000),
      );
      response = await Promise.race([
        this.gemini.sendMessage({ system, messages, tools: [] }),
        timeout,
      ]);
    } catch (err) {
      this.logger.error(`Mechanic chat error: user=${dbUser.id} ${Date.now() - started}ms — ${err.message}`);
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'No pude procesar la consulta. Intentá de nuevo en unos momentos.',
        error: true,
      });
      return;
    }

    this.logger.log(`Mechanic chat done: user=${dbUser.id} ${Date.now() - started}ms`);

    const modelMessage: GeminiMessage = {
      role: 'model',
      parts: response.rawParts.length > 0 ? response.rawParts : [{ text: response.text }],
    };
    const nextMessages = [...messages, modelMessage].slice(-MAX_MECHANIC_HISTORY_MESSAGES);

    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: {
          ...state,
          aiModule: 'mechanic',
          aiMessages: nextMessages,
          lastMessageAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
      },
    });

    this.sse.emitToUser(dbUser.id, 'ai:response', {
      text: response.text || 'No pude procesar la consulta mecanica.',
      buttons: [],
    });
  }

  private sanitizeGeminiHistory(messages: any[]): GeminiMessage[] {
    const cleaned = messages.filter((m: any) =>
      m &&
      (m.role === 'user' || m.role === 'model') &&
      Array.isArray(m.parts) &&
      m.parts.some((p: any) => p?.text),
    );
    return cleaned.slice(-MAX_MECHANIC_HISTORY_MESSAGES);
  }

  private async buildMechanicPrompt(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    const name = (user.name || 'usuario').split(' ')[0];
    const machines = companyId
      ? await this.prisma.machine.findMany({
          where: { companyId, status: { not: 'inactive' } },
          include: {
            maintenanceAlerts: { where: { status: 'pending' } },
            maintenanceRecords: { orderBy: { date: 'desc' }, take: 1 },
            maintenancePlan: { select: { intervals: true, customIntervals: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : [];

    const machineLines = machines.map((m: any) => {
      const alerts = (m.maintenanceAlerts || []).map((a: any) => `${a.label}: ${a.message}`).join('; ') || 'sin alertas';
      const lastRecord = m.maintenanceRecords?.[0];
      const lastDate = lastRecord?.date?.toISOString?.().slice(0, 10) || '';
      const lastMaintenance = lastRecord ? `${lastRecord.type} ${lastDate}`.trim() : 'sin registros';
      return `- ${m.brand || ''} ${m.model || ''} (${m.machineType || 'maquina'}) hs=${m.currentHorometer ?? 's/d'} estado=${m.status}; alertas=${alerts}; ultimo=${lastMaintenance}`;
    }).join('\n') || '- Sin maquinas cargadas en el modulo.';

    return `Sos el asistente mecanico de Tolvink para gestion de maquinaria agricola.
USUARIO: ${name}

ALCANCE:
- Ayudar con mantenimiento preventivo, alertas, historiales, horometro, planes, repuestos y diagnostico operativo basico.
- Usar solamente la informacion de maquinas incluida abajo cuando hables de datos de la empresa.
- No operar fletes ni logistica. Si preguntan por fletes, indicar que ese tema corresponde al modulo logistico.
- No inventar registros, costos, alertas ni horometros.
- Si falta un dato, pedirlo de forma concreta.
- Para emergencias o reparaciones criticas, recomendar revisar con un mecanico calificado.
- Tono: espanol rioplatense, claro, profesional y accionable.

MAQUINAS Y ALERTAS DISPONIBLES:
${machineLines}`;
  }
}
