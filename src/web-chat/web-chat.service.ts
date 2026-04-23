// =====================================================================
// TOLVINK — Web Chat Service
// Bridges the web frontend to the AI agent (reuses AiService.chat)
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { AgentService } from '../ai/agent.service';
import { GeminiClient, GeminiMessage, GeminiResponse } from '../ai/core/gemini.client';
import type { AiToolDefinition } from '../ai/tools/tool-definitions';
import { SseService } from '../sse/sse.service';
import OpenAI from 'openai';
import { OcrService } from '../ocr/ocr.service';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const WEB_PHONE = 'web'; // Distinguishes web sessions from WhatsApp
const WEB_MECHANIC_PHONE = 'web:mechanic';
const MAX_AUDIO_BYTES = 24 * 1024 * 1024; // 24MB (Whisper limit ~25MB)
const USER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_MECHANIC_HISTORY_MESSAGES = 20;
const MAX_MECHANIC_TOOL_ITERATIONS = 8;

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

    const isImage = doc.type === 'photo' || /\.(jpg|jpeg|png|webp|gif|heic|heif)$/i.test(doc.name);

    // For mechanic + image: pass directly to Gemini vision (no OCR needed)
    if (module === 'mechanic' && isImage) {
      try {
        const imgRes = await fetch(doc.url);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const mimeType = imgRes.headers.get('content-type') || 'image/jpeg';
        const base64 = buf.toString('base64');
        await this.processMechanicAndEmit(
          dbUser,
          `Analiza esta imagen de maquinaria: ${doc.name}`,
          session,
          { mimeType, data: base64 },
        );
      } catch (e) {
        this.logger.warn(`Mechanic image fetch failed for ${doc.name}: ${e.message}`);
        await this.processMechanicAndEmit(dbUser, `Subí una imagen: ${doc.name}`, session);
      }
      return;
    }

    // Store pendingDocument in session so AI knows to use attach_document
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: session.id },
      data: {
        flowState: { ...state, pendingDocument: { url: doc.url, name: doc.name, type: doc.type } },
      },
    });

    const updatedSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });

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

  // =====================================================================
  // MECHANIC MODULE — Agentic loop with tool support
  // =====================================================================

  private async processMechanicAndEmit(
    dbUser: any,
    text: string,
    session: any,
    imageData?: { mimeType: string; data: string },
  ): Promise<void> {
    if (!this.gemini.isEnabled()) {
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'El asistente mecánico no está disponible en este momento.',
        error: true,
      });
      return;
    }

    const state = (session.flowState as any) || {};
    const storedMessages = this.sanitizeGeminiHistory(state.aiMessages || []);

    // Build user message — text plus optional inline image for vision
    const userParts: any[] = [];
    if (imageData) {
      userParts.push({ inlineData: { mimeType: imageData.mimeType, data: imageData.data } });
    }
    userParts.push({ text: text.slice(0, 5000) });

    const userMessage: GeminiMessage = { role: 'user', parts: userParts };
    let messages: GeminiMessage[] = [...storedMessages, userMessage];

    const system = await this.buildMechanicPrompt(dbUser);
    const toolDefs = this.buildMechanicToolDefinitions();
    const geminiTools = this.gemini.convertTools(toolDefs);

    const started = Date.now();
    this.logger.log(`Mechanic chat start: user=${dbUser.id} text="${text.slice(0, 50)}"`);

    let lastText = '';
    try {
      const deadline = Date.now() + 60_000;

      for (let i = 0; i < MAX_MECHANIC_TOOL_ITERATIONS; i++) {
        if (Date.now() > deadline) throw new Error('Mechanic chat deadline exceeded (60s)');

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Gemini timeout after 30s')), 30_000),
        );
        const response: GeminiResponse = await Promise.race([
          this.gemini.sendMessage({ system, messages, tools: geminiTools }),
          timeout,
        ]);

        if (response.rawParts.length > 0) {
          messages.push({ role: 'model', parts: response.rawParts });
        }
        if (response.text) lastText = response.text;

        if (response.functionCalls.length === 0) break;

        // Execute all tool calls sequentially
        const toolParts: any[] = [];
        for (const fc of response.functionCalls) {
          this.logger.log(`Mechanic tool call: ${fc.name} args=${JSON.stringify(fc.args).slice(0, 100)}`);
          const result = await this.executeMechanicTool(fc.name, fc.args, dbUser);
          toolParts.push({ functionResponse: { name: fc.name, response: { result } } });
        }
        messages.push({ role: 'user', parts: toolParts });
      }
    } catch (err) {
      this.logger.error(`Mechanic chat error: user=${dbUser.id} ${Date.now() - started}ms — ${err.message}`);
      this.sse.emitToUser(dbUser.id, 'ai:response', {
        text: 'No pude procesar la consulta. Intentá de nuevo en unos momentos.',
        error: true,
      });
      return;
    }

    this.logger.log(`Mechanic chat done: user=${dbUser.id} ${Date.now() - started}ms`);

    // Persist only text turns (strip tool call/response plumbing from stored history)
    const cleanHistory: GeminiMessage[] = [];
    for (const msg of messages) {
      if (!Array.isArray(msg.parts)) continue;
      const textParts = msg.parts.filter((p: any) => p?.text && !p?.inlineData);
      if (textParts.length > 0) {
        cleanHistory.push({ role: msg.role, parts: textParts });
      }
    }
    const nextMessages = cleanHistory.slice(-MAX_MECHANIC_HISTORY_MESSAGES);

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
      text: lastText || 'No pude procesar la consulta mecánica.',
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

  // =====================================================================
  // MECHANIC TOOLS — Definitions
  // =====================================================================

  private buildMechanicToolDefinitions(): AiToolDefinition[] {
    return [
      {
        name: 'get_machine_detail',
        description: 'Obtiene el detalle completo de una maquina: especificaciones tecnicas, historial de mantenimiento (ultimos 10 registros), reparaciones, alertas pendientes y plan de mantenimiento.',
        input_schema: {
          type: 'object',
          properties: {
            machineId: { type: 'string', description: 'ID de la maquina (incluido en el listado del sistema)' },
          },
          required: ['machineId'],
        },
      },
      {
        name: 'update_horometer',
        description: 'Actualiza el horometro actual de una maquina.',
        input_schema: {
          type: 'object',
          properties: {
            machineId: { type: 'string', description: 'ID de la maquina' },
            horometer: { type: 'number', description: 'Nuevo valor del horometro en horas' },
          },
          required: ['machineId', 'horometer'],
        },
      },
      {
        name: 'create_maintenance_record',
        description: 'Registra un nuevo evento de mantenimiento (service programado, reparacion, cambio de repuesto, inspeccion).',
        input_schema: {
          type: 'object',
          properties: {
            machineId: { type: 'string', description: 'ID de la maquina' },
            type: { type: 'string', enum: ['scheduled_service', 'repair', 'part_change', 'inspection'], description: 'Tipo de mantenimiento' },
            description: { type: 'string', description: 'Descripcion del trabajo realizado' },
            date: { type: 'string', description: 'Fecha del mantenimiento (YYYY-MM-DD)' },
            horometerReading: { type: 'number', description: 'Lectura del horometro al momento del servicio (opcional)' },
            laborCost: { type: 'number', description: 'Costo de mano de obra en moneda local (opcional)' },
            totalCost: { type: 'number', description: 'Costo total incluyendo repuestos (opcional)' },
            partsUsed: { type: 'string', description: 'Descripcion de repuestos utilizados (opcional)' },
            workshop: { type: 'string', description: 'Taller o lugar donde se realizo el trabajo (opcional)' },
            mechanic: { type: 'string', description: 'Nombre del mecanico (opcional)' },
            notes: { type: 'string', description: 'Notas adicionales (opcional)' },
          },
          required: ['machineId', 'type', 'description', 'date'],
        },
      },
      {
        name: 'resolve_alert',
        description: 'Marca una alerta de mantenimiento como completada, reconocida o descartada.',
        input_schema: {
          type: 'object',
          properties: {
            alertId: { type: 'string', description: 'ID de la alerta' },
            status: { type: 'string', enum: ['completed', 'dismissed', 'acknowledged'], description: 'Nuevo estado' },
            notes: { type: 'string', description: 'Notas sobre la resolucion (opcional)' },
          },
          required: ['alertId', 'status'],
        },
      },
      {
        name: 'search_manuals',
        description: 'Busca en los manuales tecnicos y documentacion cargada por la empresa. Util para procedimientos, especificaciones, torques y fichas tecnicas propias.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Termino de busqueda (ej: "torque culata", "cambio filtro hidraulico", "capacidad aceite motor")' },
          },
          required: ['query'],
        },
      },
      {
        name: 'search_web',
        description: 'Busca en internet informacion tecnica sobre maquinaria agricola: codigos de error, especificaciones de fabricante, procedimientos de reparacion, compatibilidad de repuestos. Usar solo cuando la informacion no este en los datos de la empresa ni en el conocimiento propio.',
        input_schema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Consulta de busqueda en español (ej: "John Deere 8R codigo error ECU P0016", "torque tapa cilindros Case IH 250")' },
          },
          required: ['query'],
        },
      },
    ];
  }

  // =====================================================================
  // MECHANIC TOOLS — Execution
  // =====================================================================

  private async executeMechanicTool(name: string, args: any, user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    try {
      switch (name) {
        case 'get_machine_detail':        return await this.toolGetMachineDetail(args.machineId, companyId);
        case 'update_horometer':          return await this.toolUpdateHorometer(args.machineId, args.horometer, companyId);
        case 'create_maintenance_record': return await this.toolCreateMaintenanceRecord(args, companyId);
        case 'resolve_alert':             return await this.toolResolveAlert(args.alertId, args.status, args.notes, companyId);
        case 'search_manuals':            return await this.toolSearchManuals(args.query, companyId);
        case 'search_web':                return await this.toolSearchWeb(args.query);
        default: return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
      }
    } catch (e) {
      this.logger.warn(`Mechanic tool error [${name}]: ${e.message}`);
      return JSON.stringify({ error: e.message });
    }
  }

  private async toolGetMachineDetail(machineId: string, companyId: string): Promise<string> {
    const machine = await this.prisma.machine.findFirst({
      where: { id: machineId, companyId },
      include: {
        maintenanceAlerts: { where: { status: 'pending' }, orderBy: { createdAt: 'desc' } },
        maintenanceRecords: { orderBy: { date: 'desc' }, take: 10 },
        repairHistory: { orderBy: { date: 'desc' }, take: 5 },
        maintenancePlan: { select: { intervals: true, customIntervals: true } },
      },
    });
    if (!machine) return JSON.stringify({ error: 'Maquina no encontrada o sin acceso' });

    // Serialize cleanly (avoid circular refs, trim large fields)
    return JSON.stringify({
      id: machine.id,
      brand: machine.brand,
      model: machine.model,
      machineType: machine.machineType,
      year: machine.year,
      serialNumber: machine.serialNumber,
      engineBrand: machine.engineBrand,
      engineModel: machine.engineModel,
      enginePower: machine.enginePower,
      fuelType: machine.fuelType,
      currentHorometer: machine.currentHorometer,
      currentOdometer: machine.currentOdometer,
      status: machine.status,
      notes: machine.notes,
      maintenancePlan: machine.maintenancePlan,
      maintenanceAlerts: machine.maintenanceAlerts,
      maintenanceRecords: (machine.maintenanceRecords as any[]).map((r: any) => ({
        id: r.id, type: r.type, date: r.date, horometerReading: r.horometerReading,
        description: r.description, partsUsed: r.partsUsed, totalCost: r.totalCost,
        workshop: r.workshop, mechanic: r.mechanic, notes: r.notes,
      })),
      repairHistory: (machine.repairHistory as any[]).map((r: any) => ({
        id: r.id, description: r.description, date: r.date,
        workshop: r.workshop, cost: r.cost, notes: r.notes,
      })),
    });
  }

  private async toolUpdateHorometer(machineId: string, horometer: number, companyId: string): Promise<string> {
    const updated = await this.prisma.machine.updateMany({
      where: { id: machineId, companyId },
      data: { currentHorometer: horometer },
    });
    if (updated.count === 0) return JSON.stringify({ error: 'Maquina no encontrada o sin acceso' });
    return JSON.stringify({ success: true, message: `Horometro actualizado a ${horometer} hs` });
  }

  private async toolCreateMaintenanceRecord(args: any, companyId: string): Promise<string> {
    const machine = await this.prisma.machine.findFirst({ where: { id: args.machineId, companyId } });
    if (!machine) return JSON.stringify({ error: 'Maquina no encontrada o sin acceso' });

    const record = await this.prisma.maintenanceRecord.create({
      data: {
        machineId: args.machineId,
        companyId,
        type: args.type,
        description: args.description,
        date: new Date(args.date),
        horometerReading: args.horometerReading ?? null,
        laborCost: args.laborCost ?? null,
        totalCost: args.totalCost ?? null,
        partsUsed: args.partsUsed ? { description: args.partsUsed } : null,
        workshop: args.workshop ?? null,
        mechanic: args.mechanic ?? null,
        notes: args.notes ?? null,
      },
    });
    return JSON.stringify({ success: true, id: record.id, message: 'Registro de mantenimiento creado correctamente' });
  }

  private async toolResolveAlert(alertId: string, status: string, notes: string | undefined, companyId: string): Promise<string> {
    const updated = await this.prisma.maintenanceAlert.updateMany({
      where: { id: alertId, companyId },
      data: { status },
    });
    if (updated.count === 0) return JSON.stringify({ error: 'Alerta no encontrada o sin acceso' });
    return JSON.stringify({ success: true, message: `Alerta marcada como "${status}"` });
  }

  private async toolSearchManuals(query: string, companyId: string): Promise<string> {
    const results = await (this.prisma as any).machineManual.findMany({
      where: {
        companyId,
        OR: [
          { content: { contains: query, mode: 'insensitive' } },
          { title: { contains: query, mode: 'insensitive' } },
          { keywords: { contains: query, mode: 'insensitive' } },
        ],
      },
      select: { id: true, title: true, content: true, machineId: true },
      take: 3,
    });

    if (!results.length) return JSON.stringify({ message: 'No se encontraron manuales para esa consulta' });

    return results.map((r: any) => {
      const lower = r.content.toLowerCase();
      const idx = lower.indexOf(query.toLowerCase());
      const start = Math.max(0, idx >= 0 ? idx - 150 : 0);
      const end = Math.min(r.content.length, start + 1000);
      return `[${r.title}]\n${r.content.slice(start, end)}`;
    }).join('\n\n---\n\n');
  }

  private async toolSearchWeb(query: string): Promise<string> {
    const apiKey = this.config.get<string>('SERPER_API_KEY');
    if (!apiKey) return 'search_web no configurado. Respondé la consulta usando tu conocimiento propio sobre maquinaria agricola.';

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: query, num: 5, hl: 'es', gl: 'ar' }),
      });
      const data = await res.json() as any;
      const organic = (data.organic || []).slice(0, 5);
      if (!organic.length) return 'Sin resultados para esa consulta.';
      return organic.map((r: any) => `${r.title}\n${r.snippet || ''}\n${r.link}`).join('\n\n');
    } catch (e) {
      return `Error en busqueda web: ${e.message}`;
    }
  }

  // =====================================================================
  // MECHANIC PROMPT BUILDER
  // =====================================================================

  private async buildMechanicPrompt(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    const name = (user.name || 'usuario').split(' ')[0];
    const today = new Date().toISOString().slice(0, 10);

    const machines = companyId
      ? await this.prisma.machine.findMany({
          where: { companyId, status: { not: 'inactive' } },
          include: {
            maintenanceAlerts: { where: { status: 'pending' } },
            maintenanceRecords: { orderBy: { date: 'desc' }, take: 5 },
            repairHistory: { orderBy: { date: 'desc' }, take: 3 },
            maintenancePlan: { select: { intervals: true, customIntervals: true } },
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        })
      : [];

    const machineLines = machines.map((m: any) => {
      const alerts = (m.maintenanceAlerts || []).map((a: any) => `${a.label}[id:${a.id}]`).join(', ') || 'sin alertas';
      const records = (m.maintenanceRecords || []).map((r: any) =>
        `${r.type} ${r.date?.toISOString?.().slice(0, 10) || ''} hs=${r.horometerReading ?? 's/d'} ${r.description.slice(0, 60)}`,
      ).join(' | ') || 'sin registros';
      const repairs = (m.repairHistory || []).map((r: any) =>
        `${r.date?.toISOString?.().slice(0, 10) || ''} ${r.description.slice(0, 60)}`,
      ).join(' | ') || 'sin reparaciones';
      return [
        `- [id:${m.id}] ${m.brand} ${m.model} (${m.machineType}) año=${m.year ?? 's/d'} hs=${m.currentHorometer ?? 's/d'} estado=${m.status}`,
        `  motor=${m.engineBrand ?? ''} ${m.engineModel ?? ''} combustible=${m.fuelType ?? 's/d'}`,
        `  alertas: ${alerts}`,
        `  ultimos servicios: ${records}`,
        `  reparaciones: ${repairs}`,
      ].join('\n');
    }).join('\n') || '- Sin maquinas cargadas en el modulo.';

    return `Sos el asistente mecanico de Tolvink para gestion de maquinaria agricola.
USUARIO: ${name}
FECHA HOY: ${today}

ALCANCE:
- Ayudar con mantenimiento preventivo, alertas, historiales, horometro, planes, repuestos y diagnostico operativo.
- Usar la informacion de maquinas incluida abajo; para detalle completo de una maquina usa get_machine_detail.
- Cuando el usuario pida registrar un service, reparacion o actualizar horometro, usar las herramientas disponibles.
- No operar fletes ni logistica. Si preguntan por fletes, indicar que ese tema corresponde al modulo logistico.
- No inventar registros, costos, alertas ni horometros que no existan en los datos.
- Si falta un dato necesario para completar una accion, pedirlo antes de usar la herramienta.
- Para emergencias o reparaciones criticas, recomendar revisar con un mecanico calificado.
- Para buscar informacion tecnica externa (codigos de error, especificaciones de fabricante) intentar search_web primero; si no esta disponible, responder con tu conocimiento propio sobre la marca/modelo.
- Para buscar en manuales propios de la empresa usar search_manuals; si no hay resultados, responder desde conocimiento general.
- Si una herramienta falla o no devuelve resultados, NO decir "tuve un problema tecnico". Responder con lo que sabes y, si corresponde, indicar que no se encontro informacion especifica de la empresa.
- No podes generar imagenes ni diagramas visuales. Si piden un diagrama, describir el layout en texto y sugerir que el usuario suba una foto del tablero para analizarla.
- Tono: espanol rioplatense, claro, profesional y accionable.

HERRAMIENTAS DISPONIBLES:
- get_machine_detail: historial completo de una maquina por id
- update_horometer: actualizar horometro
- create_maintenance_record: registrar service, reparacion o inspeccion
- resolve_alert: marcar alerta como completada, reconocida o descartada
- search_manuals: buscar en manuales tecnicos de la empresa
- search_web: buscar informacion tecnica en internet

MAQUINAS Y ESTADO ACTUAL:
${machineLines}`;
  }
}
