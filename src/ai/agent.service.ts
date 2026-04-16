// =====================================================================
// TOLVINK — Agent Service (Gemini Flash Lite + native function calling)
// =====================================================================

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { GeminiClient, GeminiMessage } from './core/gemini.client';
import { buildSystemPrompt } from './core/prompt-builder';
import { ToolExecutorService, READ_ONLY_TOOLS } from './tools/tool-executor';
import { ALL_TOOL_DEFINITIONS } from './tools/tool-definitions';
import { resolveAiProfile } from './core/ai-profile';
import { checkRateLimit, cleanupRateLimits } from './utils/rate-limiter';
import { classifyAiError, sanitizeErrorForLog } from '../common/error-utils';
import {
  MAX_TOOL_ITERATIONS, TOOL_TIMEOUT_MS, SESSION_TIMEOUT_MS,
  MAX_HISTORY_MESSAGES, PROMPT_CACHE_TTL_MS, MAX_RESPONSE_CHARS,
  WEB_MAX_RESPONSE_CHARS,
} from './core/constants';

@Injectable()
export class AgentService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentService.name);
  private _chatLocks = new Set<string>();
  private _promptCache = new Map<string, { prompt: string; ts: number }>();

  private cleanupTimer = setInterval(() => {
    cleanupRateLimits();
    this.toolExecutor.cleanupPendingActions();
    const now = Date.now();
    for (const [k, v] of this._promptCache) {
      if (now - v.ts > PROMPT_CACHE_TTL_MS) this._promptCache.delete(k);
    }
  }, 5 * 60 * 1000);

  constructor(
    private prisma: PrismaService,
    private gemini: GeminiClient,
    private toolExecutor: ToolExecutorService,
  ) {}

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  getPendingActionId(sessionId: string): string | undefined {
    return this.toolExecutor.getPendingActionId(sessionId);
  }

  getPendingSummary(sessionId: string): string | undefined {
    return this.toolExecutor.getPendingSummary(sessionId);
  }

  getPendingButtons(sessionId: string): Array<{ id: string; title: string }> | undefined {
    return this.toolExecutor.getPendingButtons(sessionId);
  }

  async confirmPendingAction(session: any, user: any): Promise<string> {
    return this.toolExecutor.confirmPendingAction(session, user);
  }

  cancelPendingAction(sessionId: string, actionId?: string): boolean {
    return this.toolExecutor.cancelPendingAction(sessionId, actionId);
  }

  isEnabled(): boolean {
    return this.gemini.isEnabled();
  }

  async chat(
    phone: string,
    userMessage: string,
    user: any,
    session: any,
    _onDelta?: (chunk: string, start?: boolean) => void,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> }> {
    if (!this.gemini.isEnabled()) {
      return { text: 'El asistente IA no esta disponible en este momento.' };
    }

    // Rate limiting
    if (checkRateLimit(user.id || phone)) {
      return { text: 'Muchos mensajes seguidos. Aguarda unos minutos.' };
    }

    // Concurrency lock
    const lockKey = session?.id || `phone:${phone}`;
    if (this._chatLocks.has(lockKey)) {
      const deadline = Date.now() + 2000;
      while (this._chatLocks.has(lockKey) && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 200));
      }
      if (this._chatLocks.has(lockKey)) {
        return { text: 'Estoy procesando tu mensaje anterior, aguarda un momento.' };
      }
    }
    this._chatLocks.add(lockKey);

    const isWeb = phone === 'web';
    const profile = resolveAiProfile(user);

    try {
      const layer0 = await this.tryDeterministicIntent(userMessage, user, session, profile);
      if (layer0) {
        return layer0;
      }

      // Build system prompt (cached)
      const cacheKey = `${session?.id}:${isWeb}:${profile}`;
      const cached = this._promptCache.get(cacheKey);
      let systemPrompt: string;
      if (cached && Date.now() - cached.ts < PROMPT_CACHE_TTL_MS) {
        systemPrompt = cached.prompt;
      } else {
        systemPrompt = buildSystemPrompt(user, isWeb, profile);
        this._promptCache.set(cacheKey, { prompt: systemPrompt, ts: Date.now() });
      }

      // Load history from session — stored in Gemini native format
      const state = (session?.flowState as any) || {};
      const storedMessages: GeminiMessage[] = this.sanitizeHistory(state.aiMessages || []);

      // Add document indicator if there's a pending photo/file
      const pendingDoc = state.pendingDocument;
      const docIndicator = pendingDoc?.url ? `\n[ARCHIVO PENDIENTE: "${pendingDoc.name}" listo para adjuntar con attach_document]` : '';
      const userText = userMessage.slice(0, 5000) + docIndicator;

      // Build messages: sanitized history + new user message
      let geminiMessages: GeminiMessage[] = [
        ...storedMessages,
        { role: 'user', parts: [{ text: userText }] },
      ];

      // Filter and convert tool definitions
      const filteredDefs = this.toolExecutor.filterTools(ALL_TOOL_DEFINITIONS, user);
      const geminiTools = this.gemini.convertTools(filteredDefs);

      // Tool loop
      const loopDeadline = Date.now() + TOOL_TIMEOUT_MS;
      let loopCount = 0;
      let lastText = '';

      while (loopCount < MAX_TOOL_ITERATIONS) {
        loopCount++;
        if (Date.now() > loopDeadline) {
          this.logger.warn(`Tool loop deadline after ${loopCount} iterations`);
          break;
        }

        this.logger.log(`Gemini call #${loopCount}, messages: ${geminiMessages.length}, tools: ${geminiTools.length}`);

        const response = await this.gemini.sendMessage({
          system: systemPrompt,
          messages: geminiMessages,
          tools: geminiTools,
        });

        lastText = response.text;

        // Add model response to messages — use rawParts to preserve thought_signature
        if (response.rawParts.length > 0) {
          geminiMessages.push({ role: 'model', parts: response.rawParts });
        }

        // No function calls — model is done
        if (response.functionCalls.length === 0) {
          break;
        }

        // Execute tools
        const allReadOnly = response.functionCalls.every(fc => READ_ONLY_TOOLS.has(fc.name));
        const toolResponses: any[] = [];

        if (allReadOnly && response.functionCalls.length > 1) {
          // Parallel for read-only
          const settled = await Promise.allSettled(response.functionCalls.map(async (fc) => {
            this.logger.log(`Tool (parallel): ${fc.name}`);
            const result = await this.toolExecutor.executeTool(fc.name, fc.args, user, session);
            return { functionResponse: { name: fc.name, response: { result } } };
          }));
          for (let i = 0; i < settled.length; i++) {
            const s = settled[i];
            toolResponses.push(
              s.status === 'fulfilled'
                ? s.value
                : { functionResponse: { name: response.functionCalls[i].name, response: { result: `Error: ${(s as any).reason?.message || 'Unknown'}` } } },
            );
          }
        } else {
          // Sequential
          for (const fc of response.functionCalls) {
            this.logger.log(`Tool: ${fc.name}`);
            const result = await this.toolExecutor.executeTool(fc.name, fc.args, user, session);
            toolResponses.push({ functionResponse: { name: fc.name, response: { result } } });
          }
        }

        geminiMessages.push({ role: 'user', parts: toolResponses });

        // If a tool staged an action with buttons, exit loop immediately
        if (this.toolExecutor.hasPendingAction(session?.id)) {
          this.logger.log('Pending action staged — exiting tool loop');
          break;
        }
      }

      // Get pending buttons from tool executor
      const pendingButtons = this.toolExecutor.getPendingButtons(session?.id);

      // When there are pending buttons, use ONLY the staging summary
      let finalText: string;
      if (pendingButtons) {
        finalText = this.toolExecutor.getPendingSummary(session?.id) || '';
      } else {
        finalText = lastText;

        // Truncate response
        const maxChars = isWeb ? WEB_MAX_RESPONSE_CHARS : MAX_RESPONSE_CHARS;
        if (finalText.length > maxChars) {
          const breakPoint = finalText.lastIndexOf('\n', maxChars);
          finalText = breakPoint > maxChars * 0.5 ? finalText.slice(0, breakPoint) : finalText.slice(0, maxChars);
        }

        // Strip UUIDs from non-staging responses
        finalText = finalText.replace(
          /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
          (match, offset) => {
            const before = finalText.slice(Math.max(0, offset - 80), offset);
            if (/https?:\/\/\S*$/i.test(before)) return match;
            return '';
          },
        );
      }

      if (!finalText) {
        finalText = 'No se pudo procesar el mensaje.';
      }

      // Save history in Gemini native format (preserves thought_signature)
      const trimmedToStore = geminiMessages.slice(-MAX_HISTORY_MESSAGES);

      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...state,
            aiMessages: trimmedToStore,
            lastMessageAt: new Date().toISOString(),
          },
          expiresAt: new Date(Date.now() + SESSION_TIMEOUT_MS),
        },
      });

      return {
        text: finalText.trim(),
        buttons: pendingButtons,
      };
    } catch (e: any) {
      const errCode = classifyAiError(e);
      this.logger.error(`Chat error [${errCode}]: ${sanitizeErrorForLog(e?.message)}`, e.stack?.slice(0, 300));
      if (errCode === 'rate_limited') {
        return { text: 'El asistente esta con alta demanda. Intenta en unos segundos.' };
      }
      return { text: 'Se produjo un inconveniente. Intenta de nuevo.' };
    } finally {
      this._chatLocks.delete(lockKey);
    }
  }

  /** Sanitize stored Gemini-format history messages */
  private sanitizeHistory(messages: any[]): GeminiMessage[] {
    // Filter valid Gemini messages
    let cleaned: GeminiMessage[] = messages.filter((m: any) => {
      if (!m || !m.role || !Array.isArray(m.parts) || m.parts.length === 0) return false;
      // Must be user or model role
      return m.role === 'user' || m.role === 'model';
    });

    // Also accept old Anthropic-format messages and convert them
    const oldFormat = messages.filter((m: any) => m?.role && !Array.isArray(m.parts) && (m.content || typeof m.content === 'string'));
    if (oldFormat.length > 0 && cleaned.length === 0) {
      cleaned = this.gemini.convertHistory(oldFormat);
    }

    if (cleaned.length > MAX_HISTORY_MESSAGES) {
      cleaned = cleaned.slice(-MAX_HISTORY_MESSAGES);
    }

    // Ensure valid start: must begin with user role
    while (cleaned.length > 0 && cleaned[0].role !== 'user') {
      cleaned.shift();
    }

    // Remove orphaned functionResponse at start (no preceding model with functionCall)
    while (cleaned.length > 0 && cleaned[0].role === 'user') {
      const hasFuncResponse = cleaned[0].parts?.some((p: any) => p.functionResponse);
      if (hasFuncResponse) {
        cleaned.shift();
        while (cleaned.length > 0 && cleaned[0].role !== 'user') cleaned.shift();
      } else {
        break;
      }
    }

    return cleaned;
  }

  private async tryDeterministicIntent(
    rawMessage: string,
    user: any,
    session: any,
    profile: string,
  ): Promise<{ text: string; buttons?: Array<{ id: string; title: string }> } | null> {
    const message = (rawMessage || '').trim();
    const normalized = message.toLowerCase();

    const confirmLike = /^(si|sí|ok|dale|va|confirmar|confirmo|confirmá|confirma)\b/i.test(message);
    const cancelLike = /^(no|cancelar|deja|anular|cancelá|cancela)\b/i.test(message);

    if (confirmLike && this.toolExecutor.hasPendingAction(session?.id)) {
      const result = await this.toolExecutor.confirmPendingAction(session, user);
      const parsed = JSON.parse(result || '{}');
      const buttons = this.toolExecutor.getPendingButtons(session?.id);
      const text = buttons?.length
        ? (this.toolExecutor.getPendingSummary(session?.id) || parsed.summary || 'Confirma la siguiente accion.')
        : (parsed.error || parsed.message || this.renderActionResult(parsed));
      return { text, buttons };
    }

    if (cancelLike && this.toolExecutor.hasPendingAction(session?.id)) {
      this.toolExecutor.cancelPendingAction(session?.id);
      return { text: 'Listo, accion cancelada.' };
    }

    if (/^(menu|hola|buenas|ayuda)$/i.test(normalized)) {
      return { text: this.buildProfileMenu(user, profile) };
    }

    if (/^(mis fletes|fletes|flete activo)$/i.test(normalized)) {
      const result = await this.toolExecutor.executeTool('list_freights', {}, user, session);
      return { text: this.renderToolJson(result) };
    }

    const codeMatch = message.match(/\bF\d{2}-[A-Z0-9.\-]+\b/i);
    if (codeMatch && /(detalle|estado|como va|cómo va|ver)/i.test(normalized)) {
      const result = await this.toolExecutor.executeTool('get_freight_detail', { code: codeMatch[0] }, user, session);
      return { text: this.renderToolJson(result) };
    }

    if (/empresa activa/i.test(normalized)) {
      const activeCoId = user.activeCompanyId || user.companyId;
      const activeMem = (user.memberships || []).find((m: any) => m.companyId === activeCoId);
      const companyName = activeMem?.company?.name || user.company?.name || 'Sin empresa activa';
      return { text: `Empresa activa: ${companyName}` };
    }

    if (/^(llegue|llegué) /i.test(normalized) || /^(llegue|llegué)$/i.test(normalized)) {
      const toolName = profile === 'autonomous_driver' ? 'register_plant_arrival' : 'confirm_freight_arrival';
      const result = await this.toolExecutor.executeTool(toolName, {}, user, session);
      return { text: this.renderToolJson(result), buttons: this.toolExecutor.getPendingButtons(session?.id) };
    }

    if (profile !== 'autonomous_driver' && /^(cargue|cargué|ya cargue|ya cargué)$/i.test(normalized)) {
      const result = await this.toolExecutor.executeTool('confirm_freight_loaded', {}, user, session);
      return { text: this.renderToolJson(result), buttons: this.toolExecutor.getPendingButtons(session?.id) };
    }

    if (/^(termine|terminé|descargue|descargué)$/i.test(normalized)) {
      const toolName = profile === 'autonomous_driver' ? 'finish_autonomous_freight' : 'finish_freight';
      const result = await this.toolExecutor.executeTool(toolName, {}, user, session);
      return { text: this.renderToolJson(result), buttons: this.toolExecutor.getPendingButtons(session?.id) };
    }

    return null;
  }

  private buildProfileMenu(user: any, profile: string): string {
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = (user.memberships || []).find((m: any) => m.companyId === activeCoId);
    const companyName = activeMem?.company?.name || user.company?.name || 'Sin empresa';
    if (profile === 'autonomous_driver') {
      return `Tolvink\n\n🏢 Empresa activa: ${companyName}.\n👤 Rol: Chofer.\n\nPodes consultar tus fletes, crear uno nuevo, registrar llegada, finalizar y adjuntar documentos.`;
    }
    return `Tolvink\n\n🏢 Empresa activa: ${companyName}.\n👤 Perfil IA: ${profile}.\n\nPodes consultar fletes y operar solo las acciones permitidas para tu rol en esta empresa.`;
  }

  private renderToolJson(result: string): string {
    try {
      const parsed = JSON.parse(result || '{}');
      return parsed.error || parsed.message || this.renderActionResult(parsed);
    } catch {
      return result || 'No se pudo procesar el mensaje.';
    }
  }

  private renderActionResult(parsed: any): string {
    if (!parsed) return 'Listo.';
    if (parsed.status === 'pending_confirmation') return parsed.summary || 'Confirma la siguiente accion.';
    if (parsed.status === 'created' && parsed.code) return `Listo.\n📋 ${parsed.code}\nFlete creado correctamente.`;
    if (parsed.status === 'approved' && parsed.code) return `Listo.\n📋 ${parsed.code}\nFlete aprobado.`;
    if (parsed.status === 'assigned' && parsed.code) return `Listo.\n📋 ${parsed.code}\nTransportista asignado.`;
    if (parsed.status === 'accepted' && parsed.code) return `Listo.\n📋 ${parsed.code}\nChofer y camion asignados.`;
    if (parsed.status === 'rejected' && parsed.code) return `Listo.\n📋 ${parsed.code}\nAsignacion rechazada.`;
    if (parsed.status === 'started' && parsed.code) return `Listo.\n📋 ${parsed.code}\nViaje iniciado.`;
    if (parsed.status === 'loaded' && parsed.code) return `Listo.\n📋 ${parsed.code}\nCarga confirmada.`;
    if (parsed.status === 'finished' && parsed.code) return `Listo.\n📋 ${parsed.code}\nFlete finalizado.`;
    if (parsed.status === 'canceled' && parsed.code) return `Listo.\n📋 ${parsed.code}\nFlete cancelado.`;
    if (parsed.status === 'arrival_registered' && parsed.code) return `Listo.\n📋 ${parsed.code}\nLlegada registrada.`;
    if (parsed.status === 'attached' && parsed.documentName) return `Documento adjuntado: ${parsed.documentName}`;
    if (parsed.status === 'already_accepted' && parsed.message) return parsed.message;
    if (Array.isArray(parsed.freights)) {
      const lines = parsed.freights.slice(0, 5).map((f: any) => `📋 ${f.code} · ${f.status} · ${f.origin} → ${f.dest}`);
      return lines.length ? lines.join('\n') : 'No tenes fletes para mostrar.';
    }
    if (parsed.code) return `Listo.\n📋 ${parsed.code}`;
    return parsed.message || 'Listo.';
  }
}
