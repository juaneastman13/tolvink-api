// =====================================================================
// TOLVINK — AI Service (Claude / Anthropic)
// Conversational assistant for WhatsApp with tool use
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from '../freights/freights.service';
import { FieldsService } from '../fields/fields.service';
import { TrucksService } from '../trucks/trucks.controller';
import { AdminService } from '../admin/admin.controller';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { OcrService } from '../ocr/ocr.service';
import Anthropic from '@anthropic-ai/sdk';
import { buildSyntheticUser } from '../common/build-synthetic-user';
import { createSignedToken } from '../common/signed-token';
import { fuzzySearch, classifyFuzzyResult } from '../common/fuzzy-match';
import * as crypto from 'crypto';
import * as bcryptAi from 'bcryptjs';
import {
  MAX_HISTORY, MAX_TOOL_LOOPS, AI_SESSION_TIMEOUT_MIN, APP_URL, OWN_FLEET_SHORTCUT,
  MODEL_ID, MODEL_TEMPERATURE, MODEL_MAX_TOKENS, MAX_RESPONSE_CHARS, STALE_SESSION_MIN,
  URUGUAY_UTC_OFFSET_MS, FREIGHT_STATUS_LABELS, FREIGHT_STATUS_SHORT, AUDIO_FILLERS,
  AI_RATE_LIMIT_WINDOW_MS, AI_RATE_LIMIT_MAX,
} from './ai.constants';
import { AI_TOOL_DEFINITIONS } from './ai-tool-definitions';

const aiRateMap = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class AiService implements OnModuleDestroy {
  private readonly logger = new Logger(AiService.name);
  private client: Anthropic | null = null;
  private _requestLocationCooldowns = new Map<string, number>();
  // Per-chat-call side-effects accumulated by tools, merged into single session write by chat()
  private _chatSideEffects: Map<string, Record<string, any>> = new Map();
  // Per-session lock to prevent concurrent chat() calls from racing on side-effects
  private _chatLocks = new Set<string>();
  private rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of aiRateMap) { if (now > v.resetAt) aiRateMap.delete(k); }
    // Hard cap on rate map — evict oldest entries if too large
    if (aiRateMap.size > 10_000) {
      const iter = aiRateMap.keys();
      while (aiRateMap.size > 8_000) {
        const k = iter.next().value;
        if (k) aiRateMap.delete(k); else break;
      }
    }
    // Clean stale request_location cooldowns (5 min TTL) + hard cap
    for (const [k, v] of this._requestLocationCooldowns) {
      if (now - v > 5 * 60 * 1000) this._requestLocationCooldowns.delete(k);
    }
    if (this._requestLocationCooldowns.size > 5000) {
      const iter = this._requestLocationCooldowns.keys();
      while (this._requestLocationCooldowns.size > 4000) {
        const k = iter.next().value;
        if (k) this._requestLocationCooldowns.delete(k); else break;
      }
    }
    // Clean stale side effects (>10 min old, not all) + hard cap
    for (const [k, v] of this._chatSideEffects) {
      if (v._ts && now - v._ts > 10 * 60 * 1000) this._chatSideEffects.delete(k);
      else if (!v._ts) this._chatSideEffects.delete(k); // legacy entries without timestamp
    }
    if (this._chatSideEffects.size > 5_000) {
      const iter = this._chatSideEffects.keys();
      while (this._chatSideEffects.size > 4_000) {
        const k = iter.next().value;
        if (k) this._chatSideEffects.delete(k); else break;
      }
    }
  }, 5 * 60 * 1000);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
    @Inject(forwardRef(() => WhatsAppService)) private wa: WhatsAppService,
    private fieldsService: FieldsService,
    private trucksService: TrucksService,
    private adminService: AdminService,
    private ocrService: OcrService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      this.logger.log(`Claude AI assistant enabled (${MODEL_ID})`);
    } else {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI assistant disabled');
    }
  }

  onModuleDestroy() { clearInterval(this.rateCleanupTimer); }

  isEnabled(): boolean {
    return !!this.client;
  }

  // ======================== MAIN CHAT METHOD =============================

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    if (!this.client) {
      return { text: 'El asistente IA no está disponible en este momento.' };
    }

    // Per-user rate limiting — check BEFORE acquiring session lock to avoid lock leak
    const now = Date.now();
    const userId = user.id || phone;
    const rateEntry = aiRateMap.get(userId);
    if (rateEntry && now < rateEntry.resetAt) {
      if (rateEntry.count >= AI_RATE_LIMIT_MAX) {
        return { text: 'Ha enviado muchos mensajes en poco tiempo. Por favor aguarde unos minutos.' };
      }
      rateEntry.count++;
    } else {
      aiRateMap.set(userId, { count: 1, resetAt: now + AI_RATE_LIMIT_WINDOW_MS });
    }

    // Per-session lock: prevent concurrent chat() calls from racing on side-effects
    if (this._chatLocks.has(session.id)) {
      return { text: 'Estoy procesando su mensaje anterior, aguarde un momento.' };
    }
    this._chatLocks.add(session.id);
    // NOTE: rate map cleanup runs in rateCleanupTimer (setInterval) — not here, to avoid
    // mutations between lock acquisition and try/finally, and to prevent concurrent iteration.

    // WhatsApp session may have a selectedCompanyId different from user.activeCompanyId
    // (WhatsApp company selection is session-scoped to avoid desyncing the web app).
    const sessionState = (session?.flowState as any) || {};
    const sessionCompanyId = sessionState.selectedCompanyId;
    if (sessionCompanyId && sessionCompanyId !== user.activeCompanyId) {
      user.activeCompanyId = sessionCompanyId;
    }

    const synUser = this.buildSyntheticUser(user);
    const companyType = this.resolveCompanyType(user);
    const systemPrompt = this.buildSystemPrompt(user, companyType);

    // Cap message length to prevent context window abuse (5000 chars max)
    const cappedMessage = userMessage.length > 5000 ? userMessage.slice(0, 5000) : userMessage;
    // Preprocess: clean audio fillers, normalize whitespace
    const cleanedMessage = this.preprocessMessage(cappedMessage);

    // Load conversation history from session
    const state = (session?.flowState as any) || {};
    const aiMessages: any[] = state.aiMessages || [];

    // Stale session detection: inject context note if conversation paused
    let messageToSend = cleanedMessage;
    const lastMsgTime = state.lastMessageAt ? new Date(state.lastMessageAt).getTime() : 0;
    if (lastMsgTime && aiMessages.length > 0) {
      const minutesGap = (Date.now() - lastMsgTime) / 60000;
      if (minutesGap > STALE_SESSION_MIN) {
        messageToSend = `[Sistema: pasaron ${Math.round(minutesGap)} min desde el último mensaje. El usuario puede estar retomando o cambiando de tema.]\n\n${cleanedMessage}`;
      }
    }

    // Pending document: inject context so AI knows to use attach_document
    if (state.pendingDocument) {
      const doc = state.pendingDocument;
      const safeName = (doc.name || '').replace(/[^\w\s.\-()áéíóúñÁÉÍÓÚÑ]/g, '').slice(0, 60);
      const ctxFreight = state.activeContext?.lastFreightCode
        ? ` El último flete consultado fue ${this.sanitizeForPrompt(state.activeContext.lastFreightCode)} (${this.sanitizeForPrompt(state.activeContext.lastFreightSummary || '')}).`
        : '';
      messageToSend = `[Sistema: HAY UN ARCHIVO PENDIENTE de adjuntar — "${safeName}" (${doc.type}).${ctxFreight} Si el usuario indica un código de flete o hace referencia al flete anterior, usar attach_document DIRECTAMENTE. NO usar list_freights.]\n\n${messageToSend}`;
    }

    // Inject active context (survives message trimming) — sanitized to prevent injection
    if (state.activeContext && !state.pendingDocument) {
      const ac = state.activeContext;
      const parts: string[] = [];
      if (ac.lastFreightCode) {
        parts.push(`último flete: ${this.sanitizeForPrompt(ac.lastFreightCode)} — ${this.sanitizeForPrompt(ac.lastFreightSummary || '')}`);
      }
      if (ac.lastAction) {
        parts.push(`última acción: ${this.sanitizeForPrompt(ac.lastAction)}`);
      }
      if (ac.lastSearchFilter) {
        parts.push(`último filtro: ${this.sanitizeForPrompt(ac.lastSearchFilter)}`);
      }
      if (parts.length > 0) {
        messageToSend = `[Contexto activo: ${parts.join('. ')}]\n\n${messageToSend}`;
      }
    }

    // Inject pending action context so AI knows there's an unconfirmed operation
    if (state.pendingAction) {
      const pa = state.pendingAction;
      messageToSend = `[Sistema: hay una acción pendiente de confirmación: ${this.sanitizeForPrompt(pa.summary || pa.tool || '')}. Si el usuario confirma → confirm_action. Si cancela o cambia de tema → ignorar la acción pendiente.]\n\n${messageToSend}`;
    }

    // Add user message
    aiMessages.push({ role: 'user', content: messageToSend });

    // Smart trim: keep recent messages + preserve tool results from older ones
    const trimmed = this.smartTrimHistory(aiMessages);

    let response: any;
    let loopCount = 0;
    const currentMessages = [...trimmed];

    // Initialize per-call side-effects accumulator (tools write here, merged at end)
    this._chatSideEffects.delete(session.id);

    // Filter tools by role — don't expose admin/mutation tools to unauthorized roles
    const filteredTools = this.getFilteredTools(user, companyType);

    // Global timeout for entire tool execution loop (H1: prevent hanging)
    const loopDeadline = Date.now() + 90_000; // 90s max for all loops

    try {
      while (loopCount < MAX_TOOL_LOOPS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline exceeded after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Sending to Claude (loop ${loopCount}), messages: ${currentMessages.length}`);
        const createParams = {
          model: MODEL_ID,
          max_tokens: MODEL_MAX_TOKENS,
          temperature: MODEL_TEMPERATURE,
          system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
          tools: filteredTools.map((t, i, arr) =>
            i === arr.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
          ) as any,
          messages: currentMessages,
        };

        // 45s timeout to prevent hanging requests
        let timeoutHandle: ReturnType<typeof setTimeout>;
        const timeout = new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('Claude API timeout')), 45_000);
        });
        try {
          if (onDelta) {
            // Streaming mode: emit text deltas as they arrive
            let isFirst = true;
            const stream = this.client.messages.stream(createParams as any);
            stream.on('text', (text) => { try { onDelta(text, isFirst); isFirst = false; } catch {} });
            const streamResult = Promise.resolve(stream.finalMessage());
            response = await Promise.race([streamResult, timeout]) as any;
          } else {
            const apiCall = this.client.messages.create(createParams as any);
            response = await Promise.race([apiCall, timeout]) as any;
          }
        } finally {
          clearTimeout(timeoutHandle!);
        }
        this.logger.log(`Claude response: stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);

        if (response.stop_reason === 'tool_use') {
          // Add assistant response to messages
          currentMessages.push({ role: 'assistant', content: response.content });

          // Execute tool calls — parallel for read-only tools, sequential otherwise
          const READ_ONLY_TOOLS = new Set([
            'list_freights', 'get_freight_detail', 'search_plants', 'list_lots', 'list_fields',
            'list_transporters', 'list_trucks', 'list_company_users', 'list_drivers', 'summarize_freights',
            'list_documents', 'freight_history', 'get_dashboard',
            'generate_tracking_link', 'generate_map_link', 'generate_report_link', 'generate_daily_map_link',
          ]);

          const toolBlocks = response.content.filter((b: any) => b.type === 'tool_use');
          const allReadOnly = toolBlocks.every((b: any) => READ_ONLY_TOOLS.has(b.name));

          let toolResults: any[];
          if (allReadOnly && toolBlocks.length > 1) {
            // Execute all read-only tools in parallel
            this.logger.log(`Executing ${toolBlocks.length} read-only tools in parallel`);
            const settled = await Promise.allSettled(toolBlocks.map(async (block: any) => {
              this.logger.log(`AI tool call (parallel): ${block.name}`);
              const result = await this.executeTool(block.name, block.input, user, synUser, session);
              return { type: 'tool_result' as const, tool_use_id: block.id, content: result };
            }));
            toolResults = settled.map((s, i) =>
              s.status === 'fulfilled'
                ? s.value
                : { type: 'tool_result' as const, tool_use_id: toolBlocks[i].id, content: 'Error: ' + (s.reason?.message || 'Unknown error'), is_error: true },
            );
          } else {
            // Sequential execution for mutating tools or single tool
            toolResults = [];
            for (const block of toolBlocks) {
              this.logger.log(`AI tool call: ${(block as any).name}`);
              const result = await this.executeTool((block as any).name, (block as any).input, user, synUser, session);
              toolResults.push({
                type: 'tool_result' as const,
                tool_use_id: (block as any).id,
                content: result,
              });
            }
          }

          currentMessages.push({ role: 'user', content: toolResults });
        } else {
          break;
        }
      }

      // If loop exhausted while AI still wanted to call tools, provide graceful fallback
      if (response.stop_reason === 'tool_use' && loopCount >= MAX_TOOL_LOOPS) {
        this.logger.warn(`Tool loop exhausted at ${MAX_TOOL_LOOPS} iterations — AI wanted more tool calls`);
        // Extract any partial text the AI produced alongside the tool_use
        const partialText = response.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n')
          .trim();
        if (partialText) {
          // Use the partial text as the response
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: partialText }] };
        } else {
          // No text at all — the AI was mid-operation, provide a helpful message
          const activeCtx = state.activeContext?.lastFreightCode
            ? ` sobre el flete ${state.activeContext.lastFreightCode}`
            : '';
          response = { ...response, stop_reason: 'end_turn', content: [{ type: 'text', text: `La operación${activeCtx} requiere más pasos de los que puedo completar en una sola interacción. Por favor, intente con un pedido más específico o utilice la plataforma web: ${APP_URL}` }] };
        }
      }

      // Extract text response
      const textBlocks = response.content.filter((b: any) => b.type === 'text');
      let finalText = textBlocks.map((b: any) => b.text).join('\n') || 'No se pudo procesar el mensaje.';

      // Post-process: validate quality, strip UUIDs, enforce length
      finalText = this.validateResponse(finalText);

      // Save updated history — reload session first to preserve tool-written state (e.g. pendingFreight)
      currentMessages.push({ role: 'assistant', content: response.content });

      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const latestState = (freshSession?.flowState as any) || {};
      const latestFlowStep = freshSession?.flowStep ?? session.flowStep;
      const latestFlowType = freshSession?.flowType ?? session.flowType;

      // Merge tool side-effects (accumulated by storePendingSelection, stageAction, updateActiveContext)
      const sideEffects = this._chatSideEffects.get(session.id) || {};
      this._chatSideEffects.delete(session.id);

      // Extract pending buttons: side-effects take priority over DB state
      const pendingButtons = sideEffects._pendingButtons || latestState._pendingButtons || undefined;
      const { _pendingButtons: _dbBtns, ...cleanState } = latestState;
      const { _pendingButtons: _seBtns, _clearAiMessages, activeContext: seActiveContext, ...otherSideEffects } = sideEffects;

      // Merge activeContext: DB state + side-effects
      const mergedActiveContext = seActiveContext
        ? { ...(cleanState.activeContext || {}), ...seActiveContext }
        : cleanState.activeContext;

      // Trim old tool_result content to prevent flowState bloat (cap: 800 chars each)
      const trimmedMessages = currentMessages.slice(-MAX_HISTORY).map((msg, idx, arr) => {
        // Only trim tool_result messages that are not in the last 8 messages
        if (idx < arr.length - 8 && msg.role === 'user' && Array.isArray(msg.content)) {
          return { ...msg, content: msg.content.map(block =>
            block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 800
              ? { ...block, content: block.content.slice(0, 800) + '...[trimmed]' }
              : block
          )};
        }
        return msg;
      });
      const updateData: any = {
        flowState: {
          ...cleanState,
          ...otherSideEffects,
          ...(mergedActiveContext ? { activeContext: mergedActiveContext } : {}),
          aiMessages: _clearAiMessages ? [] : trimmedMessages,
          lastMessageAt: new Date().toISOString(),
        },
        expiresAt: new Date(Date.now() + AI_SESSION_TIMEOUT_MIN * 60 * 1000),
      };
      if (latestFlowStep !== session.flowStep) updateData.flowStep = latestFlowStep;
      if (latestFlowType !== session.flowType) updateData.flowType = latestFlowType;

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: updateData,
      });

      return { text: finalText, buttons: pendingButtons };
    } catch (e) {
      this._chatSideEffects.delete(session.id);
      this.logger.error(`Chat error: ${e.message}`, e.stack?.slice(0, 300));
      return { text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente o utilice las opciones del menú.' };
    } finally {
      this._chatLocks.delete(session.id);
    }
  }

  // ======================== SYSTEM PROMPT ================================

  /** Strip newlines/control chars/prompt delimiters from user-controlled strings interpolated into system prompt */
  private sanitizeForPrompt(s: string): string {
    return s
      .replace(/[\r\n\x00-\x1F]/g, ' ')
      .replace(/[\[\]{}]/g, '')   // Strip bracket/brace delimiters to prevent prompt injection
      .replace(/[<>]/g, '')       // Strip angle brackets
      .trim()
      .slice(0, 100);
  }

  private buildSystemPrompt(user: any, companyType: string): string {
    const name = this.sanitizeForPrompt(user.name?.split(' ')[0] || 'usuario');
    const nowUY = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS);
    const today = nowUY.toISOString().split('T')[0];

    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = activeMemberships.find((m: any) => m.companyId === activeCoId);
    const activeCoName = this.sanitizeForPrompt(activeMem?.company?.name || user.company?.name || '');

    // Check own fleet for the ACTIVE company only (not all memberships)
    const hasOwnFleet = activeMem?.company?.hasInternalFleet ||
      (!activeMem && user.company?.hasInternalFleet);
    const ownFleetNote = hasOwnFleet
      ? `\nFLOTA INTERNA: Tiene flota propia. Preguntar siempre: "¿Desea usar su flota propia o que la planta asigne?" Si sí → assign_transporter con transporterCompanyId="own_fleet".`
      : '';
    const multiCompanyNote = activeMemberships.length > 1
      ? `\nEMPRESA ACTIVA: ${activeCoName} (${companyType}). Pertenece a ${activeMemberships.length} empresas. Usar switch_company SOLO si el usuario pide cambiar. NO pedir que seleccione empresa si ya está operando correctamente.`
      : '';

    const isChofer = user.role === 'chofer' || (user.memberships || []).some((m: any) => m.role === 'chofer' && m.active);
    const userRole = isChofer ? 'chofer' :
      (['admin', 'platform_admin'].includes(user.role) ? 'admin' :
      user.role === 'gerente' ? 'gerente' : 'operario');
    const isAdmin = ['admin', 'platform_admin', 'gerente'].includes(userRole);

    // Build role restrictions — handles dual types (producer,plant) with additive blocks
    const roleParts: string[] = [];
    if (isChofer) {
      roleParts.push(`ROL CHOFER (${userRole}): Solo puede aceptar/rechazar/iniciar viajes, confirmar carga/entrega, consultar fletes, tracking y ubicación.
ACCIONES TÍPICAS DEL CHOFER: "mis fletes" → list_freights(status="accepted"). "ya cargué" → confirm_loaded del flete activo. "ya llegué/descargué" → confirm_finished. "salí del campo" → start_freight.
MULTI-CAMIÓN: Si el flete tiene varios viajes (trips), las acciones aplican al trip del chofer. Usar respond_trip, start_trip, confirm_trip_loaded, confirm_trip_finished para viajes individuales.
PROACTIVO: Si el chofer escribe sin contexto, usar list_freights para mostrar sus fletes asignados/activos ANTES de pedir un código.`);
    } else {
      if (AiService.hasType(companyType, 'producer')) {
        roleParts.push(`ROL PRODUCTOR (${userRole}): Puede crear fletes, gestionar campos/lotes, ver dashboard.
ACCIONES TÍPICAS: "quiero mandar soja" → iniciar creación de flete. "cómo van mis fletes" → get_dashboard o summarize_freights. "mis campos" → list_fields. "cancelar flete" → cancel_freight.`);
      }
      if (AiService.hasType(companyType, 'plant')) {
        roleParts.push(`ROL PLANTA (${userRole}): Puede asignar transportistas, autorizar fletes, gestionar pendientes.
ACCIONES TÍPICAS: "fletes pendientes" → list_freights(status="pending_assignment"). "asignar transportista" → list_freights + assign_transporter. "autorizar" → authorize_freight.`);
      }
      if (AiService.hasType(companyType, 'transporter')) {
        roleParts.push(`ROL TRANSPORTISTA (${userRole}): Puede aceptar/rechazar fletes, gestionar camiones y choferes.
ACCIONES TÍPICAS: "fletes asignados" → list_freights(status="assigned"). "mis camiones" → list_trucks. "mis choferes" → list_drivers.`);
      }
      if (roleParts.length === 0) {
        roleParts.push(`ROL OPERARIO (${userRole}): Puede consultar fletes y dashboard.`);
      }
    }
    roleParts.push(`PROACTIVO: Ante consultas vagas ("cómo va todo", "novedades", "hola, cómo están mis fletes"), usar get_dashboard primero. Si pregunta por un flete sin dar código, usar list_freights para mostrar opciones.`);

    const roleRestrictions = '\n' + roleParts.join('\n');

    return `Asistente de Tolvink — plataforma de gestión de fletes de granos y cargas del agro.
USUARIO: ${name} | Perfil: ${companyType} | Fecha: ${today} | Uruguay (UTC-3)${ownFleetNote}${multiCompanyNote}${roleRestrictions}

IDENTIDAD: "Capataz digital" — claro, directo, profesional, lenguaje del campo.
- Tratamiento de USTED. PROHIBIDO tuteo/voseo/coloquialismos (dale, bárbaro, jaja).
- Respuestas cortas y accionables. Sin disclaimers, sin tecnicismos, sin *negritas*.
- No mencionar nombres de herramientas ni estados internos del sistema al usuario.
- Incorrecto: "El flete pasó a estado in_progress." Correcto: "El camión ya salió del campo."
- No saludar si ya lo hizo. No repetir información ya confirmada.

SALUDO INICIAL: Ante un saludo sin solicitud concreta (solo "hola", "buenas"), responder con:
"Buenos días/tardes ${name}. ¿En qué puedo ayudarle?" seguido de 3-4 opciones breves relevantes al rol.
Si el saludo incluye una consulta ("hola, cómo van mis fletes"), resolver la consulta directamente con get_dashboard o list_freights.

EMOJIS: Usar como bullets al inicio de línea para datos/acciones. Permitidos hasta 1 por línea de datos:
🌾Campo 🗺️Lote 🚛Viaje 📦Carga 📍Origen/Destino 📅Fecha 🕒Hora 👤Transportista
🏢Empresa ✅Confirmado ⚠️Advertencia ⛔Denegado ❌Error ⏳Pendiente
Ejemplo:
✅ Flete creado
📦 Soja — 90 toneladas
🗺️ Lote 5 — Campo El Ombú
📅 15 marzo — 08:00

FORMATO: Una acción/dato por línea. URLs como texto plano (no [texto](url)). No usar separadores como ──── o ═══.

BÚSQUEDA PROACTIVA (CRÍTICO):
- NUNCA pedir un código de flete si se puede buscar automáticamente.
- Si el usuario da un código directamente → get_freight_detail DIRECTO, no buscar.
- Sin código → usar list_freights o summarize_freights con filtros (grano, estado, fecha, destino).
- "el flete de soja" → list_freights(grain="Soja"). "quiero rechazar" → list_freights(status="assigned").
- Solo pedir código si hay ambigüedad real DESPUÉS de buscar y obtener múltiples resultados.

CONTEXTO CONVERSACIONAL:
- Mantener hilo. Resolver "eso", "el flete", "ese campo" del historial reciente.
- FLETE ACTIVO: al consultar/seleccionar un flete, queda activo para acciones posteriores. No re-pedir código.
- Se pierde al: seleccionar otro flete, switch_company, o expirar sesión. Preguntas no relacionadas ("¿cuántos camiones tengo?") NO pierden el flete activo.
- Datos faltantes: 1→preguntar ese dato puntual; 2+→listar todos en bullets.
- Fechas en UTC-3. "a las 8" = 08:00. Formatos: "15/3", "mañana", "el lunes".

ANTI-ALUCINACIÓN (CRÍTICO):
- SOLO afirmar datos de resultados de herramientas. NUNCA inventar códigos, nombres, toneladas, fechas.
- NUNCA confirmar acción si la herramienta no la ejecutó.
- NUNCA exponer UUIDs. Solo códigos de flete (ej: F26-LCP.1822).
- SIEMPRE mostrar el código de flete COMPLETO incluyendo el prefijo (F26-XXX.YYYY). NUNCA recortar ni omitir partes del código.

AUDIO: Interpretar intención (errores fonéticos: "solla"=Soja, "tigo"=Trigo). No resetear contexto activo.

IMÁGENES/DOCUMENTOS:
- Archivo ya descargado. Si hay flete activo → attach_document directo. Si no → preguntar código.
- Código de flete + archivo pendiente → attach_document DIRECTO (no list_freights).
- OCR: Si el usuario envía foto de remito/pesaje/carta de porte → ocr_analyze para extraer datos. Si hay flete activo, ofrecer adjuntar.

UBICACIONES:
- No mostrar coordenadas crudas ni enlaces a Google Maps a choferes/operarios.${isAdmin ? ' Admins y gerentes pueden solicitar coordenadas explícitamente.' : ''}
- Con mapLink → frase breve + link Tolvink. Sin mapLink → "Ubicación no disponible."
- Para marcar ubicación → generate_location_link. ÚNICA vía válida.
- Sin coordenadas NO crear campo/lote/origen/destino personalizado.

LISTAS Y SELECCIÓN:
- _selectionSent:true → lista YA enviada como menú interactivo. NO reformatear la lista. Agregar frase contextual breve (ej: "Tiene 3 fletes pendientes. Seleccione uno para ver detalle.").
- Resúmenes/análisis/estadísticas → summarize_freights (NO list_freights).
- list_freights es SOLO para selección individual.

ESTADOS (traducir SIEMPRE al español):
draft→"Borrador" | pending_assignment→"Pendiente de asignación" | assigned→"Asignado"
accepted→"Aceptado" | in_progress→"En camino" | loaded→"Cargado" | finished→"Finalizado"
canceled→"Cancelado" | rejected→"Rechazado"

PRODUCTOS: Soja, Maíz, Trigo, Girasol, Sorgo, Cebada, Otros (con nombre). Unidades: toneladas (default), cantidad, metros, m³.

CONFIRMACIÓN DE ACCIONES (CRÍTICO):
Toda acción que modifica datos usa patrón de 2 etapas:
1. Herramienta PREPARA la acción → mostrar resumen al usuario.
2. Usuario confirma → llamar confirm_action (o confirm_create_freight para fletes nuevos).
SIN confirm la acción NO se ejecuta. NUNCA indicar que se ejecutó sin confirmar.
Botones CONFIRMAR/CANCELAR se envían automáticamente. No mencionarlos en texto.

CREAR FLETES:
1. AUTO-RESOLVER NOMBRES: Si el usuario dice "campo El Ombú" o "planta Conaprole", pasar el texto como originName/destName a prepare_freight. El sistema busca automáticamente en campos, lotes y plantas del usuario y resuelve el ID. NO necesitás buscar IDs manualmente con search_plants/list_lots primero.
2. prepare_freight → resumen → confirm_create_freight al confirmar.
3. Datos faltantes: pedir SOLO los que faltan.
4. Si la planta destino tiene SUCURSALES (branches), es OBLIGATORIO indicar cuál. El sistema lo validará y devolverá las opciones.
5. Si se asigna FLOTA PROPIA (truckId), es OBLIGATORIO indicar chofer (driverId). El chofer puede ser de list_drivers o "self" (= el propio usuario).
6. DUPLICAR FLETE: Es una copia idéntica. Solo validar la fecha nueva (loadDate). NO pedir reconfirmar datos.
7. Ubicación obligatoria para origen/destino custom → generate_location_link.

ASIGNAR TRANSPORTISTA:
- Con flota interna → assign_transporter(transporterCompanyId="own_fleet") directo.
- Sin flota → list_transporters → selección → assign_transporter → confirm_action.
- Multi-camión: assign_truck_to_freight por viaje adicional.

FLOTA PROPIA (flujo): assigned → planta autoriza (authorize_freight) → accepted → in_progress.

DOBLE CONFIRMACIÓN: Carga y entrega requieren confirmación de AMBAS partes. Si solo una confirmó, informar que falta la otra.

RECHAZO: Si un transportista rechaza un flete → informar al usuario y sugerir reasignar con list_transporters.

COLA DE CHOFERES: Solo posición 1 puede ejecutar acciones.

SEGUIMIENTO: generate_tracking_link (vivo), generate_report_link (PDF), generate_daily_map_link (mapa del día).
UBICACIÓN VIVA: share_live_location, view_live_locations, request_location.

EQUIPO (admin/gerente): update_user_role, deactivate_user, reactivate_user → confirm_action.

MODIFICACIONES: update_freight valida internamente — SIEMPRE llamar. Para cambiar planta→search_plants, camión→list_trucks, chofer→list_drivers.

ERRORES DE HERRAMIENTAS: Traducir a lenguaje claro y accionable. Ejemplos:
- "NOT_FOUND" → "No se encontró el flete. ¿Puede verificar el código?"
- "UNAUTHORIZED" → "No tiene permisos para esta acción."
- "VALIDATION_ERROR" → explicar qué dato es incorrecto y qué se espera.
- Borradores → "Puede completarlo desde la plataforma web."
CHAT INTERNO: Derivar a web: ${APP_URL}

LINKS A LA APP (usar cuando corresponda):
- Plataforma web: ${APP_URL}
- Ver flete específico: el link viene en el campo "link" de get_freight_detail. SIEMPRE incluirlo al mostrar detalle.
- Mapa del día: generate_daily_map_link. Incluir cuando el usuario pregunte panorama general.
- Reporte PDF: generate_report_link. Ofrecer cuando el usuario necesite documentación formal.
- Ante funcionalidad no disponible por WhatsApp → derivar con link directo.

TERMINOLOGÍA CORRECTA:
- Documento de transporte: "remito" (NO "carta de porte").
- Viaje: usar "viaje" o "flete" según contexto. "Trip" es interno, no mencionarlo.
- Empresa tipo: "productor", "planta", "transportista". NO usar "producer/plant/transporter".`;
  }

  // ======================== CONTEXT-BASED TOOL FILTERING ==================

  // CORE: Always included for all roles (confirmation, detail, listing)
  private static readonly CORE_TOOLS = new Set([
    'confirm_action', 'confirm_create_freight', 'list_freights', 'get_freight_detail',
    'summarize_freights', 'update_profile',
  ]);

  // CHOFER: Only these tools for driver role
  private static readonly CHOFER_TOOLS = new Set([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded',
    'confirm_finished', 'get_freight_detail', 'list_freights', 'generate_tracking_link',
    'share_live_location', 'view_live_locations', 'request_location', 'confirm_action',
    'respond_trip', 'start_trip', 'confirm_trip_loaded', 'confirm_trip_finished',
    'update_profile', 'ocr_analyze',
  ]);

  // PRODUCER: Creation & management tools
  private static readonly PRODUCER_TOOLS = new Set([
    'prepare_freight', 'list_lots', 'list_fields', 'create_field', 'create_lot',
    'search_plants', 'list_trucks', 'create_truck', 'generate_location_link',
    'duplicate_freight', 'update_field', 'update_lot', 'cancel_freight',
    'list_enabled_plants',
  ]);

  // PLANT: Assignment & management tools
  private static readonly PLANT_TOOLS = new Set([
    'search_plants', 'list_transporters', 'assign_transporter', 'assign_truck_to_trip',
    'assign_truck_to_freight', 'list_trucks', 'list_drivers', 'authorize_freight',
    'cancel_assignment', 'update_assignment', 'cancel_freight',
    'assign_multi_trucks', 'view_driver_queue', 'reorder_driver_queue',
    'list_enabled_producers', 'grant_producer_access', 'revoke_producer_access',
  ]);

  // TRANSPORTER: Trip & freight response tools
  private static readonly TRANSPORTER_TOOLS = new Set([
    'accept_freight', 'reject_freight', 'start_freight', 'confirm_loaded',
    'confirm_finished', 'respond_trip', 'start_trip', 'confirm_trip_loaded',
    'confirm_trip_finished', 'list_trucks', 'list_drivers',
    'deactivate_truck', 'deactivate_driver',
  ]);

  // TRACKING & MAPS: Available when user may need location/tracking features
  private static readonly TRACKING_TOOLS = new Set([
    'generate_tracking_link', 'generate_map_link', 'generate_report_link',
    'generate_daily_map_link', 'share_live_location', 'view_live_locations',
    'request_location',
  ]);

  // ANALYTICS & DOCS: Available for all non-chofer roles
  private static readonly ANALYTICS_TOOLS = new Set([
    'get_dashboard', 'list_documents', 'freight_history', 'update_freight',
    'attach_document', 'ocr_analyze', 'generate_batch_report_link',
    'delete_document', 'save_ocr_data',
  ]);

  // ADMIN: Only for admin/gerente roles
  private static readonly ADMIN_TOOLS = new Set([
    'create_user', 'update_user_role', 'deactivate_user', 'reactivate_user',
    'list_company_users', 'list_drivers', 'create_driver',
    'update_truck', 'deactivate_truck', 'deactivate_driver',
    'list_branches', 'create_branch', 'update_branch', 'delete_branch',
    'update_company', 'update_user_admin',
  ]);

  // MULTI-COMPANY: Only when user has multiple memberships
  private static readonly MULTI_COMPANY_TOOLS = new Set([
    'switch_company',
  ]);

  // PENDING CHANGES: Only include when relevant
  private static readonly PENDING_CHANGE_TOOLS = new Set([
    'approve_pending_change', 'reject_pending_change',
  ]);

  private getFilteredTools(user: any, companyType: string): any[] {
    const isChofer = user.role === 'chofer' || (user.memberships || []).some((m: any) => m.role === 'chofer' && m.active);
    const isAdmin = ['admin', 'platform_admin', 'gerente'].includes(user.role) ||
      (user.memberships || []).some((m: any) => ['admin', 'gerente'].includes(m.role) && m.active);
    const activeMemberships = (user.memberships || []).filter((m: any) => m.active);
    const hasMultiCompany = activeMemberships.length > 1;

    // Choferes: restricted set
    if (isChofer && !isAdmin) {
      return this.tools.filter(t => AiService.CHOFER_TOOLS.has(t.name));
    }

    // Build allowed set based on role context
    const allowed = new Set<string>(AiService.CORE_TOOLS);

    // Add tracking/maps for everyone
    for (const t of AiService.TRACKING_TOOLS) allowed.add(t);

    // Add analytics/docs for non-chofer
    for (const t of AiService.ANALYTICS_TOOLS) allowed.add(t);

    // Role-based additions
    const isProducer = AiService.hasType(companyType, 'producer');
    const isPlant = AiService.hasType(companyType, 'plant');
    const isTransporter = AiService.hasType(companyType, 'transporter');

    if (isProducer) {
      for (const t of AiService.PRODUCER_TOOLS) allowed.add(t);
    }
    if (isPlant) {
      for (const t of AiService.PLANT_TOOLS) allowed.add(t);
      for (const t of AiService.PENDING_CHANGE_TOOLS) allowed.add(t);
    }
    if (isTransporter) {
      for (const t of AiService.TRANSPORTER_TOOLS) allowed.add(t);
    }

    // Admin tools
    if (isAdmin) {
      for (const t of AiService.ADMIN_TOOLS) allowed.add(t);
    }

    // Multi-company
    if (hasMultiCompany) {
      for (const t of AiService.MULTI_COMPANY_TOOLS) allowed.add(t);
    }

    return this.tools.filter(t => allowed.has(t.name));
  }

  // ======================== TOOL DEFINITIONS =============================

  private readonly tools = AI_TOOL_DEFINITIONS;


  // ======================== TOOL EXECUTION ===============================

  // Tools that represent completed actions — track in activeContext.lastAction
  private static readonly ACTION_TOOLS = new Set([
    'confirm_action', 'confirm_create_freight', 'accept_freight', 'reject_freight',
    'start_freight', 'confirm_loaded', 'confirm_finished', 'cancel_freight',
    'assign_transporter', 'authorize_freight', 'create_field', 'create_lot',
    'create_truck', 'create_user', 'update_freight', 'duplicate_freight',
  ]);

  // Tools that search/filter — track in activeContext.lastSearchFilter
  private static readonly SEARCH_TOOLS = new Set([
    'list_freights', 'summarize_freights',
  ]);

  private async executeTool(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
    try {
      // Track search filters in active context
      if (AiService.SEARCH_TOOLS.has(toolName) && session?.id) {
        const filterParts: string[] = [];
        if (input.status) filterParts.push(`estado=${input.status}`);
        if (input.grain) filterParts.push(`grano=${input.grain}`);
        if (input.dateFrom) filterParts.push(`desde=${input.dateFrom}`);
        if (input.dateTo) filterParts.push(`hasta=${input.dateTo}`);
        if (filterParts.length > 0) {
          this.updateActiveContext(session.id, { lastSearchFilter: filterParts.join(', ') });
        }
      }

      const result = await this._executeToolInner(toolName, input, user, synUser, session);

      // Track completed actions in active context
      if (AiService.ACTION_TOOLS.has(toolName) && session?.id) {
        const code = input.code || '';
        this.updateActiveContext(session.id, { lastAction: `${toolName}${code ? ` (${code})` : ''}` });
      }

      return result;
    } catch (e) {
      this.logger.error(`Tool ${toolName} error: ${e.message}`);
      const SAFE_PATTERNS = [
        /no (se )?encontr/i, /no tiene acceso/i, /no se puede/i, /solo.*pueden/i,
        /no.*permiso/i, /ya existe/i, /no pertenec/i, /flete.*no/i, /campo.*no/i,
        /lote.*no/i, /camión.*no/i, /código.*requerido/i, /inválid/i,
      ];
      const isSafe = SAFE_PATTERNS.some(p => p.test(e.message || ''));
      const safeMsg = isSafe ? e.message : 'Error al procesar la solicitud.';
      return JSON.stringify({ error: safeMsg });
    }
  }

  private async _executeToolInner(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
      switch (toolName) {
        case 'list_freights': return await this.toolListFreights(synUser, input, session);
        case 'get_freight_detail': return await this.toolGetFreightDetail(input, user, session);
        case 'search_plants': return await this.toolSearchPlants(input, user, session);
        case 'list_lots': return await this.toolListLots(user, session);
        case 'prepare_freight': return await this.toolPrepareFreight(input, user, session);
        case 'confirm_create_freight': return await this.toolConfirmCreateFreight(user, synUser, session);
        case 'confirm_action': return await this.toolConfirmAction(user, synUser, session);
        case 'accept_freight': return await this.toolAcceptFreight(input, user, synUser, session);
        case 'reject_freight': return await this.toolRejectFreight(input, user, synUser, session);
        case 'start_freight': return await this.toolStartFreight(input, user, synUser, session);
        case 'confirm_loaded': return await this.toolConfirmLoaded(input, user, synUser, session);
        case 'confirm_finished': return await this.toolConfirmFinished(input, user, synUser, session);
        case 'cancel_freight': return await this.toolCancelFreight(input, user, synUser, session);
        case 'list_fields': return await this.toolListFields(user, session);
        case 'create_field': return await this.toolCreateField(input, user, session);
        case 'create_lot': return await this.toolCreateLot(input, user, session);
        case 'list_trucks': return await this.toolListTrucks(user, session);
        case 'create_truck': return await this.toolCreateTruck(input, user, session);
        case 'create_user': return await this.toolCreateUser(input, user, session);
        case 'attach_document': return await this.toolAttachDocument(input, user, synUser, session);
        case 'generate_location_link': return this.toolGenerateLocationLink(input, session);
        case 'generate_tracking_link': return await this.toolGenerateTrackingLink(input, user);
        case 'generate_map_link': return await this.toolGenerateMapLink(input);
        case 'generate_report_link': return await this.toolGenerateReportLink(input, user);
        case 'generate_daily_map_link': return await this.toolGenerateDailyMapLink(user);
        case 'share_live_location': return await this.toolShareLiveLocation(input, user);
        case 'view_live_locations': return await this.toolViewLiveLocations(input, user);
        case 'request_location': return await this.toolRequestLocation(input, user);
        case 'list_transporters': return await this.toolListTransporters(user, session);
        case 'assign_transporter': return await this.toolAssignTransporter(input, user, synUser, session);
        case 'assign_truck_to_trip': return await this.toolAssignTruckToTrip(input, user, synUser, session);
        case 'assign_truck_to_freight': return await this.toolAssignTruckToFreight(input, user, synUser, session);
        case 'list_company_users': return await this.toolListCompanyUsers(user, session);
        case 'list_drivers': return await this.toolListDrivers(user, session);
        case 'update_user_role': return await this.toolUpdateUserRole(input, user, session);
        case 'deactivate_user': return await this.toolDeactivateUser(input, user, session);
        case 'switch_company': return await this.toolSwitchCompany(input, user, session);
        case 'summarize_freights': return await this.toolSummarizeFreights(synUser, input);
        case 'update_freight': return await this.toolUpdateFreight(input, user, session);
        case 'duplicate_freight': return await this.toolDuplicateFreight(input, user, synUser, session);
        case 'list_documents': return await this.toolListDocuments(input, user);
        case 'freight_history': return await this.toolFreightHistory(input, user);
        case 'get_dashboard': return await this.toolGetDashboard(user);
        case 'update_field': return await this.toolUpdateField(input, user, session);
        case 'update_lot': return await this.toolUpdateLot(input, user, session);
        case 'reactivate_user': return await this.toolReactivateUser(input, user, session);
        case 'authorize_freight': return await this.toolAuthorizeFreight(input, user, session);
        case 'approve_pending_change': return await this.toolApprovePendingChange(input, user, session);
        case 'reject_pending_change': return await this.toolRejectPendingChange(input, user, session);
        case 'respond_trip': return await this.toolRespondTrip(input, user, session);
        case 'start_trip': return await this.toolStartTrip(input, user, session);
        case 'confirm_trip_loaded': return await this.toolConfirmTripLoaded(input, user, session);
        case 'confirm_trip_finished': return await this.toolConfirmTripFinished(input, user, session);
        case 'cancel_assignment': return await this.toolCancelAssignment(input, user, session);
        case 'update_assignment': return await this.toolUpdateAssignment(input, user, session);
        case 'create_driver': return await this.toolCreateDriver(input, user, session);
        case 'update_profile': return await this.toolUpdateProfile(input, user, session);
        case 'generate_batch_report_link': return await this.toolGenerateBatchReportLink(input, user);
        case 'ocr_analyze': return await this.toolOcrAnalyze(input, user, session);
        // --- New tools: admin & management ---
        case 'delete_document': return await this.toolDeleteDocument(input, user, session);
        case 'save_ocr_data': return await this.toolSaveOcrData(input, user, session);
        case 'deactivate_truck': return await this.toolDeactivateTruck(input, user, session);
        case 'update_truck': return await this.toolUpdateTruck(input, user, session);
        case 'deactivate_driver': return await this.toolDeactivateDriver(input, user, session);
        case 'list_enabled_plants': return await this.toolListEnabledPlants(user);
        case 'list_enabled_producers': return await this.toolListEnabledProducers(user);
        case 'grant_producer_access': return await this.toolGrantProducerAccess(input, user, session);
        case 'revoke_producer_access': return await this.toolRevokeProducerAccess(input, user, session);
        case 'list_branches': return await this.toolListBranches(user);
        case 'create_branch': return await this.toolCreateBranch(input, user, session);
        case 'update_branch': return await this.toolUpdateBranch(input, user, session);
        case 'delete_branch': return await this.toolDeleteBranch(input, user, session);
        case 'update_company': return await this.toolUpdateCompany(input, user, session);
        case 'update_user_admin': return await this.toolUpdateUserAdmin(input, user, session);
        case 'assign_multi_trucks': return await this.toolAssignMultiTrucks(input, user, session);
        case 'view_driver_queue': return await this.toolViewDriverQueue(input, user);
        case 'reorder_driver_queue': return await this.toolReorderDriverQueue(input, user, session);
        default: return JSON.stringify({ error: 'Herramienta no reconocida' });
    }
  }

  // ---- list_freights ----
  private async toolListFreights(synUser: any, input: any, session: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      grain: input.grain,
      limit: 50,
      page: 1,
    } as any);

    const filtered = result.data.sort((a: any, b: any) =>
      (a.destName || '').localeCompare(b.destName || '') || (a.originName || '').localeCompare(b.originName || ''));

    if (filtered.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan con los filtros.' });
    }

    const items = filtered.map((f: any) => {
      const grain = f.items?.[0]?.grain || 'N/A';
      const tons = f.items?.[0]?.tons || 0;
      const origin = f.originName || f.originCompany?.name || '?';
      const dest = f.destName || f.destCompany?.name || '?';
      const status = FREIGHT_STATUS_SHORT[f.status] || f.status;
      return {
        id: `freight:${f.id}`,
        title: `${f.code} | ${grain} ${tons}tn`.slice(0, 24),
        description: `${origin} → ${dest} | ${status}`.slice(0, 72),
      };
    });

    const statusLabel = input.status ? ` (${FREIGHT_STATUS_SHORT[input.status] || input.status})` : '';
    return this.storePendingSelection(session, items, {
      headerText: `📦 ${filtered.length} flete${filtered.length !== 1 ? 's' : ''}${statusLabel}.\nSeleccione uno para ver detalles:`,
      listButtonLabel: 'Ver fletes',
      sectionTitle: 'FLETES',
    }, 'freight_selection');
  }

  // ---- summarize_freights ----
  private async toolSummarizeFreights(synUser: any, input: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      grain: input.grain,
      limit: 100,
      page: 1,
    } as any);

    // Post-query filter: transporter name (requires join data, can't easily DB-filter)
    let filtered = result.data.sort((a: any, b: any) =>
      (a.destName || '').localeCompare(b.destName || '') || (a.originName || '').localeCompare(b.originName || ''));
    if (input.transporterName) {
      const t = input.transporterName.toLowerCase();
      filtered = filtered.filter((f: any) =>
        f.assignments?.some((a: any) =>
          (a.transportCompany?.name || '').toLowerCase().includes(t),
        ) ?? false,
      );
    }

    // Warn if results were truncated by the 100-record limit
    const truncated = result.total > 100;
    const truncationNote = truncated ? ` (mostrando 100 de ${result.total} fletes)` : '';

    if (filtered.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan con los filtros.' + truncationNote });
    }

    // Build flat freight records
    const freights = filtered.map((f: any) => {
      const assignment = f.assignments?.[0];
      return {
        code: f.code,
        status: FREIGHT_STATUS_LABELS[f.status] || f.status,
        statusRaw: f.status,
        grain: f.items?.[0]?.grain || 'N/A',
        tons: f.items?.[0]?.tons || 0,
        origin: (f as any).originName || f.originCompany?.name || 'N/A',
        destination: (f as any).destName || f.destCompany?.name || 'N/A',
        transporter: assignment?.transportCompany?.name || 'Sin asignar',
        driver: assignment?.driver?.name || null,
        truck: assignment?.truck?.plate || null,
        date: f.loadDate ? new Date(f.loadDate).toISOString().split('T')[0] : null,
      };
    });

    // Group if requested
    const groupBy = input.groupBy;
    if (groupBy) {
      const keyMap: Record<string, string> = {
        transporter: 'transporter', status: 'status', grain: 'grain',
        destination: 'destination', origin: 'origin',
      };
      const key = keyMap[groupBy] || 'status';
      const groups: Record<string, any[]> = {};
      for (const f of freights) {
        const gk = f[key] || 'Sin dato';
        if (!groups[gk]) groups[gk] = [];
        groups[gk].push(f);
      }

      const summary = Object.entries(groups).map(([group, items]) => ({
        group,
        count: items.length,
        totalTons: Math.round(items.reduce((s, f) => s + (f.tons || 0), 0) * 10) / 10,
        freights: items.map(f => ({
          code: f.code, status: f.status, grain: f.grain, tons: f.tons,
          origin: f.origin, destination: f.destination,
          ...(groupBy !== 'transporter' ? { transporter: f.transporter } : {}),
          driver: f.driver, truck: f.truck, date: f.date,
        })),
      }));

      return JSON.stringify({
        total: freights.length,
        totalInDB: truncated ? result.total : undefined,
        truncationNote: truncationNote || undefined,
        groupedBy: groupBy,
        groups: summary,
      });
    }

    // No grouping — return flat list
    return JSON.stringify({
      total: freights.length,
      totalInDB: truncated ? result.total : undefined,
      truncationNote: truncationNote || undefined,
      freights,
    });
  }

  // ---- update_freight ----
  private async toolUpdateFreight(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const changes: string[] = [];
    const dto: any = {};

    // --- loadDate / loadTime: solo en pending_assignment. notes: en cualquier estado activo ---
    if (input.loadDate || input.loadTime) {
      if (freight.status !== 'pending_assignment') {
        return JSON.stringify({ error: `Fecha y hora solo se pueden modificar en estado "pending_assignment". Estado actual: "${freight.status}".` });
      }
      if (input.loadDate) { dto.loadDate = input.loadDate; changes.push(`Fecha: ${input.loadDate}`); }
      if (input.loadTime) { dto.loadTime = input.loadTime; changes.push(`Hora: ${input.loadTime}`); }
    }
    if (input.notes !== undefined) {
      dto.notes = input.notes;
      changes.push(`Notas: ${input.notes}`);
    }

    // --- useOwnFleet: en pending_assignment, assigned, accepted ---
    if (input.useOwnFleet !== undefined) {
      const canEditFleet = ['pending_assignment', 'assigned', 'accepted'].includes(freight.status);
      if (!canEditFleet) {
        return JSON.stringify({ error: `Flota propia solo se puede modificar en estados: pending_assignment, assigned, accepted. Estado actual: "${freight.status}".` });
      }
      dto.useOwnFleet = input.useOwnFleet;
      changes.push(`Flota propia: ${input.useOwnFleet ? 'Sí' : 'No'}`);
    }

    // --- destPlantId: en todos los estados activos ---
    if (input.destPlantId) {
      const canEditDest = ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded'].includes(freight.status);
      if (!canEditDest) {
        return JSON.stringify({ error: `Planta destino solo se puede modificar en estados activos. Estado actual: "${freight.status}".` });
      }
      // search_plants returns Company IDs; backend accepts both Plant IDs and Company IDs
      let destLabel: string;
      const plant = await this.prisma.plant.findUnique({
        where: { id: input.destPlantId },
        select: { id: true, name: true, company: { select: { name: true } } },
      });
      if (plant) {
        destLabel = `${plant.company?.name || ''} - ${plant.name}`;
      } else {
        const company = await this.prisma.company.findUnique({
          where: { id: input.destPlantId },
          select: { id: true, name: true },
        });
        if (!company) {
          return JSON.stringify({ error: `No se encontró la planta con ID ${input.destPlantId}. Use search_plants primero.` });
        }
        destLabel = company.name;
      }
      dto.destPlantId = input.destPlantId;
      changes.push(`Planta destino: ${destLabel}`);
    }

    // --- truckId: solo con flota propia ---
    if (input.truckId) {
      const effectiveOwnFleet = dto.useOwnFleet !== undefined ? dto.useOwnFleet : freight.useOwnFleet;
      if (!effectiveOwnFleet) {
        return JSON.stringify({ error: 'Solo se puede asignar camión cuando el flete usa flota propia.' });
      }
      const userCompanyId = user.activeCompanyId || user.companyId;
      const truck = await this.prisma.truck.findFirst({
        where: { id: input.truckId, companyId: userCompanyId, active: true },
        select: { plate: true, model: true },
      });
      if (!truck) {
        return JSON.stringify({ error: 'No se encontró el camión o no pertenece a su empresa. Use list_trucks primero.' });
      }
      dto.truckId = input.truckId;
      changes.push(`Camión: ${truck.plate}${truck.model ? ` (${truck.model})` : ''}`);
    }

    // --- driverId: solo con flota propia ---
    if (input.driverId) {
      const effectiveOwnFleet = dto.useOwnFleet !== undefined ? dto.useOwnFleet : freight.useOwnFleet;
      if (!effectiveOwnFleet) {
        return JSON.stringify({ error: 'Solo se puede asignar chofer cuando el flete usa flota propia.' });
      }
      if (input.driverId === 'self') {
        dto.driverId = user.sub || user.id;
        changes.push('Chofer: Yo mismo');
      } else {
        const userCompanyIdForDriver = user.activeCompanyId || user.companyId;
        const driver = await this.prisma.userCompany.findFirst({
          where: { userId: input.driverId, companyId: userCompanyIdForDriver, active: true },
          include: { user: { select: { name: true } } },
        });
        if (!driver) {
          return JSON.stringify({ error: 'No se encontró el chofer en su empresa. Use list_drivers primero.' });
        }
        dto.driverId = input.driverId;
        changes.push(`Chofer: ${driver.user.name}`);
      }
    }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: loadDate, loadTime, notes, useOwnFleet, destPlantId, truckId, driverId.' });
    }

    return this.stageAction(session, 'update_freight', {
      freightId: freight.id, code: freight.code, dto,
    }, `Modificar flete ${freight.code}\n${changes.join('\n')}`, user);
  }

  // ---- duplicate_freight ----
  private async toolDuplicateFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });

    // Fetch full data needed for duplication (resolveFreightWithAccess only returns minimal select)
    const freight = await this.prisma.freight.findUnique({
      where: { id: result.freight.id },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        originLot: { select: { id: true, name: true } },
        destPlant: { select: { id: true, name: true } },
        assignments: { where: { status: { not: 'rejected' } }, take: 1, select: { truckId: true, driverId: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `No se encontró el flete ${input.code}` });

    const item = freight.items?.[0];
    if (!item) return JSON.stringify({ error: 'El flete no tiene items para duplicar.' });

    // Validate only the date — everything else is copied as-is
    const loadDate = input.loadDate;
    if (!loadDate || !/^\d{4}-\d{2}-\d{2}$/.test(loadDate)) {
      return JSON.stringify({ error: 'Debe indicar la fecha de carga (loadDate) en formato YYYY-MM-DD.' });
    }
    const parsedDate = new Date(loadDate + 'T12:00:00');
    if (isNaN(parsedDate.getTime())) {
      return JSON.stringify({ error: 'Fecha inválida.' });
    }

    const originName = (freight as any).originName || freight.originCompany?.name || 'Origen';
    const destName = (freight as any).destName || freight.destCompany?.name || 'Destino';
    const loadTime = input.loadTime || (freight as any).loadTime || null;
    const assignment = (freight as any).assignments?.[0];

    const summary = [
      `Duplicar flete ${freight.code} → nueva fecha ${loadDate.split('-').reverse().join('/')}${loadTime ? ` ${loadTime}` : ''}`,
      `${(item as any).grain} ${(item as any).tons}tn | ${originName} → ${destName}`,
    ].join('\n');

    return this.stageAction(session, 'duplicate_freight', {
      originalFreight: {
        grain: (item as any).grain,
        tons: (item as any).tons,
        originLotId: (freight as any).originLotId || null,
        customOriginName: (freight as any).originName || null,
        originLat: (freight as any).originLat ? Number((freight as any).originLat) : null,
        originLng: (freight as any).originLng ? Number((freight as any).originLng) : null,
        destPlantId: (freight as any).destPlantId || null,
        destCompanyId: freight.destCompany?.id || null,
        customDestName: (freight as any).destName || null,
        destLat: (freight as any).destLat ? Number((freight as any).destLat) : null,
        destLng: (freight as any).destLng ? Number((freight as any).destLng) : null,
        notes: (freight as any).notes || null,
        truckCount: (freight as any).truckCount || 1,
        truckId: assignment?.truckId || null,
        driverId: assignment?.driverId || null,
      },
      loadDate,
      loadTime,
      originalCode: freight.code,
    }, summary);
  }

  // ---- list_documents ----
  private async toolListDocuments(input: any, user: any): Promise<string> {
    // Use resolveFreightWithAccess for proper access control (includes transporters + drivers)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });

    const freight = await this.prisma.freight.findUnique({
      where: { id: accessResult.freight.id },
      include: {
        documents: { orderBy: { createdAt: 'desc' }, select: { id: true, name: true, type: true, step: true, url: true, createdAt: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `No se encontró el flete ${input.code}` });

    const docs = freight.documents || [];
    if (docs.length === 0) {
      return JSON.stringify({ total: 0, message: `El flete ${input.code} no tiene documentos adjuntos.` });
    }

    const STEP_LABELS: Record<string, string> = {
      request: 'Solicitud', assignment: 'Asignación', load_confirmation: 'Carga',
      delivery_confirmation: 'Entrega', cancellation: 'Cancelación',
    };

    const items = docs.map((d: any) => ({
      name: d.name,
      type: d.type,
      step: STEP_LABELS[d.step] || d.step || 'General',
      date: new Date(d.createdAt).toISOString().split('T')[0],
    }));

    return JSON.stringify({ total: items.length, code: input.code, documents: items });
  }

  // ---- freight_history ----
  private async toolFreightHistory(input: any, user: any): Promise<string> {
    // Use resolveFreightWithAccess for proper access control (includes transporters + drivers)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });
    const freight = accessResult.freight;

    const logs = await this.freights.getAuditLog(freight.id);

    if (!logs || (logs as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: `No hay registros de actividad para ${freight.code}.` });
    }

    const ACTION_LABELS: Record<string, string> = {
      created: 'Creado', status_changed: 'Cambio de estado', assigned: 'Asignado',
      canceled: 'Cancelado', updated: 'Modificado', document_added: 'Documento adjuntado',
      driver_assigned: 'Chofer asignado', truck_assigned: 'Camión asignado',
    };

    const events = (logs as any[]).map((log: any) => ({
      action: ACTION_LABELS[log.action] || log.action,
      from: log.fromValue || null,
      to: log.toValue || null,
      reason: log.reason || null,
      user: log.user?.name || 'Sistema',
      company: log.user?.company?.name || null,
      date: new Date(log.createdAt).toISOString().replace('T', ' ').slice(0, 16),
    }));

    return JSON.stringify({ total: events.length, code: freight.code, events });
  }

  // ---- get_dashboard ----
  private async toolGetDashboard(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });

    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allCompanies = [companyId, ...memberCompanyIds].filter(Boolean);

    const where: any = {
      OR: [
        { originCompanyId: { in: allCompanies } },
        { destCompanyId: { in: allCompanies } },
        { assignments: { some: { transportCompanyId: { in: allCompanies }, status: { in: ['active', 'accepted'] } } } },
      ],
    };

    // Current month boundaries
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const [byStatus, monthFreights] = await Promise.all([
      // All freights grouped by status
      this.prisma.freight.groupBy({ by: ['status'], where, _count: true }),
      // This month's freights with items for tonnage
      this.prisma.freight.findMany({
        where: { ...where, createdAt: { gte: monthStart, lte: monthEnd } },
        select: { id: true, status: true, items: { select: { tons: true } } },
      }),
    ]);

    const statusSummary = byStatus.map((s: any) => ({
      status: FREIGHT_STATUS_LABELS[s.status] || s.status,
      count: s._count,
    }));

    const totalActive = byStatus
      .filter((s: any) => !['finished', 'canceled', 'rejected'].includes(s.status))
      .reduce((sum: number, s: any) => sum + s._count, 0);

    const monthTons = monthFreights.reduce((sum: number, f: any) =>
      sum + (f.items || []).reduce((s: number, i: any) => s + (Number(i.tons) || 0), 0), 0);
    const monthCompleted = monthFreights.filter((f: any) => f.status === 'finished').length;
    const monthCancelled = monthFreights.filter((f: any) => f.status === 'canceled').length;

    return JSON.stringify({
      activeFreights: totalActive,
      byStatus: statusSummary,
      month: {
        name: now.toLocaleString('es', { month: 'long', year: 'numeric' }),
        totalFreights: monthFreights.length,
        totalTons: Math.round(monthTons * 10) / 10,
        completed: monthCompleted,
        canceled: monthCancelled,
      },
    });
  }

  // ---- update_field ----
  private async toolUpdateField(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });

    const field = await this.prisma.field.findFirst({
      where: {
        companyId: producerCompanyId,
        active: true,
        name: { contains: input.fieldName, mode: 'insensitive' },
      },
    });
    if (!field) return JSON.stringify({ error: `No se encontró el campo "${input.fieldName}".` });

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (lat == null || lng == null) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        if (lat == null) lat = st.lastLocation.lat;
        if (lng == null) lng = st.lastLocation.lng;
      }
    }

    const changes: string[] = [];
    const dto: any = {};
    if (input.address) { dto.address = input.address; changes.push(`Dirección: ${input.address}`); }
    if (lat != null) { dto.lat = lat; changes.push(`Latitud: ${lat}`); }
    if (lng != null) { dto.lng = lng; changes.push(`Longitud: ${lng}`); }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: address, lat, lng.' });
    }

    return this.stageAction(session, 'update_field', {
      fieldId: field.id, fieldName: field.name, dto, producerCompanyId,
    }, `Modificar campo "${field.name}"\n${changes.join('\n')}`, user);
  }

  // ---- update_lot ----
  private async toolUpdateLot(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });

    const lot = await this.prisma.lot.findFirst({
      where: {
        companyId: producerCompanyId,
        active: true,
        name: { contains: input.lotName, mode: 'insensitive' },
      },
      include: { field: { select: { id: true, name: true } } },
    });
    if (!lot) return JSON.stringify({ error: `No se encontró el lote "${input.lotName}".` });

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (lat == null || lng == null) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        if (lat == null) lat = st.lastLocation.lat;
        if (lng == null) lng = st.lastLocation.lng;
      }
    }

    const changes: string[] = [];
    const dto: any = {};
    if (input.hectares) { dto.hectares = input.hectares; changes.push(`Hectáreas: ${input.hectares}`); }
    if (lat != null) { dto.lat = lat; changes.push(`Latitud: ${lat}`); }
    if (lng != null) { dto.lng = lng; changes.push(`Longitud: ${lng}`); }

    if (changes.length === 0) {
      return JSON.stringify({ error: 'No se indicaron campos a modificar. Puede cambiar: hectares, lat, lng.' });
    }

    return this.stageAction(session, 'update_lot', {
      fieldId: lot.field.id, lotId: lot.id, lotName: lot.name, fieldName: lot.field.name, dto, producerCompanyId,
    }, `Modificar lote "${lot.name}" (campo "${lot.field.name}")\n${changes.join('\n')}`, user);
  }

  // ---- reactivate_user ----
  private async toolReactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden reactivar usuarios.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: false,
        user: {
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario inactivo "${searchTerm}" en su empresa.` });
    }

    return this.stageAction(session, 'reactivate_user', {
      membershipId: membership.id,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Reactivar usuario "${membership.user.name}" en su empresa`, user);
  }

  // ---- Helper: store _pendingSelection for interactive list ----
  // Accumulates in _chatSideEffects (merged by chat()) to avoid DB race conditions
  private storePendingSelection(
    session: any,
    items: { id: string; title: string; description?: string }[],
    config: { headerText: string; listButtonLabel: string; sectionTitle: string },
    purpose: string,
    extraJson?: Record<string, any>,
  ): string {
    const effects = this._chatSideEffects.get(session.id) || {};
    effects._pendingSelection = { items, config, purpose };
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(session.id, effects);
    return JSON.stringify({
      total: items.length,
      message: `Se presento lista interactiva de ${items.length} elemento(s). Espere a que seleccione uno.`,
      _selectionSent: true,
      ...extraJson,
    });
  }

  // ---- get_freight_detail ----
  private async toolGetFreightDetail(input: any, user: any, session?: any): Promise<string> {
    // Use resolveFreightWithAccess for unified access control (includes driver check)
    const accessResult = await this.resolveFreightWithAccess(input.code, user);
    if (accessResult.error) return JSON.stringify({ error: accessResult.error });

    // Fetch full detail data
    const freight = await this.prisma.freight.findUnique({
      where: { id: accessResult.freight.id },
      include: {
        items: true,
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { name: true } },
            truck: { select: { plate: true } },
          },
        },
      },
    });

    if (!freight) {
      return JSON.stringify({ error: `No se encontró el flete ${input.code}` });
    }

    // M1: Determine if user is only a transporter/driver (not origin/dest company)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const isOriginOrDest = allUserCompanies.some(c =>
      c === freight.originCompanyId || c === freight.destCompanyId);

    const assignment = freight.assignments[0];
    const originName = (freight as any).originName || freight.originCompany?.name || 'N/A';
    const destName = (freight as any).destName || freight.destCompany?.name || 'N/A';
    const oLat = (freight as any).originLat != null ? Number((freight as any).originLat) : null;
    const oLng = (freight as any).originLng != null ? Number((freight as any).originLng) : null;
    const dLat = (freight as any).destLat != null ? Number((freight as any).destLat) : null;
    const dLng = (freight as any).destLng != null ? Number((freight as any).destLng) : null;

    // Build map link if coordinates available and finite
    let mapLink: string | null = null;
    if (oLat != null && oLng != null && isFinite(oLat) && isFinite(oLng)) {
      const p = new URLSearchParams();
      p.set('lat', oLat.toFixed(6)); p.set('lng', oLng.toFixed(6)); p.set('n', originName.slice(0, 60));
      if (dLat != null && dLng != null && isFinite(dLat) && isFinite(dLng)) { p.set('dlat', dLat.toFixed(6)); p.set('dlng', dLng.toFixed(6)); p.set('dn', destName.slice(0, 60)); }
      mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
    }

    // Save active context so it survives message trimming
    const grain = freight.items[0]?.grain || '';
    const tons = freight.items[0]?.tons || '';
    if (session?.id) {
      this.updateActiveContext(session.id, {
        lastFreightId: freight.id,
        lastFreightCode: freight.code,
        lastFreightSummary: `${grain} ${tons}tn, ${originName} → ${destName}, ${freight.status}`,
      });
    }

    return JSON.stringify({
      code: freight.code,
      status: freight.status,
      items: freight.items.map((i: any) => ({ grain: i.grain, tons: i.tons })),
      origin: originName,
      dest: destName,
      date: freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : null,
      time: (freight as any).loadTime || null,
      transporter: assignment?.transportCompany?.name || 'Sin asignar',
      driver: assignment?.driver?.name || null,
      truck: assignment?.truck?.plate || null,
      // Include all assignments for multi-truck freights
      assignments: freight.assignments.length > 1
        ? freight.assignments.map((a: any) => ({
            transporter: a.transportCompany?.name || null,
            driver: a.driver?.name || null,
            truck: a.truck?.plate || null,
            tripStatus: a.tripStatus || null,
          }))
        : undefined,
      // Hide internal notes from pure transporters/drivers
      notes: isOriginOrDest ? ((freight as any).notes || null) : null,
      link: `${APP_URL}/freight/${freight.id}`,
      mapLink,
    });
  }

  // ---- search_plants ----
  private async toolSearchPlants(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', plants: [] });
    }

    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      select: { plantCompanyId: true },
      take: 500,
    });

    const plantCompanyIds = [...new Set(accessRecords.map(ar => ar.plantCompanyId))];
    if (plantCompanyIds.length === 0) {
      return JSON.stringify({ plants: [], message: 'No tiene plantas habilitadas' });
    }

    const companies = await this.prisma.company.findMany({
      where: { id: { in: plantCompanyIds }, active: true },
      select: {
        id: true, name: true,
        plants: { where: { active: true }, select: { id: true, name: true } },
      },
      take: 50,
    });

    let filtered = companies;
    let matchType: string | undefined;
    if (input.query) {
      const fuzzyResults = fuzzySearch(input.query, companies, (c) => c.name, { threshold: 0.55, maxResults: 10 });
      matchType = classifyFuzzyResult(fuzzyResults);
      filtered = fuzzyResults.map(r => r.item) as any;
    }

    if (filtered.length === 0) {
      return JSON.stringify({ plants: [], message: 'No se encontraron plantas' });
    }

    // If exact/confident match on a single plant, return data directly for AI to use
    if (matchType === 'exact' || (matchType === 'confident' && filtered.length === 1)) {
      const c = filtered[0];
      return JSON.stringify({
        plants: [{ companyId: c.id, companyName: c.name, branches: (c as any).plants.map((b: any) => ({ id: b.id, name: b.name })) }],
        matchType,
      });
    }

    const items = filtered.map((c: any) => ({
      id: `plant:${c.id}`,
      title: c.name.slice(0, 24),
      description: `${c.plants?.length || 0} sucursal${c.plants?.length !== 1 ? 'es' : ''}`.slice(0, 72),
    }));

    // Include branch data in extraJson so AI has it for follow-up
    const plantsData = filtered.map((c: any) => ({
      companyId: c.id, companyName: c.name,
      branches: c.plants.map((b: any) => ({ id: b.id, name: b.name })),
    }));

    return this.storePendingSelection(session, items, {
      headerText: '🏢 Plantas disponibles.\nSeleccione una:',
      listButtonLabel: 'Ver plantas',
      sectionTitle: 'PLANTAS',
    }, 'plant_info', { plants: plantsData, matchType });
  }

  // ---- list_lots ----
  private async toolListLots(user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', lots: [] });
    }

    const lots = await this.prisma.lot.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { field: { select: { id: true, name: true, lat: true, lng: true } } },
      take: 100,
    });

    if (lots.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay lotes registrados.' });
    }

    const items = lots.map((l: any) => ({
      id: `lot:${l.id}`,
      title: (l.name || 'Sin nombre').slice(0, 24),
      description: (l.field?.name || 'Sin campo').slice(0, 72),
    }));

    // Include lot data with mapLink instead of raw coords
    const lotsData = lots.map((l: any) => {
      const lLat = l.lat != null ? Number(l.lat) : (l.field?.lat != null ? Number(l.field.lat) : null);
      const lLng = l.lng != null ? Number(l.lng) : (l.field?.lng != null ? Number(l.field.lng) : null);
      let mapLink: string | null = null;
      if (lLat != null && lLng != null) {
        const p = new URLSearchParams();
        p.set('lat', lLat.toFixed(6)); p.set('lng', lLng.toFixed(6)); p.set('n', (l.name || 'Lote').slice(0, 60));
        mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
      }
      return { id: l.id, name: l.name, fieldName: l.field?.name || null, mapLink };
    });

    return this.storePendingSelection(session, items, {
      headerText: '🗺️ Lotes registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver lotes',
      sectionTitle: 'LOTES',
    }, 'lot_info', { lots: lotsData });
  }

  // ---- prepare_freight ----
  private async toolPrepareFreight(input: any, user: any, session: any): Promise<string> {
    // Input validation
    if (!input.grain || typeof input.grain !== 'string') {
      return JSON.stringify({ error: 'Falta el tipo de grano (grain).' });
    }
    if (!input.tons || isNaN(Number(input.tons)) || Number(input.tons) <= 0) {
      return JSON.stringify({ error: 'Falta la cantidad de toneladas (tons) o es inválida.' });
    }
    if (!input.loadDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.loadDate)) {
      return JSON.stringify({ error: 'Falta la fecha de carga (loadDate) o formato inválido. Usa YYYY-MM-DD.' });
    }
    if (!input.loadTime || !/^\d{2}:\d{2}$/.test(input.loadTime)) {
      return JSON.stringify({ error: 'Falta la hora de carga (loadTime) o formato inválido. Usa HH:MM.' });
    }
    if (input.truckCount !== undefined && (isNaN(Number(input.truckCount)) || Number(input.truckCount) < 1)) {
      return JSON.stringify({ error: 'truckCount debe ser un número >= 1.' });
    }

    const producerCompanyId = this.resolveProducerCompanyId(user);

    // ── AUTO-RESOLVE: destination name → plant ID ──
    if (!input.destPlantId && input.destName) {
      if (producerCompanyId) {
        const accesses = await this.prisma.plantProducerAccess.findMany({
          where: { producerCompanyId, active: true },
          select: { plantCompanyId: true },
        });
        const plantCompanyIds = [...new Set(accesses.map(a => a.plantCompanyId))];
        if (plantCompanyIds.length > 0) {
          const companies = await this.prisma.company.findMany({
            where: { id: { in: plantCompanyIds }, active: true },
            select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } },
          });
          const results = fuzzySearch(input.destName, companies, (c) => c.name, { threshold: 0.45, maxResults: 5 });
          if (results.length === 1 || classifyFuzzyResult(results) === 'exact') {
            input.destPlantId = results[0].item.id;
            input.destName = undefined; // clear — resolved to ID
          } else if (results.length > 1) {
            return JSON.stringify({
              error: `Múltiples plantas coinciden con "${input.destName}": ${results.map(r => r.item.name).join(', ')}. Indique cuál exactamente.`,
              suggestions: results.map(r => ({ id: r.item.id, name: r.item.name })),
            });
          }
        }
      }
    }

    // ── AUTO-RESOLVE: origin name → lot ID ──
    if (!input.originLotId && input.originName && producerCompanyId) {
      // Search lots first (more specific), then fields
      const lots = await this.prisma.lot.findMany({
        where: { companyId: producerCompanyId, active: true },
        select: { id: true, name: true, field: { select: { id: true, name: true } } },
        take: 200,
      });
      // Try matching against "field - lot" combined name and lot name alone
      const lotsWithLabel = lots.map(l => ({ ...l, label: l.field?.name ? `${l.field.name} - ${l.name}` : l.name }));
      const lotResults = fuzzySearch(input.originName, lotsWithLabel, (l) => l.label, { threshold: 0.45, maxResults: 5 });
      if (lotResults.length === 0) {
        // Try matching against just lot name
        const lotResults2 = fuzzySearch(input.originName, lotsWithLabel, (l) => l.name, { threshold: 0.45, maxResults: 5 });
        if (lotResults2.length === 1 || classifyFuzzyResult(lotResults2) === 'exact') {
          input.originLotId = lotResults2[0].item.id;
          input.originName = undefined;
        } else if (lotResults2.length > 1) {
          return JSON.stringify({
            error: `Múltiples lotes coinciden con "${input.originName}": ${lotResults2.map(r => `${r.item.field?.name || ''} - ${r.item.name}`).join(', ')}. Indique cuál exactamente.`,
            suggestions: lotResults2.map(r => ({ id: r.item.id, name: r.item.label || r.item.name })),
          });
        }
        // If still no match, try field names — use first lot of matched field
        if (!input.originLotId) {
          const fields = await this.prisma.field.findMany({
            where: { companyId: producerCompanyId, active: true },
            select: { id: true, name: true, lots: { where: { active: true }, select: { id: true, name: true }, take: 1 } },
            take: 100,
          });
          const fieldResults = fuzzySearch(input.originName, fields, (f) => f.name, { threshold: 0.45, maxResults: 5 });
          if (fieldResults.length === 1 || classifyFuzzyResult(fieldResults) === 'exact') {
            const matchedField = fieldResults[0].item;
            if (matchedField.lots?.[0]) {
              input.originLotId = matchedField.lots[0].id;
              input.originName = undefined;
            } else {
              return JSON.stringify({ error: `El campo "${matchedField.name}" no tiene lotes activos. Cree un lote primero con create_lot.` });
            }
          } else if (fieldResults.length > 1) {
            return JSON.stringify({
              error: `Múltiples campos coinciden con "${input.originName}": ${fieldResults.map(r => r.item.name).join(', ')}. Indique cuál exactamente.`,
              suggestions: fieldResults.map(r => ({ id: r.item.id, name: r.item.name })),
            });
          }
        }
      } else if (lotResults.length === 1 || classifyFuzzyResult(lotResults) === 'exact') {
        input.originLotId = lotResults[0].item.id;
        input.originName = undefined;
      } else {
        return JSON.stringify({
          error: `Múltiples lotes coinciden con "${input.originName}": ${lotResults.map(r => r.item.label).join(', ')}. Indique cuál exactamente.`,
          suggestions: lotResults.map(r => ({ id: r.item.id, name: r.item.label })),
        });
      }
      // If originName couldn't be resolved, treat as custom origin
      if (!input.originLotId && input.originName) {
        input.customOriginName = input.originName;
      }
    }

    // ── BRANCH VALIDATION: require branchId if plant has branches ──
    if (input.destPlantId && !input.branchId) {
      const company = await this.prisma.company.findUnique({
        where: { id: input.destPlantId },
        select: { name: true, plants: { where: { active: true }, select: { id: true, name: true }, take: 20 } },
      });
      if (company?.plants && company.plants.length > 0) {
        return JSON.stringify({
          error: `La planta "${company.name}" tiene ${company.plants.length} sucursal(es). Debe indicar branchId.`,
          branches: company.plants.map(b => ({ id: b.id, name: b.name })),
          IMPORTANT: 'Preguntar al usuario cuál sucursal. Si hay una sola, sugerirla directamente.',
        });
      }
    }

    // ── OWN FLEET: require driverId if truckId is set ──
    if (input.truckId && !input.driverId) {
      return JSON.stringify({
        error: 'Si asigna flota propia (truckId), debe indicar el chofer (driverId). Use "self" si el usuario es el chofer, o list_drivers para obtener choferes disponibles.',
      });
    }

    // Resolve driverId "self" → user.id
    if (input.driverId === 'self') {
      input.driverId = user.id;
    }

    // Fallback to lastLocation from WhatsApp — only fill the field that needs it (not both)
    const needsDestLoc = !input.destPlantId && (input.destName || input.customOriginName) && (input.customDestLat == null || input.customDestLng == null);
    const needsOriginLoc = !input.originLotId && input.customOriginName && (input.customOriginLat == null || input.customOriginLng == null);
    if (needsDestLoc || needsOriginLoc) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        if (needsDestLoc) {
          if (input.customDestLat == null) input.customDestLat = st.lastLocation.lat;
          if (input.customDestLng == null) input.customDestLng = st.lastLocation.lng;
        } else if (needsOriginLoc) {
          if (input.customOriginLat == null) input.customOriginLat = st.lastLocation.lat;
          if (input.customOriginLng == null) input.customOriginLng = st.lastLocation.lng;
        }
      }
    }

    // Custom destination requires location
    if (!input.destPlantId && input.destName && (input.customDestLat == null || input.customDestLng == null)) {
      return JSON.stringify({
        error: 'Para destino personalizado, la ubicación es obligatoria. Use generate_location_link con purpose "destination" para generar el enlace.',
      });
    }
    // Custom origin requires location
    if (!input.originLotId && input.customOriginName && (input.customOriginLat == null || input.customOriginLng == null)) {
      return JSON.stringify({
        error: 'Para origen personalizado, la ubicación es obligatoria. Use generate_location_link con purpose "origin" para generar el enlace.',
      });
    }

    // Resolve display names
    let destDisplayName = input.destName || 'Sin destino';
    if (input.destPlantId) {
      const plant = await this.prisma.plant.findUnique({
        where: { id: input.destPlantId },
        select: { name: true, company: { select: { name: true } } },
      });
      if (plant) {
        destDisplayName = `${plant.company?.name || ''} - ${plant.name}`;
      } else {
        const company = await this.prisma.company.findUnique({
          where: { id: input.destPlantId },
          select: { name: true },
        });
        destDisplayName = company?.name || destDisplayName;
      }
    }
    // Append branch name if selected
    if (input.branchId) {
      const branch = await this.prisma.plant.findUnique({ where: { id: input.branchId }, select: { name: true } });
      if (branch) destDisplayName += ` (${branch.name})`;
    }

    let originDisplayName = input.customOriginName || 'Sin origen';
    if (input.originLotId) {
      const lot = await this.prisma.lot.findUnique({
        where: { id: input.originLotId },
        select: { name: true, field: { select: { name: true } } },
      });
      if (lot) originDisplayName = lot.field?.name ? `${lot.field.name} - ${lot.name}` : lot.name;
    }

    // Resolve truck + driver display if own fleet
    let truckDisplay: string | null = null;
    let driverDisplay: string | null = null;
    if (input.truckId) {
      const truckOwnerCompany = user.activeCompanyId || user.companyId;
      const truck = await this.prisma.truck.findFirst({
        where: { id: input.truckId, companyId: truckOwnerCompany, active: true },
        select: { plate: true, model: true },
      });
      if (truck) truckDisplay = truck.model ? `${truck.plate} (${truck.model})` : truck.plate;
    }
    if (input.driverId) {
      if (input.driverId === user.id) {
        driverDisplay = user.name || 'Yo';
      } else {
        const driver = await this.prisma.user.findUnique({ where: { id: input.driverId }, select: { name: true } });
        driverDisplay = driver?.name || null;
      }
    }

    // Auto-calculate truck count: ~30 tn per truck (standard grain transport)
    const tons = Number(input.tons);
    const autoTruckCount = Math.max(1, Math.ceil(tons / 30));
    const truckCount = input.truckCount || autoTruckCount;

    const dateFormatted = input.loadDate.split('-').reverse().join('/');
    const summary: any = {
      grain: input.grain,
      tons: input.tons,
      truckCount,
      origin: originDisplayName,
      dest: destDisplayName,
      date: dateFormatted,
      time: input.loadTime,
      notes: input.notes || null,
    };
    if (truckDisplay) summary.truck = truckDisplay;
    if (driverDisplay) summary.driver = driverDisplay;

    // Use side-effects pattern (merged by chat()) — avoids direct DB write race
    const effects = this._chatSideEffects.get(session.id) || {};
    effects.pendingFreight = { ...input, truckCount };
    effects._pendingButtons = [
      { id: 'ai_confirm_freight', title: 'CONFIRMAR' },
      { id: 'ai_cancel_freight', title: 'CANCELAR' },
    ];
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(session.id, effects);

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'El flete NO fue creado todavía. Mostrá el resumen y pregunta al usuario si confirma. Se enviarán botones CONFIRMAR/CANCELAR automáticamente.',
    });
  }

  // ---- confirm_create_freight ----
  private async toolConfirmCreateFreight(user: any, synUser: any, session: any): Promise<string> {
    // Atomic consume: capture old state via CTE, then clear pendingFreight.
    // Prevents double-creation from concurrent requests.
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH old AS (
        SELECT "id", "flow_state"
        FROM "whatsapp_sessions"
        WHERE "id" = ${session.id}
          AND "flow_state" ? 'pendingFreight'
        FOR UPDATE
      )
      UPDATE "whatsapp_sessions" s
      SET "flow_state" = s."flow_state" #- '{pendingFreight}'
      FROM old
      WHERE s."id" = old."id"
      RETURNING old."flow_state" AS "old_state"
    `;

    if (!rows.length) {
      return JSON.stringify({ error: 'No hay un flete pendiente de confirmación. Primero usa prepare_freight.' });
    }

    const oldState = rows[0].old_state || {};
    const pending = oldState.pendingFreight;

    this.logger.log(`confirm_create_freight — pendingFreight: ${pending ? JSON.stringify(pending).slice(0, 200) : 'NULL'}`);

    if (!pending) {
      return JSON.stringify({ error: 'No hay un flete pendiente de confirmación. Primero usa prepare_freight.' });
    }

    // Use the company selected in the WhatsApp session (if available) to ensure
    // the freight is created for the same company the user confirmed in WhatsApp.
    // This prevents desync when the user switches companies in WhatsApp but the
    // app still shows a different activeCompanyId.
    const sessionCompanyId = oldState.selectedCompanyId || user.activeCompanyId;
    const producerCompanyId = sessionCompanyId
      ? this.resolveProducerCompanyIdForCompany(user, sessionCompanyId)
      : this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No se encontró una empresa productora asociada a su usuario. Verifique con su administrador.' });
    }
    const producerSynUser = {
      ...synUser,
      companyId: producerCompanyId,
      companyType: 'producer',
      userType: 'producer',
    };

    const dto: any = {
      items: [{ grain: pending.grain, tons: pending.tons }],
      loadDate: pending.loadDate,
      loadTime: pending.loadTime,
      truckCount: pending.truckCount || 1,
      notes: pending.notes,
    };

    // branchId is the actual Plant entity ID (sucursal); destPlantId may be a Company ID
    if (pending.branchId) {
      dto.destPlantId = pending.branchId;
      // Also pass company-level destPlantId for participant resolution
      if (pending.destPlantId) dto.destCompanyId = pending.destPlantId;
    } else if (pending.destPlantId) {
      dto.destPlantId = pending.destPlantId;
    } else if (pending.destName) {
      dto.customDestName = pending.destName;
    }

    if (pending.originLotId) {
      dto.originLotId = pending.originLotId;
      // Lookup lot coordinates (fallback to field) so origin location is populated
      const lot = await this.prisma.lot.findUnique({
        where: { id: pending.originLotId },
        select: { lat: true, lng: true, field: { select: { lat: true, lng: true } } },
      });
      if (lot) {
        // Use != null checks (Decimal 0 is falsy in JS but may be a valid-ish value)
        // Also skip 0,0 which means "no real coordinates"
        const lotLat = lot.lat != null && Number(lot.lat) !== 0 ? Number(lot.lat) : null;
        const lotLng = lot.lng != null && Number(lot.lng) !== 0 ? Number(lot.lng) : null;
        const fieldLat = lot.field?.lat != null && Number(lot.field.lat) !== 0 ? Number(lot.field.lat) : null;
        const fieldLng = lot.field?.lng != null && Number(lot.field.lng) !== 0 ? Number(lot.field.lng) : null;
        const lat = lotLat ?? fieldLat;
        const lng = lotLng ?? fieldLng;
        this.logger.log(`Lot coords: lot(${lot.lat},${lot.lng}) field(${lot.field?.lat},${lot.field?.lng}) → resolved(${lat},${lng})`);
        if (lat != null && lng != null) {
          dto.overrideOriginLat = lat;
          dto.overrideOriginLng = lng;
        }
      }
    }
    // If no lot or lot had no coords, use custom origin
    if (!pending.originLotId || !dto.overrideOriginLat) {
      if (!pending.originLotId) {
        dto.customOriginName = pending.customOriginName || 'Origen WhatsApp';
      }
      if (pending.customOriginLat != null && pending.customOriginLng != null) {
        dto.overrideOriginLat = pending.customOriginLat;
        dto.overrideOriginLng = pending.customOriginLng;
      } else if (!dto.overrideOriginLat) {
        // No coordinates available — leave as null, freight service handles it
      }
    }

    // Destination coordinates from WhatsApp location
    if (pending.customDestLat != null && pending.customDestLng != null) {
      dto.overrideDestLat = pending.customDestLat;
      dto.overrideDestLng = pending.customDestLng;
    }

    // Own fleet truck + driver assignment
    if (pending.truckId) {
      dto.truckId = pending.truckId;
    }
    if (pending.driverId) {
      dto.driverId = pending.driverId;
    }

    this.logger.log(`Creating freight with DTO: ${JSON.stringify(dto).slice(0, 300)}`);
    const freight = await this.freights.create(dto, producerSynUser);
    this.logger.log(`Freight created: ${(freight as any).code}`);

    // pendingFreight already cleared atomically by the CTE above

    return JSON.stringify({
      status: 'created',
      code: (freight as any).code,
      link: `${APP_URL}/freight/${(freight as any).id}`,
    });
  }

  // ---- confirm_action (generic dispatcher) ----
  private async toolConfirmAction(user: any, synUser: any, session: any): Promise<string> {
    // Atomic consume: capture old state via CTE, then clear pendingAction.
    // Only one concurrent request can succeed (WHERE checks pendingAction exists).
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH old AS (
        SELECT "id", "flow_state"
        FROM "whatsapp_sessions"
        WHERE "id" = ${session.id}
          AND "flow_state" ? 'pendingAction'
        FOR UPDATE
      )
      UPDATE "whatsapp_sessions" s
      SET "flow_state" = s."flow_state" #- '{pendingAction}' #- '{_pendingButtons}'
      FROM old
      WHERE s."id" = old."id"
      RETURNING old."flow_state" AS "old_state"
    `;

    if (!rows.length) {
      return JSON.stringify({ error: 'No hay una acción pendiente de confirmación.' });
    }

    // Read pendingAction from the pre-update state captured by the CTE
    const oldState = rows[0].old_state || {};
    const pending = oldState.pendingAction;

    if (!pending) {
      return JSON.stringify({ error: 'No hay una acción pendiente de confirmación.' });
    }

    // TTL: reject actions older than 5 minutes
    const ACTION_TTL_MS = 5 * 60_000;
    if (pending.createdAt && Date.now() - pending.createdAt > ACTION_TTL_MS) {
      return JSON.stringify({ error: 'La acción pendiente expiró. Por favor, vuelva a solicitarla.' });
    }

    // Company mismatch: reject if user switched company after staging
    const currentCompanyId = user.activeCompanyId || user.companyId;
    if (pending.stagedCompanyId && pending.stagedCompanyId !== currentCompanyId) {
      return JSON.stringify({ error: 'Su empresa activa cambió desde que se preparó esta acción. Por favor, vuelva a solicitarla.' });
    }

    const preExecState = { ...oldState };
    delete preExecState.pendingAction;
    delete preExecState._pendingButtons;
    const { tool, params } = pending;
    this.logger.log(`confirm_action — dispatching: ${tool}`);

    let result: string;

    try {
      switch (tool) {
        case 'accept_freight':
          await this.freights.respond(params.freightId, { action: 'accepted' } as any, synUser);
          result = JSON.stringify({ status: 'accepted', code: params.code });
          break;

        case 'reject_freight':
          await this.freights.respond(params.freightId, { action: 'rejected', reason: params.reason } as any, synUser);
          result = JSON.stringify({ status: 'rejected', code: params.code });
          break;

        case 'start_freight':
          await this.freights.start(params.freightId, synUser);
          result = JSON.stringify({ status: 'started', code: params.code });
          // Fire-and-forget: send tracking links + GPS request to driver
          this.sendPostStartTrackingMessages(params.freightId, params.code, user).catch(err =>
            this.logger.error(`Post-start tracking failed for ${params.code}: ${err.message}`),
          );
          break;

        case 'confirm_loaded': {
          const cTons = params.tons != null ? Number(params.tons) : undefined;
          if (cTons !== undefined && (!isFinite(cTons) || cTons <= 0 || cTons > 200)) {
            result = JSON.stringify({ error: 'Toneladas inválidas (debe ser entre 0 y 200).' });
            break;
          }
          await this.freights.confirmLoaded(params.freightId, synUser, cTons);
          result = JSON.stringify({ status: 'loaded', code: params.code, tons: cTons });
          break;
        }

        case 'confirm_finished':
          await this.freights.confirmFinished(params.freightId, synUser);
          result = JSON.stringify({ status: 'finished', code: params.code });
          break;

        case 'cancel_freight':
          await this.freights.cancel(params.freightId, { reason: params.reason } as any, synUser);
          result = JSON.stringify({ status: 'canceled', code: params.code });
          break;

        case 'assign_transporter': {
          if (!this.canAccessCompany(user, synUser, params.plantCompanyId)) {
            result = JSON.stringify({ error: 'No tiene acceso a la empresa para esta acción.' });
            break;
          }
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          // Set own fleet flag if deferred from staging
          if (params.setOwnFleet) {
            await this.prisma.freight.update({ where: { id: params.freightId }, data: { useOwnFleet: true } as any });
          }
          const dto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) dto.truckId = params.truckId;
          if (params.driverId) dto.driverId = params.driverId;
          // Multi-truck freights must use assignTruck() — assign() rejects them
          const frCheck = await this.prisma.freight.findUnique({ where: { id: params.freightId }, select: { isMultiTruck: true } });
          if (frCheck?.isMultiTruck) {
            await this.freights.assignTruck(params.freightId, dto, plantSyn);
          } else {
            await this.freights.assign(params.freightId, dto, plantSyn);
          }
          result = JSON.stringify({ status: 'done', code: params.code, transporter: params.transporterName });
          break;
        }

        case 'assign_truck_to_trip': {
          if (!this.canAccessCompany(user, synUser, params.plantCompanyId)) {
            result = JSON.stringify({ error: 'No tiene acceso a la empresa para esta acción.' });
            break;
          }
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const dto: any = { truckId: params.truckId };
          if (params.driverId) dto.driverId = params.driverId;
          await this.freights.updateAssignment(params.freightId, params.assignmentId, dto, plantSyn);
          result = JSON.stringify({ status: 'done', code: params.code, truck: params.truckDisplay });
          break;
        }

        case 'assign_truck_to_freight': {
          if (!this.canAccessCompany(user, synUser, params.plantCompanyId)) {
            result = JSON.stringify({ error: 'No tiene acceso a la empresa para esta acción.' });
            break;
          }
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const truckDto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) truckDto.truckId = params.truckId;
          if (params.driverId) truckDto.driverId = params.driverId;
          if (params.tons) truckDto.tons = params.tons;
          await this.freights.assignTruck(params.freightId, truckDto, plantSyn);
          result = JSON.stringify({
            status: 'assigned', code: params.code,
            tripNumber: params.nextTripNumber,
            remaining: params.remaining,
            message: params.remaining > 0
              ? `Viaje #${params.nextTripNumber} asignado. Quedan ${params.remaining} viaje(s) sin asignar.`
              : `Viaje #${params.nextTripNumber} asignado. Todos los camiones del flete están asignados.`,
          });
          break;
        }

        case 'update_user_role': {
          // Validate role value before writing
          const validUcRoles = ['operario', 'gerente', 'chofer'];
          if (!validUcRoles.includes(params.newRole)) {
            throw new Error(`Rol inválido: ${params.newRole}. Valores válidos: ${validUcRoles.join(', ')}`);
          }
          // Re-validate membership still exists and belongs to the expected company
          const membership = await this.prisma.userCompany.findFirst({
            where: { id: params.membershipId, companyId: params.companyId, userId: params.targetUserId, active: true },
          });
          if (!membership) throw new Error('Membresía no encontrada o ya fue modificada');
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { role: params.newRole } });
          const roleMapping: Record<string, string> = { gerente: 'admin', operario: 'operator', chofer: 'operator' };
          await this.prisma.user.update({ where: { id: params.targetUserId }, data: { role: (roleMapping[params.newRole] || 'operator') as any } });
          result = JSON.stringify({ status: 'done', user: params.userName, newRole: params.newRole });
          break;
        }

        case 'deactivate_user': {
          const membershipCheck = await this.prisma.userCompany.findFirst({
            where: { id: params.membershipId, companyId: params.companyId || synUser.companyId, userId: params.targetUserId, active: true },
          });
          if (!membershipCheck) throw new Error('Membresía no encontrada o ya fue modificada');
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { active: false } });
          const otherActive = await this.prisma.userCompany.count({ where: { userId: params.targetUserId, active: true } });
          if (otherActive === 0) {
            await this.prisma.user.update({ where: { id: params.targetUserId }, data: { active: false } });
          }
          result = JSON.stringify({ status: 'done', user: params.userName });
          break;
        }

        case 'create_field': {
          const field = await this.fieldsService.createField(params.producerSynUser, params.dto);
          result = JSON.stringify({ status: 'created', field: { id: field.id, name: field.name } });
          break;
        }

        case 'create_lot': {
          const lot = await this.fieldsService.createLot(params.producerSynUser, params.fieldId, params.dto);
          result = JSON.stringify({ status: 'created', lot: { id: lot.id, name: lot.name } });
          break;
        }

        case 'create_truck': {
          const truck = await this.trucksService.create(params.dto as any, params.actionSynUser);
          result = JSON.stringify({ status: 'created', truck: { id: (truck as any).id, plate: (truck as any).plate } });
          break;
        }

        case 'create_user': {
          // Generate random password at confirm time — never stored in session
          const randomPwd = crypto.randomBytes(12).toString('base64url').slice(0, 16) + 'A1!';
          const pwdHash = await bcryptAi.hash(randomPwd, 10);
          const newUser = await this.adminService.createUser(params.dto, pwdHash);
          result = JSON.stringify({ status: 'created', user: { name: (newUser as any).name, email: (newUser as any).email, role: params.roleLabel } });
          // Send password reset link instead of plaintext password (C1: never send passwords via WhatsApp)
          if (params.dto?.phone) {
            const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
            this.wa.sendText(params.dto.phone, `Bienvenido a Tolvink. Su cuenta fue creada.\n\nPara configurar su contraseña, ingrese a:\n${frontendUrl}/reset-password\n\nUse su email o teléfono para identificarse.`).catch(e => this.logger.warn(`Failed to send welcome WA to ${params.dto.phone}: ${e.message}`));
          }
          break;
        }

        case 'attach_document': {
          this.logger.log(`attach_document freightId=${params.freightId} code=${params.code} doc=${params.document?.name}`);
          const doc = await this.freights.addDocument(params.freightId, {
            name: params.document.name,
            url: params.document.url,
            type: params.document.type,
            step: params.step || null,
          }, synUser);
          this.logger.log(`attach_document created doc: ${(doc as any).id}`);
          result = JSON.stringify({ status: 'attached', code: params.code, document: params.document.name, docId: (doc as any).id });
          break;
        }

        case 'update_freight': {
          const updateResult = await this.freights.updateFreight(params.freightId, params.dto, synUser);
          if ((updateResult as any).pendingChangeCreated) {
            result = JSON.stringify({ status: 'pending_approval', code: params.code, message: `Flete ${params.code}: algunos cambios requieren aprobación. Se notificó a la empresa correspondiente.` });
          } else {
            result = JSON.stringify({ status: 'updated', code: params.code, message: `Flete ${params.code} modificado exitosamente.` });
          }
          break;
        }

        case 'duplicate_freight': {
          const orig = params.originalFreight;
          const dupSessionCompanyId = oldState.selectedCompanyId || user.activeCompanyId;
          const producerCompanyId = dupSessionCompanyId
            ? this.resolveProducerCompanyIdForCompany(user, dupSessionCompanyId)
            : this.resolveProducerCompanyId(user);
          const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };
          const createDto: any = {
            items: [{ grain: orig.grain, tons: orig.tons }],
            loadDate: params.loadDate,
            loadTime: params.loadTime,
            truckCount: orig.truckCount || 1,
            notes: orig.notes,
          };
          if (orig.destPlantId) createDto.destPlantId = orig.destPlantId;
          else if (orig.destCompanyId) createDto.destCompanyId = orig.destCompanyId;
          else if (orig.customDestName) createDto.customDestName = orig.customDestName;
          if (orig.originLotId) createDto.originLotId = orig.originLotId;
          else if (orig.customOriginName) createDto.customOriginName = orig.customOriginName;
          if (orig.originLat != null && orig.originLng != null) { createDto.overrideOriginLat = orig.originLat; createDto.overrideOriginLng = orig.originLng; }
          if (orig.destLat != null && orig.destLng != null) { createDto.overrideDestLat = orig.destLat; createDto.overrideDestLng = orig.destLng; }
          if (orig.truckId) createDto.truckId = orig.truckId;
          if (orig.driverId) createDto.driverId = orig.driverId;
          const newFreight = await this.freights.create(createDto, producerSynUser);
          result = JSON.stringify({ status: 'duplicated', originalCode: params.originalCode, newCode: (newFreight as any).code, link: `${APP_URL}/freight/${(newFreight as any).id}` });
          break;
        }

        case 'update_field': {
          const fieldSynUser = { ...synUser, companyId: params.producerCompanyId, companyType: 'producer', userType: 'producer' };
          await this.fieldsService.updateField(fieldSynUser, params.fieldId, params.dto);
          result = JSON.stringify({ status: 'updated', fieldName: params.fieldName, message: `Campo "${params.fieldName}" modificado exitosamente.` });
          break;
        }

        case 'update_lot': {
          const lotSynUser = { ...synUser, companyId: params.producerCompanyId, companyType: 'producer', userType: 'producer' };
          await this.fieldsService.updateLot(lotSynUser, params.fieldId, params.lotId, params.dto);
          result = JSON.stringify({ status: 'updated', lotName: params.lotName, fieldName: params.fieldName, message: `Lote "${params.lotName}" modificado exitosamente.` });
          break;
        }

        case 'reactivate_user': {
          // Re-validate: membership belongs to caller's company and caller is admin
          const reactivateCoId = user.activeCompanyId || user.companyId;
          if (!this.isCallerAdminForCompany(user, reactivateCoId)) {
            throw new Error('No tiene permisos de administrador para esta acción.');
          }
          const memberCheck = await this.prisma.userCompany.findFirst({
            where: { id: params.membershipId, companyId: reactivateCoId, userId: params.targetUserId, active: false },
          });
          if (!memberCheck) throw new Error('Membresía no encontrada o ya fue modificada.');
          await this.prisma.userCompany.update({
            where: { id: params.membershipId },
            data: { active: true },
          });
          await this.prisma.user.update({
            where: { id: params.targetUserId },
            data: { active: true },
          });
          result = JSON.stringify({ status: 'reactivated', userName: params.userName, message: `Usuario "${params.userName}" reactivado exitosamente.` });
          break;
        }

        case 'authorize_freight': {
          await this.freights.authorize(params.freightId, synUser);
          result = JSON.stringify({ status: 'authorized', code: params.code, message: `Flete ${params.code} autorizado.` });
          break;
        }

        case 'approve_pending_change': {
          await this.freights.approvePendingChange(params.freightId, params.changeId, synUser);
          result = JSON.stringify({ status: 'approved', code: params.code, message: `Cambio aprobado en flete ${params.code}.` });
          break;
        }

        case 'reject_pending_change': {
          await this.freights.rejectPendingChange(params.freightId, params.changeId, synUser, params.reason);
          result = JSON.stringify({ status: 'rejected', code: params.code, message: `Cambio rechazado en flete ${params.code}.` });
          break;
        }

        case 'respond_trip': {
          await this.freights.respondTrip(params.freightId, params.assignmentId, { action: params.action, reason: params.reason }, synUser);
          const label = params.action === 'accepted' ? 'aceptado' : 'rechazado';
          result = JSON.stringify({ status: label, code: params.code, message: `Viaje de ${params.code} ${label}.` });
          break;
        }

        case 'start_trip': {
          await this.freights.startTrip(params.freightId, params.assignmentId, synUser);
          result = JSON.stringify({ status: 'started', code: params.code, message: `Viaje de ${params.code} iniciado.` });
          break;
        }

        case 'confirm_trip_loaded': {
          const loadedTons = params.loadedTons != null ? Number(params.loadedTons) : undefined;
          if (loadedTons !== undefined && (!isFinite(loadedTons) || loadedTons <= 0 || loadedTons > 200)) {
            result = JSON.stringify({ error: 'Toneladas cargadas inválidas (debe ser entre 0 y 200).' });
            break;
          }
          await this.freights.confirmTripLoaded(params.freightId, params.assignmentId, synUser, loadedTons);
          result = JSON.stringify({ status: 'loaded', code: params.code, message: `Carga confirmada para viaje de ${params.code}.` });
          break;
        }

        case 'confirm_trip_finished': {
          await this.freights.confirmTripFinished(params.freightId, params.assignmentId, synUser);
          result = JSON.stringify({ status: 'finished', code: params.code, message: `Entrega confirmada para viaje de ${params.code}.` });
          break;
        }

        case 'cancel_assignment': {
          await this.freights.cancelAssignment(params.freightId, params.assignmentId, params.reason, synUser);
          result = JSON.stringify({ status: 'canceled', code: params.code, message: `Asignación cancelada en flete ${params.code}.` });
          break;
        }

        case 'update_assignment': {
          if (!this.canAccessCompany(user, synUser, params.plantCompanyId)) {
            result = JSON.stringify({ error: 'No tiene acceso a la empresa para esta acción.' });
            break;
          }
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          await this.freights.updateAssignment(params.freightId, params.assignmentId, params.dto, plantSyn);
          result = JSON.stringify({ status: 'updated', code: params.code, message: `Viaje de ${params.code} actualizado.` });
          break;
        }

        case 'create_driver': {
          // Re-validate admin role at confirm time (may have changed since staging)
          if (!this.isCallerAdminForCompany(user, params.companyId)) {
            result = JSON.stringify({ error: 'Ya no tenés permisos de administrador para esta empresa.' });
            break;
          }
          const driverSyn = { ...synUser, companyId: params.companyId };
          const driver = await this.trucksService.createDriver({ name: params.name, phone: params.phone }, driverSyn);
          result = JSON.stringify({ status: 'created', driver: { id: (driver as any).id, name: (driver as any).name }, message: `Chofer "${params.name}" registrado.` });
          break;
        }

        case 'update_profile': {
          // Only allow name changes from WhatsApp (email/phone blocked)
          const dto: any = {};
          if (params.name) dto.name = params.name;
          await this.adminService.updateSelf(params.userId, dto);
          result = JSON.stringify({ status: 'updated', message: 'Perfil actualizado exitosamente.' });
          break;
        }

        // --- New confirm_action handlers ---

        case 'delete_document': {
          await this.prisma.freightDocument.delete({ where: { id: params.documentId } });
          result = JSON.stringify({ status: 'deleted', code: params.code, message: `Documento "${params.docName}" eliminado del flete ${params.code}.` });
          break;
        }

        case 'save_ocr_data': {
          await this.prisma.freightDocument.update({
            where: { id: params.documentId },
            data: { ocrData: params.ocrData },
          });
          result = JSON.stringify({ status: 'saved', code: params.code, message: `Datos OCR guardados en documento "${params.docName}" del flete ${params.code}.` });
          break;
        }

        case 'deactivate_truck': {
          await this.prisma.truck.update({ where: { id: params.truckId }, data: { active: false } });
          result = JSON.stringify({ status: 'deactivated', message: `Camión ${params.plate} desactivado.` });
          break;
        }

        case 'update_truck': {
          const truckData: any = {};
          if (params.plate) truckData.plate = params.plate;
          if (params.brand !== undefined) truckData.brand = params.brand;
          if (params.model !== undefined) truckData.model = params.model;
          if (params.capacity !== undefined) truckData.capacity = params.capacity;
          await this.prisma.truck.update({ where: { id: params.truckId }, data: truckData });
          result = JSON.stringify({ status: 'updated', message: `Camión actualizado.` });
          break;
        }

        case 'deactivate_driver': {
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { active: false } });
          result = JSON.stringify({ status: 'deactivated', message: `Chofer ${params.driverName || ''} desactivado.` });
          break;
        }

        case 'grant_producer_access': {
          const existing = await this.prisma.plantProducerAccess.findFirst({
            where: { plantCompanyId: params.plantCompanyId, producerCompanyId: params.producerCompanyId, producerUserId: params.producerUserId || null },
          });
          if (existing) {
            await this.prisma.plantProducerAccess.update({ where: { id: existing.id }, data: { active: true } });
          } else {
            await this.prisma.plantProducerAccess.create({
              data: { plantCompanyId: params.plantCompanyId, producerCompanyId: params.producerCompanyId, producerUserId: params.producerUserId || null },
            });
          }
          result = JSON.stringify({ status: 'granted', message: `Productor "${params.producerName}" habilitado.` });
          break;
        }

        case 'revoke_producer_access': {
          await this.prisma.plantProducerAccess.update({ where: { id: params.accessId }, data: { active: false } });
          result = JSON.stringify({ status: 'revoked', message: `Acceso del productor "${params.producerName}" revocado.` });
          break;
        }

        case 'create_branch': {
          await this.prisma.branch.create({
            data: { name: params.name, companyId: params.companyId, address: params.address, reference: params.reference, lat: params.lat, lng: params.lng },
          });
          result = JSON.stringify({ status: 'created', message: `Sucursal "${params.name}" creada.` });
          break;
        }

        case 'update_branch': {
          const brData: any = {};
          if (params.name !== undefined) brData.name = params.name;
          if (params.address !== undefined) brData.address = params.address;
          if (params.reference !== undefined) brData.reference = params.reference;
          if (params.lat !== undefined) brData.lat = params.lat;
          if (params.lng !== undefined) brData.lng = params.lng;
          await this.prisma.branch.update({ where: { id: params.branchId }, data: brData });
          result = JSON.stringify({ status: 'updated', message: `Sucursal actualizada.` });
          break;
        }

        case 'delete_branch': {
          await this.prisma.branch.update({ where: { id: params.branchId }, data: { active: false } });
          result = JSON.stringify({ status: 'deactivated', message: `Sucursal "${params.branchName}" desactivada.` });
          break;
        }

        case 'update_company': {
          // Re-validate admin permission at confirm time
          if (!this.isCallerAdminForCompany(user, params.companyId)) {
            result = JSON.stringify({ error: 'No tiene permisos para actualizar esta empresa.' });
            break;
          }
          const coData: any = {};
          if (params.name !== undefined) coData.name = params.name;
          if (params.address !== undefined) coData.address = params.address;
          if (params.phone !== undefined) coData.phone = params.phone;
          if (params.email !== undefined) coData.email = params.email;
          if (params.lat !== undefined) coData.lat = params.lat;
          if (params.lng !== undefined) coData.lng = params.lng;
          await this.prisma.company.update({ where: { id: params.companyId }, data: coData });
          result = JSON.stringify({ status: 'updated', message: 'Datos de la empresa actualizados.' });
          break;
        }

        case 'update_user_admin': {
          // Re-validate admin permission at confirm time
          if (!this.isCallerAdminForCompany(user, params.companyId)) {
            result = JSON.stringify({ error: 'Ya no tenés permisos de administrador para esta empresa.' });
            break;
          }
          const uData: any = {};
          if (params.name !== undefined) uData.name = params.name;
          if (params.email !== undefined) uData.email = params.email.toLowerCase().trim();
          if (params.phone !== undefined) uData.phone = params.phone;
          if (params.active !== undefined) uData.active = params.active;
          if (params.role !== undefined) {
            const roleMap: Record<string, string> = { admin: 'admin', gerente: 'admin', operario: 'operator', chofer: 'operator' };
            uData.role = roleMap[params.role] || 'operator';
          }
          await this.prisma.user.update({ where: { id: params.userId }, data: uData });
          // Sync membership role if role changed
          if (params.role) {
            await this.prisma.userCompany.updateMany({
              where: { userId: params.userId, companyId: params.companyId },
              data: { role: params.role, active: params.active !== false },
            }).catch(e => this.logger.warn(`Failed to sync membership for user ${params.userId}: ${e.message}`));
          }
          result = JSON.stringify({ status: 'updated', message: `Usuario "${params.userName}" actualizado.` });
          break;
        }

        case 'assign_multi_trucks': {
          if (!this.canAccessCompany(user, synUser, params.plantCompanyId)) {
            result = JSON.stringify({ error: 'No tiene acceso a la empresa para esta acción.' });
            break;
          }
          const plantSynMulti = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          await this.freights.assignMulti(params.freightId, { trucks: params.trucks }, plantSynMulti);
          result = JSON.stringify({ status: 'assigned', code: params.code, message: `${params.trucks.length} camiones asignados al flete ${params.code}.` });
          break;
        }

        case 'reorder_driver_queue': {
          await this.freights.reorderDriverQueue(params.driverId, params.orderedFreightIds, synUser);
          result = JSON.stringify({ status: 'reordered', message: `Cola de ${params.driverName} reordenada (${params.orderedFreightIds.length} fletes).` });
          break;
        }

        default:
          result = JSON.stringify({ error: `Acción no reconocida: ${tool}` });
      }
    } catch (e) {
      this.logger.error(`confirm_action dispatch error (${tool}): ${e.message}`, e.stack?.slice(0, 300));
      // Restore pendingAction so user can retry
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: { ...preExecState, pendingAction: pending } },
      }).catch(e => this.logger.warn(e.message));
      // H2: Sanitize — map known error patterns to user-friendly messages
      const msg = String(e.message || '');
      const SAFE_ERRORS: [RegExp, string][] = [
        [/no encontrad/i, 'El recurso no fue encontrado.'],
        [/no se puede cancelar/i, msg],
        [/estado.*inv[aá]lido|transici[oó]n/i, 'La operación no es valida en el estado actual del flete.'],
        [/ya.*asignad|ya.*acept/i, 'La acción ya fue realizada previamente.'],
        [/permiso|forbidden|autoriza/i, 'No tiene permisos para realizar esta acción.'],
        [/chofer no encontrado/i, 'El chofer indicado no fue encontrado en la empresa.'],
        [/empresa.*no.*encontr/i, 'La empresa indicada no fue encontrada.'],
        [/membres[ií]a/i, 'El usuario ya no pertenece a la empresa.'],
      ];
      const safeMsg = SAFE_ERRORS.find(([re]) => re.test(msg))?.[1] || 'No se pudo ejecutar la acción. Intente nuevamente.';
      return JSON.stringify({ error: safeMsg });
    }

    // pendingAction already cleared by CTE. Clean up pendingDocument if attach_document.
    if (tool === 'attach_document') {
      const { pendingDocument: _pd, pendingAction: _pa, _pendingButtons: _pb, ...finalState } = preExecState;
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: { flowState: finalState },
      });
    }

    return result;
  }

  // ---- accept_freight ----
  private async toolAcceptFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'accept_freight', {
      freightId: freight.id, code: freight.code,
    }, `Aceptar flete ${freight.code}`);
  }

  // ---- reject_freight ----
  private async toolRejectFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'reject_freight', {
      freightId: freight.id, code: freight.code, reason: input.reason,
    }, `Rechazar flete ${freight.code} · Motivo: ${input.reason}`);
  }

  // ---- start_freight ----
  private async toolStartFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'start_freight', {
      freightId: freight.id, code: freight.code,
    }, `Iniciar viaje del flete ${freight.code}`);
  }

  // ---- confirm_loaded ----
  private async toolConfirmLoaded(input: any, user: any, synUser: any, session: any): Promise<string> {
    const tons = Number(input.tons);
    if (input.tons == null || isNaN(tons) || tons <= 0) {
      return JSON.stringify({ error: 'Toneladas cargadas (tons) requeridas y deben ser un número positivo.' });
    }
    if (tons > 200) {
      return JSON.stringify({ error: `${tons} toneladas parece un valor inusual. Verifique con el usuario. Máximo razonable: 200 tn.` });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'confirm_loaded', {
      freightId: freight.id, code: freight.code, tons,
    }, `Confirmar carga del flete ${freight.code} · ${tons} tn`);
  }

  // ---- confirm_finished ----
  private async toolConfirmFinished(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'confirm_finished', {
      freightId: freight.id, code: freight.code,
    }, `Confirmar entrega del flete ${freight.code}`);
  }

  // ---- cancel_freight ----
  private async toolCancelFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    if (['in_progress', 'loaded'].includes(freight.status)) {
      return JSON.stringify({ error: `No se puede cancelar ${input.code} en estado ${freight.status}` });
    }

    return this.stageAction(session, 'cancel_freight', {
      freightId: freight.id, code: freight.code, reason: input.reason,
    }, `Cancelar flete ${freight.code} · Motivo: ${input.reason}`);
  }

  // ======================== FIELD & LOT TOOLS ===========================

  // ---- list_fields ----
  private async toolListFields(user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No es productor', fields: [] });
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { lots: { where: { active: true } } },
      orderBy: { name: 'asc' },
    });

    if (fields.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay campos registrados. Puede crear uno con create_field.' });
    }

    const items = fields.map((f: any) => ({
      id: `field:${f.id}`,
      title: (f.name || 'Sin nombre').slice(0, 24),
      description: `${f.lots?.length || 0} lote${f.lots?.length !== 1 ? 's' : ''}${f.address ? ' · ' + f.address : ''}`.slice(0, 72),
    }));

    // Include full field data so AI can answer follow-up questions (mapLink instead of raw coords)
    const fieldsData = fields.map((f: any) => {
      const fLat = f.lat != null ? Number(f.lat) : null;
      const fLng = f.lng != null ? Number(f.lng) : null;
      let mapLink: string | null = null;
      if (fLat != null && fLng != null) {
        const p = new URLSearchParams();
        p.set('lat', fLat.toFixed(6)); p.set('lng', fLng.toFixed(6)); p.set('n', (f.name || 'Campo').slice(0, 60));
        mapLink = `${APP_URL}/ver-mapa?${p.toString()}`;
      }
      return {
        id: f.id, name: f.name, address: f.address, mapLink,
        lots: f.lots.map((l: any) => ({ id: l.id, name: l.name })),
      };
    });

    return this.storePendingSelection(session, items, {
      headerText: '🌾 Campos registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver campos',
      sectionTitle: 'CAMPOS',
    }, 'field_info', { fields: fieldsData });
  }

  // ---- create_field ----
  private async toolCreateField(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (lat == null || lng == null) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        if (lat == null) lat = st.lastLocation.lat;
        if (lng == null) lng = st.lastLocation.lng;
      }
    }

    // Location is mandatory for field creation
    if (lat == null || lng == null) {
      return JSON.stringify({
        error: 'La ubicación es obligatoria para crear un campo. Use generate_location_link con purpose "field" para generar el enlace.',
      });
    }

    const dto = { name: input.name, address: input.address || null, lat, lng };
    const summary = `Crear campo "${input.name}"${input.address ? ` en ${input.address}` : ''} (ubicación incluida)`;

    return this.stageAction(session, 'create_field', { producerSynUser, dto }, summary);
  }

  // ---- create_lot ----
  private async toolCreateLot(input: any, user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };

    // Use lastLocation from WhatsApp if no lat/lng provided
    let lat = input.lat, lng = input.lng;
    if (lat == null || lng == null) {
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const st = (freshSession?.flowState as any) || {};
      if (st.lastLocation) {
        if (lat == null) lat = st.lastLocation.lat;
        if (lng == null) lng = st.lastLocation.lng;
      }
    }

    // Location is mandatory for lot creation
    if (lat == null || lng == null) {
      return JSON.stringify({
        error: 'La ubicación es obligatoria para crear un lote. Use generate_location_link con purpose "lot" para generar el enlace.',
      });
    }

    // Verify field belongs to the producer's company
    const field = await this.prisma.field.findFirst({
      where: { id: input.fieldId, companyId: producerCompanyId, active: true },
      select: { name: true },
    });
    if (!field) {
      return JSON.stringify({ error: 'No se encontró el campo o no pertenece a su empresa.' });
    }

    const dto = { name: input.name, hectares: input.hectares || null, lat, lng };
    const summary = `Crear lote "${input.name}" en campo "${field.name}"${input.hectares ? ` (${input.hectares} ha)` : ''}`;

    return this.stageAction(session, 'create_lot', { producerSynUser, fieldId: input.fieldId, dto }, summary);
  }

  // ======================== TRUCK TOOLS ==================================

  // ---- list_trucks ----
  private async toolListTrucks(user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const trucks = await this.trucksService.list(synUser);

    if ((trucks as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay camiones registrados. Puede crear uno con create_truck.' });
    }

    const items = (trucks as any[]).map((t: any) => ({
      id: `truck:${t.id}`,
      title: (t.plate || '').toUpperCase().slice(0, 24),
      description: `${[t.brand, t.model].filter(Boolean).join(' ')}${t.assignedUser?.name ? ' · ' + t.assignedUser.name : ''}`.slice(0, 72) || 'Sin detalle',
    }));

    return this.storePendingSelection(session, items, {
      headerText: '🚛 Camiones registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver camiones',
      sectionTitle: 'CAMIONES',
    }, 'truck_info');
  }

  // ---- create_truck ----
  private async toolCreateTruck(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden registrar camiones.' });
    }
    const synUser = this.buildSyntheticUser(user);
    const dto = { plate: input.plate, model: input.model || null };
    const summary = `Registrar camión ${input.plate}${input.model ? ` (${input.model})` : ''}`;

    return this.stageAction(session, 'create_truck', { dto, actionSynUser: synUser }, summary);
  }

  // ======================== USER TOOLS ===================================

  // ---- create_user ----
  private async toolCreateUser(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const companyType = this.resolveCompanyType(user);
    const targetCompanyId = producerCompanyId || user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, targetCompanyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden crear usuarios.' });
    }
    const primaryType = companyType.split(',')[0]?.trim() || 'producer';

    // Map Spanish role names to Prisma UserRole enum (admin | operator | platform_admin)
    const inputRole = input.role || 'operario';
    const validRoles = ['admin', 'gerente', 'operario', 'chofer'];
    if (!validRoles.includes(inputRole)) {
      return JSON.stringify({ error: `Rol inválido: ${inputRole}. Valores válidos: ${validRoles.join(', ')}` });
    }
    const roleToEnum: Record<string, string> = {
      admin: 'admin', gerente: 'admin',
      operario: 'operator', chofer: 'operator',
    };
    const prismaRole = roleToEnum[inputRole] || 'operator';

    // Password generated at confirm time — never stored in session flowState

    const dto: any = {
      name: input.name,
      email: input.email,
      password: 'placeholder', // required by DTO — actual hash passed separately
      phone: input.phone || null,
      role: prismaRole,
      companyId: targetCompanyId,
      userTypes: [primaryType],
      companyByType: { [primaryType]: targetCompanyId },
      roleByType: { [primaryType]: inputRole },
    };

    const summary = `Crear usuario "${input.name}" (${input.email}) con rol ${inputRole}`;
    return this.stageAction(session, 'create_user', { dto, roleLabel: inputRole }, summary, user);
  }

  // ======================== DOCUMENT ATTACHMENT TOOL =======================

  // ---- attach_document ----
  private async toolAttachDocument(input: any, user: any, synUser: any, session: any): Promise<string> {
    // Read pendingDocument from session
    const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
    const state = (freshSession?.flowState as any) || {};
    const pending = state.pendingDocument;

    if (!pending) {
      return JSON.stringify({ error: 'No hay archivo pendiente. El usuario debe enviar una imagen o documento primero.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const summary = `Adjuntar ${pending.type === 'photo' ? 'imagen' : 'documento'} "${pending.name}" a flete ${freight.code}`;

    return this.stageAction(session, 'attach_document', {
      freightId: freight.id,
      code: freight.code,
      document: pending,
      step: input.step || null,
    }, summary);
  }

  // ======================== LOCATION PICKER TOOL ==========================

  // ---- generate_location_link ----
  private toolGenerateLocationLink(input: any, session: any): string {
    const token = crypto.randomUUID();
    const purposeLabel = (input.purpose || 'campo').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 20);
    const slug = `${purposeLabel}-${crypto.randomBytes(8).toString('hex')}`;

    // Use side-effects pattern (merged by chat()) — avoids direct DB write race
    const effects = this._chatSideEffects.get(session.id) || {};
    effects.locationToken = {
      token,
      slug,
      purpose: input.purpose || 'general',
      createdAt: new Date().toISOString(),
    };
    effects._pendingButtons = [
      { id: 'location_done', title: 'UBICACIÓN LISTA' },
    ];
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(session.id, effects);

    this.logger.log(`generate_location_link — slug=${slug}, sessionId=${session.id}`);

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/ubicacion/${slug}`;

    const purposeLabels: Record<string, string> = {
      origin: 'origen del flete',
      destination: 'destino del flete',
      field: 'ubicación del campo',
      lot: 'ubicación del lote',
    };
    const label = purposeLabels[input.purpose] || 'ubicación';

    return JSON.stringify({
      url,
      message: `Abra el siguiente enlace para marcar el ${label} en el mapa. Una vez confirmada la ubicación, presione el botón "UBICACIÓN LISTA".`,
    });
  }

  // ---- generate_tracking_link ----
  private async toolGenerateTrackingLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, shareToken: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control (origin, dest, and transporter companies)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    if (['finished', 'canceled'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} ya está ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}` });
    }

    // Reuse existing token or generate new one
    let token = freight.shareToken;
    if (!token) {
      token = crypto.randomUUID();
      await this.prisma.freight.update({
        where: { id: freight.id },
        data: { shareToken: token },
      });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${freight.code}/ubicacion?s=${token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace de seguimiento en vivo del flete ${code}. Ábralo para ver la ruta y posición del camión en tiempo real.`,
    });
  }

  // ---- generate_map_link ----
  private toolGenerateMapLink(input: any): string {
    const lat = Number(input.lat);
    const lng = Number(input.lng);
    if (isNaN(lat) || isNaN(lng) || !isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return JSON.stringify({ error: 'Coordenadas inválidas (lat: -90..90, lng: -180..180)' });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const params = new URLSearchParams();
    params.set('lat', lat.toFixed(6));
    params.set('lng', lng.toFixed(6));
    params.set('n', (input.name || 'Ubicación').slice(0, 60));
    if (input.destLat != null && input.destLng != null) {
      const dlat = Number(input.destLat), dlng = Number(input.destLng);
      if (!isNaN(dlat) && !isNaN(dlng) && isFinite(dlat) && isFinite(dlng) && dlat >= -90 && dlat <= 90 && dlng >= -180 && dlng <= 180) {
        params.set('dlat', dlat.toFixed(6));
        params.set('dlng', dlng.toFixed(6));
        if (input.destName) params.set('dn', input.destName.slice(0, 60));
      }
    }
    const url = `${frontendUrl}/ver-mapa?${params.toString()}`;

    return JSON.stringify({
      url,
      message: `Abra el link para ver la ubicación de ${input.name || 'este punto'} en el mapa Tolvink.`,
    });
  }

  // ---- generate_report_link ----
  private async toolGenerateReportLink(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, shareToken: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });

    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control (origin, dest, and transporter companies)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    // Reuse existing token or generate new one
    let token = freight.shareToken;
    if (!token) {
      token = crypto.randomUUID();
      await this.prisma.freight.update({
        where: { id: freight.id },
        data: { shareToken: token },
      });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/${freight.code}/informe?s=${token}`;

    return JSON.stringify({
      url,
      message: `Aquí tiene el enlace para descargar el informe PDF del flete ${code}. Ábralo desde cualquier dispositivo.`,
    });
  }

  // ======================== MAP & LIVE LOCATION TOOLS =====================

  // ---- generate_daily_map_link ----
  private async toolGenerateDailyMapLink(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar la empresa activa.' });

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const token = createSignedToken({ uid: user.id, cid: companyId, purpose: 'daily_map' }, secret, 1440); // 24h

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/daily-map?t=${token}`;

    return JSON.stringify({
      url,
      message: 'Abra el siguiente link para ver el mapa con todos los fletes del día. Puede filtrar por estado y tocar cada marcador para ver detalles.',
    });
  }

  // ---- share_live_location ----
  private async toolShareLiveLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    if (['finished', 'canceled'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} está ${freight.status === 'finished' ? 'finalizado' : 'cancelado'}. Solo se puede compartir ubicación en fletes activos.` });
    }

    // Access control
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const companyType = this.resolveCompanyType(user);
    const role = AiService.hasType(companyType, 'chofer') ? 'chofer'
      : AiService.hasType(companyType, 'transporter') ? 'transporter'
      : AiService.hasType(companyType, 'plant') ? 'plant' : 'producer';

    const token = createSignedToken(
      { uid: user.id, cid: userCompanyId, fid: freight.id, role, name: user.name || 'Usuario', purpose: 'live_location' },
      secret,
      120, // 2h
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/live-freight?t=${token}&mode=share`;

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para compartir su ubicación en tiempo real en el flete ${code}. Los demás participantes del flete podrán ver su posición en el mapa.`,
    });
  }

  // ---- view_live_locations ----
  private async toolViewLiveLocations(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, status: true, code: true,
        originCompanyId: true, destCompanyId: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access control
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...freight.assignments.map(a => a.transportCompanyId)];
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    if (!secret) return JSON.stringify({ error: 'Configuración del servidor incompleta.' });

    const token = createSignedToken(
      { uid: user.id, cid: userCompanyId, fid: freight.id, purpose: 'view_locations' },
      secret,
      120, // 2h
    );

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const url = `${frontendUrl}/live-freight?t=${token}&mode=view`;

    return JSON.stringify({
      url,
      message: `Abra el siguiente link para ver las ubicaciones en tiempo real de los participantes del flete ${code}.`,
    });
  }

  // ---- request_location ----
  private async toolRequestLocation(input: any, user: any): Promise<string> {
    const code = input.code?.toUpperCase();
    if (!code) return JSON.stringify({ error: 'Código de flete requerido' });

    const freight = await this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, code: true, status: true,
        originName: true, destName: true,
        originCompanyId: true, destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: {
            transportCompanyId: true,
            driverId: true,
            driver: { select: { phone: true, name: true, id: true } },
          },
        },
      },
    });
    if (!freight) return JSON.stringify({ error: `Flete ${code} no encontrado` });

    // Access check
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);
    const freightCompanies = [freight.originCompanyId, freight.destCompanyId,
      ...freight.assignments.map(a => a.transportCompanyId)].filter(Boolean);
    if (!allUserCompanies.some(c => freightCompanies.includes(c))) {
      return JSON.stringify({ error: `No tiene acceso al flete ${code}` });
    }

    if (!['in_progress', 'loaded', 'accepted'].includes(freight.status)) {
      return JSON.stringify({ error: `El flete ${code} no está activo (estado: ${freight.status})` });
    }

    // Cooldown: max 1 request_location per freight per 5 minutes
    const cooldownKey = `req_loc_${freight.id}`;
    const now = Date.now();
    if ((this._requestLocationCooldowns.get(cooldownKey) || 0) > now) {
      return JSON.stringify({ error: `Ya se solicitó ubicación para ${code} hace poco. Intente en unos minutos.` });
    }
    this._requestLocationCooldowns.set(cooldownKey, now + 5 * 60 * 1000);

    // Collect all participant companies
    const companyIds = new Set<string>();
    if (freight.originCompanyId) companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    for (const a of freight.assignments) {
      if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
    }

    const participants = await this.prisma.user.findMany({
      where: {
        phone: { not: null },
        active: true,
        OR: [
          { companyId: { in: Array.from(companyIds) } },
          { memberships: { some: { companyId: { in: Array.from(companyIds) }, active: true } } },
        ],
      },
      select: { phone: true, id: true, name: true },
      take: 50,
    });

    // Merge drivers + company users, deduplicate, exclude requester
    const allTargets = new Map<string, { phone: string; name: string }>();
    for (const a of freight.assignments) {
      const d = a.driver;
      if (d?.phone && d.id !== user.id) allTargets.set(d.id, { phone: d.phone, name: d.name || 'Chofer' });
    }
    for (const p of participants) {
      if (p.id !== user.id && !allTargets.has(p.id)) {
        allTargets.set(p.id, { phone: p.phone!, name: p.name || 'Usuario' });
      }
    }

    if (allTargets.size === 0) {
      return JSON.stringify({ error: 'No hay participantes con WhatsApp a quienes solicitar ubicación' });
    }

    const requesterName = user.name?.split(' ')[0] || 'Un participante';
    const msg = `*Solicitud de ubicación*\n${requesterName} solicita su ubicación para el flete ${freight.code} (${freight.originName} → ${freight.destName}).\n\nEnvíe su ubicación en este chat (adjuntar → Ubicación).`;

    let sent = 0;
    for (const [, target] of allTargets) {
      await this.wa.sendText(target.phone, msg).catch(() => {});
      sent++;
    }

    return JSON.stringify({
      status: 'ok',
      message: `Solicitud enviada a ${sent} participante${sent > 1 ? 's' : ''}`,
      sent,
    });
  }

  // ======================== POST-START TRACKING MESSAGES =================

  /**
   * Fire-and-forget: after a freight is started, send tracking links to stakeholders
   * and prompt the driver to share GPS location.
   */
  private async sendPostStartTrackingMessages(freightId: string, code: string, triggerUser: any): Promise<void> {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        id: true, code: true, shareToken: true,
        originName: true, destName: true,
        originCompanyId: true, destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: {
            transportCompanyId: true,
            driverId: true,
            driver: { select: { phone: true, name: true, id: true } },
          },
        },
      },
    });
    if (!freight) return;

    // Ensure shareToken exists for tracking URL
    let shareToken = freight.shareToken;
    if (!shareToken) {
      shareToken = crypto.randomUUID();
      await this.prisma.freight.update({ where: { id: freightId }, data: { shareToken } });
    }

    const frontendUrl = this.config.get<string>('FRONTEND_URL') || 'https://tolvink.com';
    const trackingUrl = `${frontendUrl}/${freight.code}/ubicacion?s=${shareToken}`;

    // 1) Build all messages first, then send in parallel
    const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
    const sends: Promise<any>[] = [];

    // Driver messages (GPS sharing request)
    for (const a of freight.assignments) {
      const driver = a.driver;
      if (!driver?.phone) continue;

      let liveShareUrl = '';
      if (secret) {
        const token = createSignedToken(
          { uid: driver.id, cid: a.transportCompanyId, fid: freight.id, role: 'chofer', name: driver.name || 'Chofer' },
          secret, 120,
        );
        liveShareUrl = `${frontendUrl}/live-freight?t=${token}&mode=share`;
      }

      const driverMsg = `*Flete ${freight.code} iniciado*\n${freight.originName} \u2192 ${freight.destName}\n\n`
        + `Puede enviar su ubicación en este chat (adjuntar \u2192 Ubicación) para que las empresas sigan el viaje.\n\n`
        + `Seguimiento: ${trackingUrl}`;

      sends.push(this.wa.sendText(driver.phone, driverMsg));
    }

    // 2) Stakeholder messages (tracking link)
    const companyIds = new Set<string>();
    if (freight.originCompanyId) companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    for (const a of freight.assignments) {
      if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
    }

    const stakeholders = await this.prisma.user.findMany({
      where: {
        phone: { not: null },
        active: true,
        OR: [
          { companyId: { in: Array.from(companyIds) }, role: { in: ['admin', 'platform_admin'] } },
          { memberships: { some: { companyId: { in: Array.from(companyIds) }, active: true, role: { in: ['gerente', 'admin'] } } } },
        ],
      },
      select: { phone: true, id: true, companyId: true },
      take: 30,
    });

    const driverIds = new Set(freight.assignments.map(a => a.driverId).filter(Boolean));
    const triggerUserId = triggerUser.id;

    for (const s of stakeholders) {
      if (driverIds.has(s.id) || s.id === triggerUserId) continue;
      if (!s.phone) continue;

      let liveViewUrl = '';
      if (secret && s.companyId) {
        const viewToken = createSignedToken(
          { uid: s.id, cid: s.companyId, fid: freight.id },
          secret, 120,
        );
        liveViewUrl = `${frontendUrl}/live-freight?t=${viewToken}&mode=view`;
      }

      const trackMsg = `*Flete ${freight.code} en camino*\n${freight.originName} → ${freight.destName}\n\n`
        + `Seguimiento en vivo: ${liveViewUrl || trackingUrl}`;

      sends.push(this.wa.sendText(s.phone, trackMsg));
    }

    // Send all messages in parallel
    await Promise.allSettled(sends);
  }

  // ======================== TRANSPORTER ASSIGNMENT TOOLS ==================

  // ---- list_transporters ----
  private async toolListTransporters(user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant') && !AiService.hasType(companyType, 'producer')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta o productor pueden listar transportistas.' });
    }

    const ownCompanyId = user.activeCompanyId || user.companyId;
    let hasOwnFleet = false;
    if (ownCompanyId) {
      const ownCompany = await this.prisma.company.findUnique({
        where: { id: ownCompanyId },
        select: { name: true, hasInternalFleet: true },
      });
      if (ownCompany?.hasInternalFleet) hasOwnFleet = true;
    }

    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { OR: [{ producerCompanyId: ownCompanyId }, { plantCompanyId: ownCompanyId }], active: true },
      select: { producerCompanyId: true, plantCompanyId: true },
      take: 500,
    });
    const relatedCompanyIds = [...new Set(accessRecords.map(a =>
      a.producerCompanyId === ownCompanyId ? a.plantCompanyId : a.producerCompanyId,
    ))];
    const freightRelated = await this.prisma.freightAssignment.findMany({
      where: {
        transportCompanyId: { not: null },
        freight: { OR: [{ originCompanyId: ownCompanyId }, { destCompanyId: ownCompanyId }] },
      },
      distinct: ['transportCompanyId'],
      select: { transportCompanyId: true },
    });
    for (const fr of freightRelated) {
      if (fr.transportCompanyId) relatedCompanyIds.push(fr.transportCompanyId);
    }
    const uniqueIds = [...new Set(relatedCompanyIds)];

    const transporters = uniqueIds.length > 0
      ? await this.prisma.company.findMany({
          where: {
            id: { in: uniqueIds }, active: true,
            OR: [{ type: 'transporter' }, { types: { array_contains: ['transporter'] } }],
          },
          select: { id: true, name: true, phone: true },
          orderBy: { name: 'asc' },
          take: 50,
        })
      : [];

    const result: any[] = transporters.map(c => ({ id: c.id, name: c.name, phone: c.phone }));

    if (hasOwnFleet && ownCompanyId && !result.some(r => r.id === ownCompanyId)) {
      const ownCompany = await this.prisma.company.findUnique({
        where: { id: ownCompanyId },
        select: { id: true, name: true, phone: true },
      });
      if (ownCompany) {
        result.unshift({ id: ownCompany.id, name: `${ownCompany.name} (Flota interna)`, phone: ownCompany.phone, ownFleet: true });
      }
    }

    if (result.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay transportistas disponibles.' });
    }

    const items = result.map(c => ({
      id: `transporter:${c.id}`,
      title: c.name.slice(0, 24),
      description: (c.phone || 'Sin teléfono').slice(0, 72),
    }));

    const extraJson: any = { transporters: result };
    if (hasOwnFleet) {
      extraJson.NOTA = 'Este usuario tiene FLOTA INTERNA. Para asignar su propia flota, llamar assign_transporter con transporterCompanyId="own_fleet". No es necesario preguntar al usuario cuál empresa.';
    }

    return this.storePendingSelection(session, items, {
      headerText: '👤 Transportistas disponibles.\nSeleccione uno:',
      listButtonLabel: 'Ver transportistas',
      sectionTitle: 'TRANSPORTISTAS',
    }, 'transporter_info', extraJson);
  }

  // ---- assign_transporter ----
  private async toolAssignTransporter(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    const isPlant = AiService.hasType(companyType, 'plant');
    const isOwnFleetInput = input.transporterCompanyId === OWN_FLEET_SHORTCUT;
    const isProducerWithOwnFleet = AiService.hasType(companyType, 'producer') && isOwnFleetInput;
    if (!isPlant && !isProducerWithOwnFleet) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta o productores con flota propia pueden asignar transportistas.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    // Resolve "own_fleet" shortcut to user's own company
    let transporterCompanyId = input.transporterCompanyId;
    const isOwnFleetShortcut = transporterCompanyId === OWN_FLEET_SHORTCUT;
    if (isOwnFleetShortcut) {
      transporterCompanyId = user.activeCompanyId || user.companyId;
    }

    const transporter = await this.prisma.company.findUnique({
      where: { id: transporterCompanyId },
      select: { name: true, hasInternalFleet: true },
    });
    if (!transporter) return JSON.stringify({ error: 'Empresa transportista no encontrada.' });
    const transporterName = transporter.name;

    // Note: useOwnFleet flag will be set in confirm_action handler, not here (before confirmation)
    if (isOwnFleetShortcut && (freight as any).useOwnFleet == null) {
      // Deferred to confirm_action — mark in staged params instead
    }

    // Resolve the acting company: plant users only
    const actingCompanyId = this.resolvePlantCompanyId(user);

    const userCompanyId = user.activeCompanyId || user.companyId;
    const isOwnFleet = transporter.hasInternalFleet && transporterCompanyId === userCompanyId;
    const displayName = isOwnFleet ? `${transporterName} (Flota interna)` : transporterName;

    return this.stageAction(session, 'assign_transporter', {
      freightId: freight.id, code: freight.code,
      transporterCompanyId,
      transporterName: displayName,
      truckId: input.truckId || null,
      driverId: input.driverId || null,
      plantCompanyId: actingCompanyId,
      setOwnFleet: isOwnFleetShortcut && (freight as any).useOwnFleet == null,
    }, `Asignar transportista "${displayName}" a flete ${freight.code}`, user);
  }

  // ---- assign_truck_to_trip ----
  private async toolAssignTruckToTrip(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden editar asignaciones.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { freightId: freight.id, status: { in: ['active', 'accepted'] } },
      select: { id: true },
    });
    if (!assignment) {
      return JSON.stringify({ error: `${input.code} no tiene asignación activa.` });
    }

    // Verify truck exists and belongs to the transporter's company
    const assignmentFull = await this.prisma.freightAssignment.findFirst({
      where: { freightId: freight.id, status: { in: ['active', 'accepted'] } },
      select: { transportCompanyId: true },
    });
    const truckOwnerCompany = assignmentFull?.transportCompanyId || user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: input.truckId, companyId: truckOwnerCompany, active: true },
      select: { plate: true, model: true },
    });
    if (!truck) {
      return JSON.stringify({ error: 'No se encontró el camión o no pertenece a la empresa transportista.' });
    }
    const truckDisplay = truck.model ? `${truck.plate} (${truck.model})` : truck.plate;
    const plantCompanyId = this.resolvePlantCompanyId(user);

    return this.stageAction(session, 'assign_truck_to_trip', {
      freightId: freight.id, code: freight.code,
      assignmentId: assignment.id,
      truckId: input.truckId,
      driverId: input.driverId || null,
      truckDisplay,
      plantCompanyId,
    }, `Asignar camión ${truckDisplay} a flete ${freight.code}`);
  }

  // ---- assign_truck_to_freight (multi-truck) ----
  private async toolAssignTruckToFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    // Only plants or producers with own fleet can assign additional trucks
    const companyType = this.resolveCompanyType(user);
    const isPlant = AiService.hasType(companyType, 'plant');
    const isProducerOwnFleet = AiService.hasType(companyType, 'producer') && input.transporterCompanyId === OWN_FLEET_SHORTCUT;
    if (!isPlant && !isProducerOwnFleet) {
      return JSON.stringify({ error: 'Solo plantas o productores con flota propia pueden asignar camiones adicionales.' });
    }

    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    const truckCount = freight.truckCount || 1;
    const assigned = freight.assignedTruckCount || 0;

    if (assigned >= truckCount) {
      return JSON.stringify({ error: `${freight.code} ya tiene todos los viajes asignados (${assigned}/${truckCount}).` });
    }

    // Resolve "own_fleet" shortcut
    let transporterCompanyId = input.transporterCompanyId;
    if (transporterCompanyId === OWN_FLEET_SHORTCUT) {
      transporterCompanyId = user.activeCompanyId || user.companyId;
    }

    const transporter = await this.prisma.company.findUnique({
      where: { id: transporterCompanyId },
      select: { name: true, hasInternalFleet: true },
    });
    if (!transporter) return JSON.stringify({ error: 'Empresa transportista no encontrada.' });

    const userCompanyId = user.activeCompanyId || user.companyId;
    const isOwnFleet = transporter.hasInternalFleet && transporterCompanyId === userCompanyId;
    const displayName = isOwnFleet ? `${transporter.name} (Flota interna)` : transporter.name;

    // Resolve plantCompanyId for the assignment call (reuse companyType from above)
    let plantCompanyId: string;
    if (AiService.hasType(companyType, 'plant')) {
      plantCompanyId = this.resolvePlantCompanyId(user);
    } else {
      plantCompanyId = freight.destCompanyId || userCompanyId;
    }

    const nextTrip = assigned + 1;
    const remaining = truckCount - assigned - 1;

    return this.stageAction(session, 'assign_truck_to_freight', {
      freightId: freight.id, code: freight.code,
      transporterCompanyId,
      transporterName: displayName,
      truckId: input.truckId || null,
      driverId: input.driverId || null,
      tons: input.tons || null,
      plantCompanyId,
      nextTripNumber: nextTrip,
      remaining,
      truckCount,
      assignedTruckCount: assigned,
    }, `Asignar ${displayName} a viaje #${nextTrip} de ${freight.code} (quedan ${remaining} por asignar)`);
  }

  // ======================== TEAM MANAGEMENT TOOLS =========================

  // ---- list_company_users ----
  private async toolListCompanyUsers(user: any, session: any): Promise<string> {
    // Scope to active company only — don't leak PII from other companies
    const companyIds: string[] = [];
    if (user.activeCompanyId) companyIds.push(user.activeCompanyId);
    else if (user.companyId) companyIds.push(user.companyId);

    if (companyIds.length === 0) {
      return JSON.stringify({ error: 'No se encontró su empresa.', users: [] });
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, active: true } },
        company: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const ROLE_LABEL: Record<string, string> = { admin: 'Admin', operator: 'Operador', chofer: 'Chofer' };
    const activeUsers = memberships.filter(m => m.user.active);

    if (activeUsers.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay usuarios activos.' });
    }

    const items = activeUsers.map(m => ({
      id: `user:${m.user.id}`,
      title: (m.user.name || 'Sin nombre').slice(0, 24),
      description: `${ROLE_LABEL[m.role] || m.role} · ${m.company.name}`.slice(0, 72),
    }));

    const usersData = activeUsers.map(m => ({
      id: m.user.id, name: m.user.name,
      role: m.role, company: m.company.name,
    }));

    return this.storePendingSelection(session, items, {
      headerText: '👤 Usuarios de la empresa.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver usuarios',
      sectionTitle: 'USUARIOS',
    }, 'user_info', { users: usersData });
  }

  // ---- list_drivers ----
  private async toolListDrivers(user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const drivers = await this.trucksService.listDrivers(synUser);

    if ((drivers as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay choferes registrados.' });
    }

    const driverIds = (drivers as any[]).map(d => d.id);
    const trucks = await this.prisma.truck.findMany({
      where: { assignedUserId: { in: driverIds }, active: true },
      select: { assignedUserId: true, plate: true, model: true },
    });
    const truckByDriver = new Map(trucks.map(t => [t.assignedUserId, t]));

    const items = (drivers as any[]).map((d: any) => {
      const truck = truckByDriver.get(d.id);
      const truckLabel = truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : 'Sin camión';
      return {
        id: `driver:${d.id}`,
        title: (d.name || 'Sin nombre').slice(0, 24),
        description: truckLabel.slice(0, 72),
      };
    });

    const driversData = (drivers as any[]).map((d: any) => {
      const truck = truckByDriver.get(d.id);
      return {
        id: d.id, name: d.name,
        assignedTruck: truck ? (truck.model ? `${truck.plate} (${truck.model})` : truck.plate) : null,
      };
    });

    return this.storePendingSelection(session, items, {
      headerText: '👤 Choferes registrados.\nSeleccione uno para ver detalles:',
      listButtonLabel: 'Ver choferes',
      sectionTitle: 'CHOFERES',
    }, 'driver_info', { drivers: driversData });
  }

  // ======================== ACCESS MANAGEMENT TOOLS ========================

  // ---- update_user_role ----
  private async toolUpdateUserRole(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    }
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden cambiar roles.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede cambiar su propio rol.' });
    }

    return this.stageAction(session, 'update_user_role', {
      membershipId: membership.id,
      companyId: membership.companyId,
      targetUserId: membership.user.id,
      userName: membership.user.name,
      newRole: input.newRole,
    }, `Cambiar rol de "${membership.user.name}" a ${input.newRole}`, user);
  }

  // ---- deactivate_user ----
  private async toolDeactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    }
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden desactivar usuarios.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario activo "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede desactivarse a sí mismo.' });
    }

    return this.stageAction(session, 'deactivate_user', {
      membershipId: membership.id,
      companyId,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Desactivar usuario "${membership.user.name}" de su empresa`, user);
  }

  // ---- switch_company ----
  private async toolSwitchCompany(input: any, user: any, session: any): Promise<string> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    if (memberships.length <= 1) {
      return JSON.stringify({ error: 'Solo pertenece a una empresa. No es posible cambiar.' });
    }

    const TYPE_LABELS: Record<string, string> = {
      producer: 'Productor', plant: 'Planta', transporter: 'Transportista',
    };

    // If no companyId, send interactive selection to user
    if (!input.companyId) {
      const activeCompanyId = user.activeCompanyId || user.companyId;
      const companies = memberships.map((m: any) => ({
        id: m.companyId,
        name: m.company?.name || 'Empresa',
        type: TYPE_LABELS[m.company?.type] || m.company?.type || 'Desconocido',
        active: m.companyId === activeCompanyId,
      }));

      // Use storePendingSelection (side-effects pattern, merged by chat())
      return this.storePendingSelection(
        session,
        companies.map(c => ({
          id: `selco:${c.id}`,
          title: c.name,
          description: `${c.type}${c.active ? ' (actual)' : ''}`,
        })),
        {
          headerText: 'Seleccione la empresa con la que desea operar:',
          listButtonLabel: 'Ver empresas',
          sectionTitle: 'Sus empresas',
        },
        'company_selection',
        { companies },
      );
    }

    // Validate membership — re-fetch from DB to prevent stale check
    const freshMembership = await this.prisma.userCompany.findFirst({
      where: { userId: user.id, companyId: input.companyId, active: true },
      include: { company: { select: { name: true, type: true } } },
    });
    if (!freshMembership) {
      return JSON.stringify({ error: 'No pertenece a esa empresa.' });
    }

    // NOTE: Do NOT update activeCompanyId in DB — WhatsApp company selection is
    // session-scoped to avoid desyncing the web app. The selected company is stored
    // in flowState.selectedCompanyId and read by freight creation tools.
    const oldCompanyId = user.activeCompanyId || user.companyId;

    // Audit log (fire-and-forget)
    this.prisma.auditLog.create({
      data: {
        entityType: 'user', entityId: user.id,
        action: 'whatsapp_company_selected',
        fromValue: oldCompanyId || undefined,
        toValue: input.companyId, userId: user.id,
        metadata: { source: 'whatsapp_ai', sessionScoped: true },
      },
    }).catch((err: any) => this.logger.warn(`Audit log failed: ${err.message}`));

    // Use side-effects (merged by chat()) — _clearAiMessages flag tells chat() to use [] instead of trimmedMessages
    const effects = this._chatSideEffects.get(session.id) || {};
    effects._clearAiMessages = true;
    effects.companyConfirmed = true;
    effects.selectedCompanyId = input.companyId;
    effects.pendingAction = undefined;
    effects.pendingFreight = undefined;
    effects.activeContext = undefined;
    effects._pendingSelection = undefined;
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(session.id, effects);

    const companyName = (freshMembership as any).company?.name || 'Empresa';
    const companyType = TYPE_LABELS[(freshMembership as any).company?.type] || (freshMembership as any).company?.type || '';

    return JSON.stringify({
      status: 'switched',
      companyName,
      companyType,
      message: `Empresa activa cambiada a "${companyName}" (${companyType}). Todas las operaciones se realizarán con esta empresa.`,
    });
  }

  // ======================== MESSAGE PREPROCESSING ========================

  /** Clean audio transcription: strip filler words, normalize whitespace, expand spelled-out letters */
  private preprocessMessage(text: string): string {
    let clean = text
      .replace(AUDIO_FILLERS, ' ')       // Strip filler words from voice
      .replace(/\bv\s+corta\b/gi, 'v')  // Whisper spells out "v corta" → v
      .replace(/\bb\s+larga\b/gi, 'b')  // Whisper spells out "b larga" → b
      .replace(/\bese\s+de\b/gi, 's')   // "ese de" → s
      .replace(/\bdoble\s+ele\b/gi, 'll') // "doble ele" → ll
      .replace(/\s{2,}/g, ' ')           // Collapse multiple spaces
      .replace(/^[\s,.:;]+/, '')         // Trim leading punctuation artifacts
      .trim();
    return clean || text.trim();         // If cleaning removed everything, keep original
  }

  // ======================== RESPONSE VALIDATION ===========================

  /** Post-process AI response: strip UUIDs, enforce length, quality check */
  private validateResponse(text: string): string {
    // 1. Strip UUID patterns that may have leaked through
    //    BUT preserve UUIDs inside URLs (e.g. pick-location?token=UUID)
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    let clean = text.replace(UUID_RE, (match, offset) => {
      const before = text.slice(Math.max(0, offset - 80), offset);
      if (/https?:\/\/\S*$/i.test(before)) return match; // UUID is part of a URL
      return '[ID interno]';
    });

    // 2. Enforce max length for WhatsApp-friendly responses
    //    Exception: freight lists (contain freight codes) are allowed to be longer
    if (clean.length > MAX_RESPONSE_CHARS && !/F\d{2}-[A-Z]{3}\.\d{4}|FLT-\d{4,}/i.test(clean)) {
      // Find a natural break point (newline or sentence end)
      const lineBreak = clean.lastIndexOf('\n', MAX_RESPONSE_CHARS);
      if (lineBreak > MAX_RESPONSE_CHARS * 0.5) {
        clean = clean.slice(0, lineBreak);
      } else {
        const sentenceBreak = clean.lastIndexOf('. ', MAX_RESPONSE_CHARS);
        if (sentenceBreak > MAX_RESPONSE_CHARS * 0.5) {
          clean = clean.slice(0, sentenceBreak + 1);
        } else {
          clean = clean.slice(0, MAX_RESPONSE_CHARS);
        }
      }
    }

    // 3. Strip excessive trailing whitespace/newlines
    return clean.replace(/\n{3,}/g, '\n\n').trim();
  }

  // ======================== SMART HISTORY MANAGEMENT =====================

  /** Trim message history intelligently: keep recent + preserve tool results */
  private smartTrimHistory(messages: any[]): any[] {
    if (messages.length <= MAX_HISTORY) return messages;

    // Simple trim: keep last MAX_HISTORY messages
    let trimmed = messages.slice(-MAX_HISTORY);

    // Ensure we don't start with an orphaned tool_result
    // (each tool_result needs a preceding tool_use from the assistant)
    while (trimmed.length > 0) {
      const first = trimmed[0];
      const hasToolResult = first.role === 'user' && Array.isArray(first.content) &&
        first.content.some((b: any) => b.type === 'tool_result');
      if (hasToolResult) {
        trimmed = trimmed.slice(1); // drop the orphan
      } else {
        break;
      }
    }

    // Also ensure we don't end with a tool_use without its tool_result
    while (trimmed.length > 0) {
      const last = trimmed[trimmed.length - 1];
      const hasToolUse = last.role === 'assistant' && Array.isArray(last.content) &&
        last.content.some((b: any) => b.type === 'tool_use');
      if (hasToolUse) {
        trimmed = trimmed.slice(0, -1); // drop trailing tool_use without result
      } else {
        break;
      }
    }

    // Guardrail: if trimming removed everything, keep at least the last user message
    if (trimmed.length === 0 && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user' && (!Array.isArray(m.content) || !m.content.some((b: any) => b.type === 'tool_result')));
      if (lastUserMsg) return [lastUserMsg];
      return messages.slice(-1);
    }

    return trimmed;
  }

  // ======================== ACTIVE CONTEXT ==============================

  /** Accumulate active context update — merged by chat() into single session write */
  private updateActiveContext(sessionId: string, context: Record<string, any>): void {
    const effects = this._chatSideEffects.get(sessionId) || {};
    effects.activeContext = {
      ...(effects.activeContext || {}),
      ...context,
      updatedAt: new Date().toISOString(),
    };
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(sessionId, effects);
  }

  // ======================== GENERIC CONFIRMATION ========================

  /** Stage an action for user confirmation — accumulates in _chatSideEffects (merged by chat()) */
  private stageAction(
    session: any,
    tool: string,
    params: Record<string, any>,
    summary: string,
    user?: any,
  ): string {
    const effects = this._chatSideEffects.get(session.id) || {};
    // Always record stagedCompanyId — try params.actionSynUser as fallback for company context
    const stagedCompanyId = user?.activeCompanyId || user?.companyId || params?.actionSynUser?.companyId || null;
    effects.pendingAction = { tool, params, summary, createdAt: Date.now(), stagedCompanyId };
    effects._pendingButtons = [
      { id: 'ai_confirm', title: 'CONFIRMAR' },
      { id: 'ai_cancel', title: 'CANCELAR' },
    ];
    effects._ts = effects._ts || Date.now(); this._chatSideEffects.set(session.id, effects);

    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      IMPORTANT: 'La acción NO fue ejecutada todavía. Presente el resumen y consulte al usuario si confirma. Se enviarán botones CONFIRMAR/CANCELAR automáticamente.',
    });
  }

  // ======================== NEW TOOLS: FEATURE PARITY ===================

  // ---- authorize_freight ----
  private async toolAuthorizeFreight(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden autorizar fletes.' });
    }
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    if (freight.status !== 'assigned') return JSON.stringify({ error: `Solo se puede autorizar en estado "assigned". Estado actual: "${freight.status}".` });
    if (!freight.useOwnFleet) return JSON.stringify({ error: 'Solo se puede autorizar fletes con flota propia.' });
    return this.stageAction(session, 'authorize_freight', { freightId: freight.id, code: freight.code }, `Autorizar flete ${freight.code} (flota propia)`, user);
  }

  // ---- approve_pending_change ----
  private async toolApprovePendingChange(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const userCompanyId = user.activeCompanyId || user.companyId;

    const pendingChanges = await this.prisma.freightPendingChange.findMany({
      where: { freightId: freight.id, status: 'pending' },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingChanges.length === 0) return JSON.stringify({ error: `El flete ${freight.code} no tiene cambios pendientes de aprobación.` });

    let change: any;
    if (input.changeId) {
      change = pendingChanges.find((c: any) => c.id === input.changeId);
      if (!change) return JSON.stringify({ error: `No se encontró el cambio pendiente ${input.changeId}.` });
    } else if (pendingChanges.length === 1) {
      change = pendingChanges[0];
    } else {
      const list = pendingChanges.map((c: any) => `- ${c.id}: ${c.changeType} (solicitado por ${c.requestedBy?.name || 'desconocido'})`).join('\n');
      return JSON.stringify({ error: `El flete tiene ${pendingChanges.length} cambios pendientes. Indique el changeId:\n${list}` });
    }

    if (change.approverCompanyId !== userCompanyId) {
      return JSON.stringify({ error: 'Su empresa no es la aprobadora de este cambio.' });
    }

    const summary = `Aprobar cambio "${change.changeType}" en flete ${freight.code} (solicitado por ${change.requestedBy?.name || 'desconocido'})`;
    return this.stageAction(session, 'approve_pending_change', { freightId: freight.id, changeId: change.id, code: freight.code }, summary);
  }

  // ---- reject_pending_change ----
  private async toolRejectPendingChange(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const userCompanyId = user.activeCompanyId || user.companyId;

    const pendingChanges = await this.prisma.freightPendingChange.findMany({
      where: { freightId: freight.id, status: 'pending' },
      include: { requestedBy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingChanges.length === 0) return JSON.stringify({ error: `El flete ${freight.code} no tiene cambios pendientes.` });

    let change: any;
    if (input.changeId) {
      change = pendingChanges.find((c: any) => c.id === input.changeId);
      if (!change) return JSON.stringify({ error: `No se encontró el cambio pendiente ${input.changeId}.` });
    } else if (pendingChanges.length === 1) {
      change = pendingChanges[0];
    } else {
      const list = pendingChanges.map((c: any) => `- ${c.id}: ${c.changeType} (solicitado por ${c.requestedBy?.name || 'desconocido'})`).join('\n');
      return JSON.stringify({ error: `El flete tiene ${pendingChanges.length} cambios pendientes. Indique el changeId:\n${list}` });
    }

    if (change.approverCompanyId !== userCompanyId) {
      return JSON.stringify({ error: 'Su empresa no es la aprobadora de este cambio.' });
    }

    const summary = `Rechazar cambio "${change.changeType}" en flete ${freight.code}${input.reason ? ` — Motivo: ${input.reason}` : ''}`;
    return this.stageAction(session, 'reject_pending_change', { freightId: freight.id, changeId: change.id, code: freight.code, reason: input.reason }, summary);
  }

  // ---- resolveAssignment helper ----
  private async resolveAssignment(code: string, assignmentId: string | undefined, user: any): Promise<{ freight?: any; assignment?: any; error?: string }> {
    const result = await this.resolveFreightWithAccess(code, user);
    if (result.error) return { error: result.error };
    const freight = result.freight;
    if (!freight.assignments || freight.assignments.length === 0) return { error: `El flete ${code} no tiene asignaciones activas.` };
    if (assignmentId) {
      const a = freight.assignments.find((a: any) => a.id === assignmentId);
      if (!a) return { error: `No se encontró la asignación ${assignmentId} en el flete ${code}.` };
      return { freight, assignment: a };
    }
    if (freight.assignments.length === 1) return { freight, assignment: freight.assignments[0] };
    const list = freight.assignments.map((a: any) => `- ${a.id}: ${a.truck?.plate || 'sin camión'} (${a.driver?.name || 'sin chofer'}) — ${a.tripStatus || 'sin estado'}`).join('\n');
    return { error: `El flete ${code} tiene ${freight.assignments.length} viajes. Indique el assignmentId. Viajes:\n${list}` };
  }

  // ---- respond_trip ----
  private async toolRespondTrip(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'pending') {
      return JSON.stringify({ error: `El viaje ya está en estado "${assignment.tripStatus}". Solo se puede aceptar/rechazar en "pending".` });
    }
    if (input.action === 'rejected' && !input.reason) {
      return JSON.stringify({ error: 'Para rechazar un viaje debe indicar un motivo (reason).' });
    }
    const label = input.action === 'accepted' ? 'Aceptar' : 'Rechazar';
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    const summary = `${label} viaje de ${freight.code} (${tripInfo})${input.action === 'rejected' ? ` — Motivo: ${input.reason}` : ''}`;
    return this.stageAction(session, 'respond_trip', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code,
      action: input.action, reason: input.reason, tripInfo,
    }, summary);
  }

  // ---- start_trip ----
  private async toolStartTrip(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'accepted') {
      return JSON.stringify({ error: `El viaje debe estar "accepted" para iniciarlo. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'start_trip', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo,
    }, `Iniciar viaje de ${freight.code} (${tripInfo})`);
  }

  // ---- confirm_trip_loaded ----
  private async toolConfirmTripLoaded(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'in_progress') {
      return JSON.stringify({ error: `El viaje debe estar "in_progress" para confirmar carga. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    const tonsNote = input.loadedTons ? ` — ${input.loadedTons} toneladas` : '';
    return this.stageAction(session, 'confirm_trip_loaded', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo, loadedTons: input.loadedTons,
    }, `Confirmar carga de viaje ${freight.code} (${tripInfo})${tonsNote}`);
  }

  // ---- confirm_trip_finished ----
  private async toolConfirmTripFinished(input: any, user: any, session: any): Promise<string> {
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (assignment.tripStatus !== 'loaded') {
      return JSON.stringify({ error: `El viaje debe estar "loaded" para confirmar entrega. Estado actual: "${assignment.tripStatus}".` });
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'confirm_trip_finished', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, tripInfo,
    }, `Confirmar entrega de viaje ${freight.code} (${tripInfo})`);
  }

  // ---- cancel_assignment ----
  private async toolCancelAssignment(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden cancelar asignaciones.' });
    }
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'cancel_assignment', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, reason: input.reason, tripInfo,
    }, `Cancelar asignación de ${freight.code} (${tripInfo}) — Motivo: ${input.reason}`);
  }

  // ---- update_assignment ----
  private async toolUpdateAssignment(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden editar asignaciones.' });
    }
    const res = await this.resolveAssignment(input.code, input.assignmentId, user);
    if (res.error) return JSON.stringify({ error: res.error });
    const { freight, assignment } = res;
    if (!['pending', 'accepted'].includes(assignment.tripStatus || '')) {
      return JSON.stringify({ error: `Solo se pueden editar viajes en estado "pending" o "accepted". Estado actual: "${assignment.tripStatus}".` });
    }
    const changes: string[] = [];
    const dto: any = {};
    if (input.transporterCompanyId) { dto.transportCompanyId = input.transporterCompanyId; changes.push('transportista'); }
    if (input.truckId) { dto.truckId = input.truckId; changes.push('camión'); }
    if (input.driverId) { dto.driverId = input.driverId; changes.push('chofer'); }
    if (input.tons !== undefined) { dto.tons = input.tons; changes.push(`toneladas: ${input.tons}`); }
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios. Indique al menos uno: transporterCompanyId, truckId, driverId o tons.' });
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'update_assignment', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, dto, tripInfo,
      plantCompanyId: this.resolvePlantCompanyId(user),
    }, `Editar viaje de ${freight.code} (${tripInfo}): ${changes.join(', ')}`);
  }

  // ---- create_driver ----
  private async toolCreateDriver(input: any, user: any, session: any): Promise<string> {
    if (!input.name?.trim()) return JSON.stringify({ error: 'El nombre del chofer es obligatorio.' });
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden registrar choferes.' });
    }
    const summary = `Registrar chofer: ${input.name}${input.phone ? ` (${input.phone})` : ''}`;
    return this.stageAction(session, 'create_driver', {
      name: input.name.trim(), phone: input.phone?.trim(), companyId,
    }, summary);
  }

  // ---- update_profile ----
  private async toolUpdateProfile(input: any, user: any, session: any): Promise<string> {
    // Block email/phone changes via WhatsApp for security — require web
    if (input.email || input.phone) {
      return JSON.stringify({ error: 'El email y teléfono solo se pueden cambiar desde la plataforma web por seguridad.' });
    }
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios. Indique el nombre que desea actualizar.' });
    return this.stageAction(session, 'update_profile', {
      userId: user.id, name: input.name,
    }, `Editar perfil: ${changes.join(', ')}`, user);
  }

  // ---- generate_batch_report_link ----
  private async toolGenerateBatchReportLink(input: any, _user: any): Promise<string> {
    const params = new URLSearchParams();
    if (input.status) params.set('status', input.status);
    if (input.dateFrom) params.set('from', input.dateFrom);
    if (input.dateTo) params.set('to', input.dateTo);
    const qs = params.toString();
    const url = `${APP_URL}/reports${qs ? `?${qs}` : ''}`;
    return JSON.stringify({ url, message: `Enlace a reportes: ${url}\nDesde ahí puede descargar PDF o Excel con los filtros aplicados.` });
  }

  // ======================== HELPERS =====================================

  /** Resolve freight by code WITH access control — returns { freight } or { error } */
  private async resolveFreightWithAccess(code: string, user: any): Promise<{ freight?: any; error?: string }> {
    if (!code || typeof code !== 'string') {
      return { error: 'Código de flete requerido.' };
    }

    // Pre-compute user companies for access control (used by both exact and fuzzy paths)
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).filter((m: any) => m.active).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);

    // Try exact match first
    let freight: any = await this.findFreightByCode(code.toUpperCase());

    // Fuzzy fallback: try partial code match (e.g. "1822" matches "F26-LCP.1822")
    // Scoped to user's companies to prevent freight code enumeration
    if (!freight) {
      const sanitized = code.replace(/[^a-zA-Z0-9.\-]/g, '').toUpperCase();
      if (sanitized.length >= 3) {
        const candidates = await this.findFreightsByCodePattern(sanitized, allUserCompanies, user.id);
        if (candidates.length === 1) {
          freight = candidates[0];
        } else if (candidates.length > 1) {
          const codes = candidates.map((c: any) => c.code).join(', ');
          return { error: `Se encontraron varios fletes que coinciden con "${code}": ${codes}. Indique el código completo.` };
        }
      }
    }

    // Unified error message prevents freight code enumeration
    const ACCESS_DENIED = `No se encontró el flete ${code} o no tiene acceso.`;
    if (!freight) return { error: ACCESS_DENIED };

    const freightCompanies = [
      freight.originCompanyId, freight.destCompanyId,
      ...(freight.assignments || []).map((a: any) => a.transportCompanyId),
    ].filter(Boolean);
    const isDriver = (freight.assignments || []).some((a: any) => a.driverId === user.id);
    const isCompanyUser = allUserCompanies.some((c: string) => freightCompanies.includes(c));
    if (!isDriver && !isCompanyUser) {
      return { error: ACCESS_DENIED };
    }
    // Drivers without company access only see their own assignment
    if (isDriver && !isCompanyUser) {
      freight.assignments = (freight.assignments || []).filter((a: any) => a.driverId === user.id);
    }
    return { freight };
  }

  /** Find freight by exact code — single source of truth for the select shape */
  private async findFreightByCode(code: string) {
    return this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
    });
  }

  /** Find freights by partial code pattern — scoped to user's companies + driver assignments */
  private async findFreightsByCodePattern(pattern: string, userCompanyIds: string[], userId: string) {
    return this.prisma.freight.findMany({
      where: {
        code: { contains: pattern, mode: 'insensitive' },
        OR: [
          { originCompanyId: { in: userCompanyIds } },
          { destCompanyId: { in: userCompanyIds } },
          { assignments: { some: { transportCompanyId: { in: userCompanyIds } } } },
          { assignments: { some: { driverId: userId } } },
        ],
      },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
      take: 5,
    });
  }

  // ---- ocr_analyze ----
  private async toolOcrAnalyze(input: any, user: any, session: any): Promise<string> {
    const url = input.url;
    if (!url) {
      // Try to use pendingDocument URL from fresh session (not stale object)
      const freshSession = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
      const state = (freshSession?.flowState as any) || {};
      const pending = state.pendingDocument;
      if (!pending?.url) {
        return JSON.stringify({ error: 'Se necesita la URL del documento. Pedile al usuario que envíe una foto primero.' });
      }
      input.url = pending.url;
    }
    try {
      const result = await this.ocrService.analyzeFromUrl(input.url, input.docType || 'general');
      return JSON.stringify(result);
    } catch (e: any) {
      this.logger.warn(`OCR analyze failed: ${e.message}`);
      return JSON.stringify({ error: 'Error al analizar el documento. Intentá de nuevo o con otra imagen.' });
    }
  }

  /**
   * Resolve the company type for the ACTIVE company.
   * If the user has multiple memberships, prioritize the active company's type
   * so the prompt and tool filter reflect what the user is currently operating as.
   */
  private resolveCompanyType(user: any): string {
    const activeCoId = user.activeCompanyId || user.companyId;

    // 1. If we know the active company, find its type from memberships
    if (activeCoId && user.memberships?.length > 0) {
      const activeMem = user.memberships.find((m: any) => m.companyId === activeCoId);
      if (activeMem?.company?.type) return activeMem.company.type;
    }

    // 2. Fallback: userTypes (legacy)
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    if (userTypes.length > 0) return userTypes.join(', ');

    // 3. Fallback: direct company
    if (user.company?.type) return user.company.type;

    // 4. Fallback: first membership
    if (user.memberships?.length > 0) {
      const firstType = user.memberships.find((m: any) => m.company?.type)?.company?.type;
      if (firstType) return firstType;
    }
    return 'unknown';
  }

  private static isProducerMembership(m: any): boolean {
    return m.company?.type === 'producer' ||
      (Array.isArray(m.company?.types) && m.company.types.includes('producer'));
  }

  /**
   * Resolve producer company for a specific target companyId.
   * Used when the WhatsApp session has a selectedCompanyId that should take priority.
   * Falls back to generic resolution if the target isn't a valid producer.
   */
  private resolveProducerCompanyIdForCompany(user: any, targetCompanyId: string): string | null {
    if (user.memberships?.length > 0) {
      const targetMem = user.memberships.find((m: any) => m.companyId === targetCompanyId && AiService.isProducerMembership(m));
      if (targetMem) return targetMem.companyId;
    }
    // Target isn't a producer — fall back to generic resolution
    return this.resolveProducerCompanyId(user);
  }

  private resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      // Prioritize activeCompanyId — the company the user explicitly selected
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && AiService.isProducerMembership(m));
        if (activeMem) return activeMem.companyId;
      }
      // Fallback: first producer membership
      const pm = user.memberships.find(AiService.isProducerMembership);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) {
      return companyByType.producer;
    }
    if (user.company?.type === 'producer') return user.companyId;
    return null;
  }

  private resolvePlantCompanyId(user: any): string | null {
    const isPlant = (m: any) =>
      m.company?.type === 'plant' ||
      (Array.isArray(m.company?.types) && m.company.types.includes('plant'));

    if (user.memberships?.length > 0) {
      // Prioritize activeCompanyId
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isPlant(m));
        if (activeMem) return activeMem.companyId;
      }
      // Fallback: first plant membership
      const pm = user.memberships.find(isPlant);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('plant') && companyByType.plant) {
      return companyByType.plant;
    }
    if (user.company?.type === 'plant') return user.companyId;
    // No fallback — only plant companies allowed
    return null;
  }

  /** Exact match for company type in comma-separated string (prevents substring false positives) */
  private static hasType(companyType: string, type: string): boolean {
    return companyType === type || companyType.split(',').some(t => t.trim() === type);
  }

  /** Check if caller is admin/gerente — scoped to specific company when provided */
  private isCallerAdminForCompany(user: any, companyId?: string): boolean {
    if (user.isSuperAdmin || user.role === 'platform_admin') return true;
    if (!companyId) {
      // Fallback: check any active membership
      const memberRoles = (user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.role);
      return [user.role || '', ...memberRoles].some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r));
    }
    // Scoped: check membership for the specific company
    const membership = (user.memberships || []).find((m: any) => m.companyId === companyId && m.active);
    if (!membership) return false;
    return ['admin', 'gerente'].includes(membership.role);
  }

  /** Check if caller has access to the given company (any role) */
  private canAccessCompany(user: any, synUser: any, companyId: string): boolean {
    const ids = [synUser.companyId, ...(user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.companyId)].filter(Boolean);
    return ids.includes(companyId);
  }

  private buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUser(dbUser);
  }

  // ======================== NEW TOOL HANDLERS ==============================

  // ---- delete_document ----
  private async toolDeleteDocument(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const doc = await this.prisma.freightDocument.findFirst({
      where: { id: input.documentId, freightId: freight.id },
      select: { id: true, name: true, type: true },
    });
    if (!doc) return JSON.stringify({ error: `No se encontró el documento ${input.documentId} en el flete ${freight.code}.` });
    return this.stageAction(session, 'delete_document', {
      freightId: freight.id, documentId: doc.id, code: freight.code, docName: doc.name || doc.type,
    }, `Eliminar documento "${doc.name || doc.type}" del flete ${freight.code}`, user);
  }

  // ---- save_ocr_data ----
  private async toolSaveOcrData(input: any, user: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    const doc = await this.prisma.freightDocument.findFirst({
      where: { id: input.documentId, freightId: freight.id },
      select: { id: true, name: true },
    });
    if (!doc) return JSON.stringify({ error: `No se encontró el documento en el flete ${freight.code}.` });
    if (!input.ocrData || typeof input.ocrData !== 'object') return JSON.stringify({ error: 'ocrData debe ser un objeto JSON.' });
    return this.stageAction(session, 'save_ocr_data', {
      freightId: freight.id, documentId: doc.id, code: freight.code, ocrData: input.ocrData, docName: doc.name,
    }, `Guardar datos OCR en documento "${doc.name}" del flete ${freight.code}`, user);
  }

  // ---- deactivate_truck ----
  private async toolDeactivateTruck(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: input.truckId, companyId, active: true },
      select: { id: true, plate: true, model: true },
    });
    if (!truck) return JSON.stringify({ error: 'Camión no encontrado o no pertenece a su empresa.' });
    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { truckId: truck.id, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) return JSON.stringify({ error: `El camión tiene ${activeAssignments} viaje(s) activo(s). Cancele o finalice antes de desactivar.` });
    const display = truck.model ? `${truck.plate} (${truck.model})` : truck.plate;
    return this.stageAction(session, 'deactivate_truck', { truckId: truck.id, plate: truck.plate }, `Desactivar camión ${display}`, user);
  }

  // ---- update_truck ----
  private async toolUpdateTruck(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar camiones.' });
    }
    const companyId = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: input.truckId, companyId, active: true },
      select: { id: true, plate: true, model: true, brand: true, capacity: true },
    });
    if (!truck) return JSON.stringify({ error: 'Camión no encontrado o no pertenece a su empresa.' });
    const changes: string[] = [];
    if (input.plate) {
      const normalized = input.plate.trim().toUpperCase();
      const dup = await this.prisma.truck.findFirst({ where: { plate: normalized, id: { not: truck.id }, active: true } });
      if (dup) return JSON.stringify({ error: `La patente ${normalized} ya está registrada en otro camión.` });
      changes.push(`patente: ${truck.plate} → ${normalized}`);
    }
    if (input.brand) changes.push(`marca: ${input.brand}`);
    if (input.model) changes.push(`modelo: ${input.model}`);
    if (input.capacity) changes.push(`capacidad: ${input.capacity} ton`);
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_truck', {
      truckId: truck.id, plate: input.plate?.trim().toUpperCase(), brand: input.brand, model: input.model, capacity: input.capacity,
    }, `Editar camión ${truck.plate}: ${changes.join(', ')}`, user);
  }

  // ---- deactivate_driver ----
  private async toolDeactivateDriver(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    const membership = await this.prisma.userCompany.findFirst({
      where: { userId: input.driverId, companyId, role: 'chofer', active: true },
      include: { user: { select: { name: true } } },
    });
    if (!membership) return JSON.stringify({ error: 'Chofer no encontrado en su empresa.' });
    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { driverId: input.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) return JSON.stringify({ error: `El chofer tiene ${activeAssignments} viaje(s) activo(s). Cancele o finalice antes de desactivar.` });
    return this.stageAction(session, 'deactivate_driver', {
      driverId: input.driverId, membershipId: membership.id, driverName: (membership as any).user?.name,
    }, `Desactivar chofer ${(membership as any).user?.name || input.driverId}`, user);
  }

  // ---- list_enabled_plants ----
  private async toolListEnabledPlants(user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      include: { plantCompany: { select: { id: true, name: true, address: true } } },
      orderBy: { createdAt: 'desc' },
    });
    if (accesses.length === 0) return JSON.stringify({ total: 0, message: 'No hay plantas habilitadas.' });
    const plants = accesses.map((a: any) => ({
      id: a.plantCompany?.id, name: a.plantCompany?.name, address: a.plantCompany?.address,
    }));
    return JSON.stringify({ total: plants.length, plants });
  }

  // ---- list_enabled_producers ----
  private async toolListEnabledProducers(user: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden ver productores habilitados.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    if (!plantCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa planta.' });
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { plantCompanyId, active: true },
      include: {
        producerCompany: { select: { id: true, name: true, email: true } },
        producerUser: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (accesses.length === 0) return JSON.stringify({ total: 0, message: 'No hay productores habilitados.' });
    const producers = accesses.map((a: any) => ({
      accessId: a.id,
      companyName: a.producerCompany?.name, companyId: a.producerCompany?.id,
      userName: a.producerUser?.name, userPhone: a.producerUser?.phone,
    }));
    return JSON.stringify({ total: producers.length, producers });
  }

  // ---- grant_producer_access ----
  private async toolGrantProducerAccess(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden habilitar productores.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    if (!plantCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa planta.' });
    const producerCo = await this.prisma.company.findFirst({
      where: { id: input.producerCompanyId, active: true },
      select: { id: true, name: true, type: true },
    });
    if (!producerCo) return JSON.stringify({ error: 'Empresa productora no encontrada.' });
    if (producerCo.type !== 'producer' && producerCo.type !== 'transporter') return JSON.stringify({ error: 'La empresa debe ser de tipo productor o transportista.' });
    return this.stageAction(session, 'grant_producer_access', {
      plantCompanyId, producerCompanyId: input.producerCompanyId, producerUserId: input.producerUserId,
      producerName: producerCo.name,
    }, `Habilitar productor "${producerCo.name}" en la planta`, user);
  }

  // ---- revoke_producer_access ----
  private async toolRevokeProducerAccess(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden revocar accesos.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    const access = await this.prisma.plantProducerAccess.findFirst({
      where: { id: input.accessId, active: true, ...(plantCompanyId ? { plantCompanyId } : {}) },
      include: { producerCompany: { select: { name: true } } },
    });
    if (!access) return JSON.stringify({ error: 'Acceso no encontrado.' });
    return this.stageAction(session, 'revoke_producer_access', {
      accessId: input.accessId, producerName: (access as any).producerCompany?.name,
    }, `Revocar acceso del productor "${(access as any).producerCompany?.name}"`, user);
  }

  // ---- list_branches ----
  private async toolListBranches(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    const branches = await this.prisma.branch.findMany({
      where: { companyId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true, reference: true },
    });
    if (branches.length === 0) return JSON.stringify({ total: 0, message: 'No hay sucursales registradas.' });
    return JSON.stringify({ total: branches.length, branches });
  }

  // ---- create_branch ----
  private async toolCreateBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden crear sucursales.' });
    }
    if (!input.name?.trim()) return JSON.stringify({ error: 'El nombre de la sucursal es obligatorio.' });
    const companyId = user.activeCompanyId || user.companyId;
    return this.stageAction(session, 'create_branch', {
      companyId, name: input.name.trim(), address: input.address, reference: input.reference, lat: input.lat, lng: input.lng,
    }, `Crear sucursal "${input.name.trim()}"`, user);
  }

  // ---- update_branch ----
  private async toolUpdateBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar sucursales.' });
    }
    const companyId = user.activeCompanyId || user.companyId;
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, active: true },
      select: { id: true, name: true },
    });
    if (!branch) return JSON.stringify({ error: 'Sucursal no encontrada.' });
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.address) changes.push(`dirección: ${input.address}`);
    if (input.reference) changes.push(`referencia: ${input.reference}`);
    if (input.lat != null || input.lng != null) changes.push('ubicación');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_branch', {
      branchId: branch.id, name: input.name, address: input.address, reference: input.reference, lat: input.lat, lng: input.lng,
    }, `Editar sucursal "${branch.name}": ${changes.join(', ')}`, user);
  }

  // ---- delete_branch ----
  private async toolDeleteBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden eliminar sucursales.' });
    }
    const companyId = user.activeCompanyId || user.companyId;
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, active: true },
      select: { id: true, name: true },
    });
    if (!branch) return JSON.stringify({ error: 'Sucursal no encontrada.' });
    return this.stageAction(session, 'delete_branch', { branchId: branch.id, branchName: branch.name },
      `Desactivar sucursal "${branch.name}"`, user);
  }

  // ---- update_company ----
  private async toolUpdateCompany(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar la empresa.' });
    }
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.address) changes.push(`dirección: ${input.address}`);
    if (input.phone) changes.push(`teléfono: ${input.phone}`);
    if (input.email) changes.push(`email: ${input.email}`);
    if (input.lat != null || input.lng != null) changes.push('ubicación');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_company', {
      companyId, name: input.name, address: input.address, phone: input.phone, email: input.email, lat: input.lat, lng: input.lng,
    }, `Editar empresa: ${changes.join(', ')}`, user);
  }

  // ---- update_user_admin ----
  private async toolUpdateUserAdmin(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar usuarios.' });
    }
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true } });
    if (!target) return JSON.stringify({ error: 'Usuario no encontrado.' });
    // Verify target belongs to caller's company
    const targetMem = await this.prisma.userCompany.findFirst({ where: { userId: input.userId, companyId } });
    if (!targetMem) return JSON.stringify({ error: 'El usuario no pertenece a su empresa.' });
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.email) changes.push(`email: ${input.email}`);
    if (input.phone) changes.push(`teléfono: ${input.phone}`);
    if (input.role) changes.push(`rol: ${input.role}`);
    if (input.active !== undefined) changes.push(input.active ? 'reactivar' : 'desactivar');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_user_admin', {
      companyId, userId: input.userId, userName: target.name, name: input.name, email: input.email, phone: input.phone, role: input.role, active: input.active,
    }, `Editar usuario "${target.name}": ${changes.join(', ')}`, user);
  }

  // ---- assign_multi_trucks ----
  private async toolAssignMultiTrucks(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden asignar múltiples camiones.' });
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;
    if (!Array.isArray(input.trucks) || input.trucks.length === 0) return JSON.stringify({ error: 'Debe indicar al menos un camión.' });
    const summary = input.trucks.map((t: any, i: number) => `#${i + 1}: transportista=${t.transportCompanyId}${t.tons ? ` (${t.tons}t)` : ''}`).join(', ');
    return this.stageAction(session, 'assign_multi_trucks', {
      freightId: freight.id, code: freight.code, trucks: input.trucks,
      plantCompanyId: this.resolvePlantCompanyId(user),
    }, `Asignar ${input.trucks.length} camiones al flete ${freight.code}: ${summary}`, user);
  }

  // ---- view_driver_queue ----
  private async toolViewDriverQueue(input: any, user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    // Verify driver belongs to a company the user has access to
    const driver = await this.prisma.user.findUnique({ where: { id: input.driverId }, select: { id: true, name: true } });
    if (!driver) return JSON.stringify({ error: 'Chofer no encontrado.' });
    const synUser = this.buildSyntheticUser(user);
    try {
      const queue = await this.freights.getDriverQueue(input.driverId, synUser);
      if (!queue || (Array.isArray(queue) && queue.length === 0)) return JSON.stringify({ total: 0, message: `${driver.name} no tiene fletes en cola.` });
      return JSON.stringify({ driverName: driver.name, queue });
    } catch (e: any) {
      return JSON.stringify({ error: e.message || 'Error al consultar cola del chofer.' });
    }
  }

  // ---- reorder_driver_queue ----
  private async toolReorderDriverQueue(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!AiService.hasType(companyType, 'plant') && !['admin', 'platform_admin'].includes(user.role)) {
      return JSON.stringify({ error: 'Solo plantas y admin pueden reordenar la cola.' });
    }
    const driver = await this.prisma.user.findUnique({ where: { id: input.driverId }, select: { name: true } });
    if (!driver) return JSON.stringify({ error: 'Chofer no encontrado.' });
    if (!Array.isArray(input.orderedFreightIds) || input.orderedFreightIds.length === 0) {
      return JSON.stringify({ error: 'Debe indicar al menos un ID de flete.' });
    }
    return this.stageAction(session, 'reorder_driver_queue', {
      driverId: input.driverId, driverName: driver.name, orderedFreightIds: input.orderedFreightIds,
    }, `Reordenar cola de ${driver.name} (${input.orderedFreightIds.length} fletes)`, user);
  }
}
