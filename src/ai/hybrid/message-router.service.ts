// =====================================================================
// TOLVINK — Message Router Service (Hybrid Orchestrator)
// Routes WhatsApp messages: deterministic first, LLM only as fallback
// Target: 95%+ of messages handled without LLM
//
// SAFETY INVARIANTS:
// - Active flow ALWAYS takes priority over intent detection (#4)
// - toolPrepareFreight ONLY called AFTER user confirms (#2)
// - Duplicate confirms are idempotent via actionId (#3)
// - Deterministic errors fall through to LLM safely (#9)
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { IntentDetectorService, DetectedIntentResult } from './intent-detector.service';
import { FreightParserService, ParsedFreightData } from './freight-parser.service';
import { FreightFlowService } from './freight-flow.service';
import { FlowService, FlowState } from './flow.service';
import { ResponseBuilderService, HybridResponse } from './response-builder.service';
import { AiInterpreterService, InterpreterResult } from './ai-interpreter.service';
import { AiService } from '../ai.service';
import { AiContextService } from '../tools/ai-context.service';
import { SessionManagerService } from '../session/session-manager.service';
import { FreightQueryToolsService } from '../tools/freight-query-tools.service';
import { FreightActionToolsService } from '../tools/freight-action-tools.service';
import { TransportToolsService } from '../tools/transport-tools.service';
import { resolveActiveRole } from '../ai.utils';
import * as crypto from 'crypto';

/** Result returned to the WhatsApp router — same interface as AiService.chat() */
export interface MessageResult {
  text: string;
  buttons?: Array<{ id: string; title: string }>;
  navigate?: { screen: string; freightId?: string };
  /** Whether this was handled deterministically (true) or fell through to LLM (false) */
  deterministic: boolean;
}

// Minimum confidence to accept a deterministic intent
const CONFIDENCE_THRESHOLD = 0.75;

@Injectable()
export class MessageRouterService implements OnModuleDestroy {
  private readonly logger = new Logger(MessageRouterService.name);

  // Idempotency: track executed actionIds to prevent duplicate execution (#3)
  private executedActions = new Map<string, number>();
  private idempotencyCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, ts] of this.executedActions) {
      if (now - ts > 10 * 60 * 1000) this.executedActions.delete(k);
    }
    if (this.executedActions.size > 5000) {
      const iter = this.executedActions.keys();
      while (this.executedActions.size > 4000) {
        const k = iter.next().value;
        if (k) this.executedActions.delete(k); else break;
      }
    }
  }, 5 * 60 * 1000);

  onModuleDestroy() {
    clearInterval(this.idempotencyCleanupTimer);
    this.executedActions.clear();
  }

  constructor(
    private prisma: PrismaService,
    private intentDetector: IntentDetectorService,
    private freightParser: FreightParserService,
    private freightFlow: FreightFlowService,
    private flowService: FlowService,
    private responseBuilder: ResponseBuilderService,
    private interpreter: AiInterpreterService,
    @Inject(forwardRef(() => AiService)) private aiService: AiService,
    private aiContext: AiContextService,
    private sessionManager: SessionManagerService,
    private freightQueryTools: FreightQueryToolsService,
    private freightActionTools: FreightActionToolsService,
    private transportTools: TransportToolsService,
  ) {}

  /**
   * Main entry point — replaces direct AiService.chat() calls.
   * Tries deterministic handling first, falls back to LLM only if needed.
   */
  async handleMessage(
    phone: string,
    message: string,
    user: any,
    session: any,
  ): Promise<MessageResult> {
    const startTime = Date.now();

    try {
      // UX: empty messages, emoji-only, whitespace → greeting
      const trimmed = message.trim();
      if (!trimmed || trimmed.length <= 2) {
        const companyType = this.aiContext.resolveCompanyType(user);
        return { ...this.responseBuilder.formatGreeting(user.name, companyType), deterministic: true };
      }

      // Active flow ALWAYS takes priority — DO NOT run intent detection.
      const activeFlow = this.flowService.getFlowFromSession(session);

      // FIX #8: Detect expired flow and notify user
      if (!activeFlow) {
        const rawFlow = (session?.flowState as any)?._hybridFlow;
        if (rawFlow && rawFlow.flowType && this.flowService.isExpired(rawFlow)) {
          await this.flowService.clearFlow(session.id);
          this.logger.log(`[hybrid] Expired flow cleared for session ${session.id}`);
          // Don't return here — fall through to intent detection with cleared flow
        }
      }

      if (activeFlow) {
        const result = await this.handleActiveFlow(message, user, session, activeFlow);
        if (result) {
          this.logger.log(`[hybrid] Flow handled in ${Date.now() - startTime}ms (deterministic)`);
          return result;
        }
        // Flow returned null (shouldn't happen) — fall through to intent detection
      }

      // ── LAYER 1: Smart heuristics (zero cost) ──
      const heuristicResult = this.trySmartHeuristics(message, session);
      if (heuristicResult) {
        const result = await this.routeDeterministic(heuristicResult, message, user, session);
        if (result) {
          this.logger.log(`[hybrid] Heuristic: ${heuristicResult.intent} in ${Date.now() - startTime}ms`);
          return { ...result, deterministic: true };
        }
      }

      // ── LAYER 2: Regex intent detection (zero cost) ──
      const hasPendingAction = !!(session?.flowState as any)?.pendingAction;
      const hasPendingFreight = !!(session?.flowState as any)?.pendingFreight;
      const detected = this.intentDetector.detect(message, false, hasPendingAction || hasPendingFreight);

      this.logger.log(`[hybrid] Intent: ${detected.intent} (confidence=${detected.confidence})`);

      if (detected.confidence >= CONFIDENCE_THRESHOLD) {
        const result = await this.routeDeterministic(detected, message, user, session);
        if (result) {
          this.logger.log(`[hybrid] Deterministic: ${detected.intent} in ${Date.now() - startTime}ms`);
          return { ...result, deterministic: true };
        }
      }

      // ── LAYER 3: Lightweight LLM interpreter (~$0.0003/call) ──
      // Only called when regex fails — fills the gap before full LLM chat
      if (!this.interpreter.shouldSkip(message, !!activeFlow, hasPendingAction || hasPendingFreight)) {
        const interpreted = await this.interpreter.interpret(message);
        if (interpreted && interpreted.confidence >= 0.6) {
          this.logger.log(`[hybrid] Interpreter: ${interpreted.intent} (confidence=${interpreted.confidence}) in ${Date.now() - startTime}ms`);

          const interpretedIntent = this.interpreter.toDetectedIntent(interpreted);

          // For create_freight, merge interpreter data with parser data for richer extraction
          if (interpretedIntent.intent === 'create_freight') {
            const interpreterData = this.interpreter.toFreightData(interpreted);
            const parserData = this.freightParser.parse(message);
            interpretedIntent.entities._interpreterData = this.mergeFreightData(parserData, interpreterData);
          }

          const result = await this.routeDeterministic(interpretedIntent, message, user, session);
          if (result) {
            return { ...result, deterministic: true };
          }
        }
      }

      // ── LAYER 4: Full LLM chat fallback (expensive, last resort) ──
      this.logger.log(`[hybrid] Falling back to LLM for: "${message.slice(0, 80)}..."`);
      const llmResult = await this.aiService.chat(phone, message, user, session);
      this.logger.log(`[hybrid] LLM handled in ${Date.now() - startTime}ms`);

      return { ...llmResult, deterministic: false };
    } catch (err: any) {
      this.logger.error(`[hybrid] Error: ${err.message}`, err.stack?.slice(0, 300));
      // FIX #9: Safe fallback — deterministic errors fall through to LLM
      try {
        const llmResult = await this.aiService.chat(phone, message, user, session);
        return { ...llmResult, deterministic: false };
      } catch {
        return {
          text: 'Se produjo un inconveniente técnico. Por favor, intente nuevamente.',
          deterministic: false,
        };
      }
    }
  }

  // ======================== SMART HEURISTICS (#6) ========================

  /**
   * Catch messages that the standard intent detector might miss.
   * These run BEFORE LLM fallback to reduce unnecessary API calls.
   */
  private trySmartHeuristics(message: string, session: any): DetectedIntentResult | null {
    const norm = message.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

    // Heuristic: number + grain word → likely create_freight
    // e.g. "30 soja", "50 de trigo mañana"
    if (/\d+.*\b(soja|maiz|trigo|girasol|sorgo|cebada)\b/.test(norm) ||
        /\b(soja|maiz|trigo|girasol|sorgo|cebada)\b.*\d+/.test(norm)) {
      return { intent: 'create_freight', confidence: 0.85, entities: {} };
    }

    // Heuristic: short number AND active flow awaiting a numeric field
    const activeFlow = (session?.flowState as any)?._hybridFlow;
    if (activeFlow && activeFlow.awaitingField && /^\d+([.,]\d+)?\s*$/.test(norm)) {
      // This will be handled by the flow — return null to let flow priority work
      // But if flow is somehow not detected, this ensures we don't fall to LLM
      return null;
    }

    // Heuristic: short confirmation words even without pending action detected
    const state = (session?.flowState as any) || {};
    if (state.pendingAction || state.pendingFreight) {
      if (/^(si|sí|dale|ok|confirmo?|listo|va)\s*[.!]?\s*$/.test(norm)) {
        return { intent: 'confirm', confidence: 1.0, entities: {} };
      }
      if (/^(no|cancela[r]?|dejalo?|nada)\s*[.!]?\s*$/.test(norm)) {
        return { intent: 'cancel', confidence: 1.0, entities: {} };
      }
    }

    return null;
  }

  // ======================== DETERMINISTIC ROUTING ========================

  private async routeDeterministic(
    detected: DetectedIntentResult,
    message: string,
    user: any,
    session: any,
  ): Promise<HybridResponse | null> {

    const companyType = this.aiContext.resolveCompanyType(user);

    switch (detected.intent) {

      // ---- GREETING ----
      case 'greeting':
        return this.responseBuilder.formatGreeting(user.name, companyType);

      // ---- HELP ----
      case 'help':
        return this.responseBuilder.formatHelp();

      // ---- PROFILE ----
      case 'profile':
        return this.responseBuilder.formatProfile(user);

      // ---- DASHBOARD ----
      case 'get_dashboard': {
        const resultStr = await this.freightQueryTools.toolGetDashboard(user);
        try {
          const data = JSON.parse(resultStr);
          if (data.error) return this.responseBuilder.formatError(data.error);
          return this.responseBuilder.formatDashboard(data);
        } catch {
          return null; // Fallback to LLM
        }
      }

      // ---- LIST FREIGHTS ----
      case 'list_freights': {
        const synUser = this.aiContext.buildSyntheticUser(user);
        const input: any = {};
        if (detected.entities.status) {
          if (detected.entities.status === 'active') {
            input.status = 'in_progress,loaded';
          } else {
            input.status = detected.entities.status;
          }
        }
        if (detected.entities.grain) {
          input.grain = detected.entities.grain.charAt(0).toUpperCase() + detected.entities.grain.slice(1);
        }
        const resultStr = await this.freightQueryTools.toolListFreights(synUser, input, session);
        try {
          const data = JSON.parse(resultStr);
          if (data.error) return this.responseBuilder.formatError(data.error);
          return this.responseBuilder.formatFreightList(data.freights || data.items || [], data.total || 0, input.status);
        } catch {
          return null;
        }
      }

      // ---- GET FREIGHT DETAIL ----
      case 'get_freight_detail': {
        const code = detected.entities.code;
        if (!code) return null;
        const resultStr = await this.freightQueryTools.toolGetFreightDetail({ code }, user, session);
        try {
          const data = JSON.parse(resultStr);
          if (data.error) return this.responseBuilder.formatError(data.error);
          return this.responseBuilder.formatFreightDetail(data);
        } catch {
          return null;
        }
      }

      // ---- CREATE FREIGHT ----
      // Delegate to LLM (Sonnet) — it handles one-shot extraction, fuzzy matching,
      // branch selection, and multi-step flows much better than regex parsing.
      case 'create_freight':
        return null;

      // ---- CONFIRM ----
      case 'confirm': {
        return await this.handleConfirm(user, session);
      }

      // ---- CANCEL ----
      case 'cancel': {
        return await this.handleCancel(session);
      }

      // ---- LIST TRUCKS ----
      case 'list_trucks': {
        const resultStr = await this.transportTools.toolListTrucks(user, session);
        try {
          const data = JSON.parse(resultStr);
          if (data.error) return this.responseBuilder.formatError(data.error);
          return this.responseBuilder.formatTruckList(Array.isArray(data) ? data : data.trucks || []);
        } catch {
          return null;
        }
      }

      // ---- LIST DRIVERS ----
      case 'list_drivers': {
        const resultStr = await this.transportTools.toolListDrivers(user, session);
        try {
          const data = JSON.parse(resultStr);
          if (data.error) return this.responseBuilder.formatError(data.error);
          return this.responseBuilder.formatDriverList(Array.isArray(data) ? data : data.drivers || []);
        } catch {
          return null;
        }
      }

      // ---- ASSIGN TRANSPORT ----
      case 'assign_transport':
        // Requires freight code + interactive selection — delegate to LLM
        return null;

      // ---- FLEET SUMMARY / SWITCH COMPANY ----
      case 'fleet_summary':
      case 'switch_company':
        return null; // Delegate to LLM — requires multi-tool orchestration

      default:
        return null;
    }
  }

  // ======================== ACTIVE FLOW HANDLING (#4) ========================

  private async handleActiveFlow(
    message: string,
    user: any,
    session: any,
    flow: FlowState,
  ): Promise<MessageResult | null> {

    if (flow.flowType === 'create_freight') {
      const result = this.freightFlow.processMessage(message, flow);

      // Flow escape: user sent a strong intent change (e.g. "mis fletes", "hola")
      // FreightFlowService signals this by returning flowType=null
      if (!result.flow.flowType) {
        await this.flowService.clearFlow(session.id);
        // Return null — fall through to intent detection for the new intent
        return null;
      }

      // User cancelled
      if (result.response === '❌ Creación de flete cancelada.') {
        await this.flowService.clearFlow(session.id);
        return { text: result.response, deterministic: true };
      }

      // toolPrepareFreight ONLY called AFTER user confirms (done=true)
      if (result.done && result.prepareInput) {
        // Idempotency check — prevent duplicate execution
        const actionId = this.generateActionId(session.id, result.prepareInput);
        if (this.executedActions.has(actionId)) {
          this.logger.warn(`[hybrid] Duplicate confirm blocked (actionId=${actionId})`);
          return { text: '⚠️ Esta acción ya fue procesada. Si necesitás crear otro flete, escribí "crear flete".', deterministic: true };
        }

        // Clear the flow BEFORE executing (prevents re-entry)
        await this.flowService.clearFlow(session.id);

        // Execute — if it fails, do NOT leave the action in the idempotency map
        try {
          // Mark as executed only AFTER we know the call will proceed
          this.executedActions.set(actionId, Date.now());
          const prepareResult = await this.delegateToPrepareFreight(result.prepareInput, user, session);
          return { ...prepareResult, deterministic: true };
        } catch (err: any) {
          // Rollback idempotency on failure — user should be able to retry
          this.executedActions.delete(actionId);
          this.logger.error(`[hybrid] prepare_freight failed, idempotency rolled back: ${err.message}`);
          return {
            text: '⚠️ Error al preparar el flete. Intentá de nuevo escribiendo "crear flete".',
            deterministic: true,
          };
        }
      }

      // Still collecting or awaiting confirmation — save flow and respond
      await this.flowService.saveFlowToSession(session.id, result.flow);

      if (result.flow.awaitingConfirmation && result.response) {
        return {
          text: result.response,
          buttons: [
            { id: 'ai_confirm_freight', title: 'CONFIRMAR' },
            { id: 'ai_cancel_freight', title: 'CANCELAR' },
          ],
          deterministic: true,
        };
      }

      if (result.response) {
        return { text: result.response, deterministic: true };
      }
    }

    return null;
  }

  // ======================== CONFIRM / CANCEL HANDLERS ========================

  private async handleConfirm(user: any, session: any): Promise<HybridResponse | null> {
    const state = (session?.flowState as any) || {};

    // Idempotency for confirm_action
    if (state.pendingAction) {
      const actionId = `confirm:${session.id}:${state.pendingAction.createdAt || ''}`;
      if (this.executedActions.has(actionId)) {
        return { text: '⚠️ Esta acción ya fue confirmada.' };
      }
      this.executedActions.set(actionId, Date.now());

      const synUser = this.aiContext.buildSyntheticUser(user);
      try {
        const resultStr = await this.freightActionTools.toolConfirmAction(user, synUser, session);
        return this.responseBuilder.formatConfirmResult(resultStr);
      } catch (err: any) {
        this.executedActions.delete(actionId);
        this.logger.error(`[hybrid] confirm_action failed: ${err.message}`);
        return this.responseBuilder.formatError('Error al confirmar. Intentá de nuevo.');
      }
    }

    // Idempotency for confirm_create_freight — DB-level CTE in toolConfirmCreateFreight
    // also prevents double-creation, this is a fast-path guard
    if (state.pendingFreight) {
      const dedupKey = `freight:${session.id}:${state.pendingFreight._sessionCompanyId || ''}`;
      if (this.executedActions.has(dedupKey)) {
        return { text: '⚠️ Este flete ya fue creado.' };
      }
      this.executedActions.set(dedupKey, Date.now());

      const synUser = this.aiContext.buildSyntheticUser(user);
      try {
        const resultStr = await this.freightActionTools.toolConfirmCreateFreight(user, synUser, session);
        return this.responseBuilder.formatConfirmResult(resultStr);
      } catch (err: any) {
        // Rollback idempotency so user can retry
        this.executedActions.delete(dedupKey);
        this.logger.error(`[hybrid] confirm_create_freight failed: ${err.message}`);
        return this.responseBuilder.formatError('Error al crear el flete. Intentá de nuevo.');
      }
    }

    return null; // Nothing to confirm — fall to LLM
  }

  private async handleCancel(session: any): Promise<HybridResponse | null> {
    const state = (session?.flowState as any) || {};

    if (state.pendingAction || state.pendingFreight || state._hybridFlow) {
      await this.prisma.whatsAppSession.update({
        where: { id: session.id },
        data: {
          flowState: {
            ...state,
            pendingAction: null,
            pendingFreight: null,
            _pendingButtons: null,
            _hybridFlow: null,
          },
        },
      });
      return this.responseBuilder.formatCancelResult();
    }

    return null;
  }

  // ======================== PREPARE FREIGHT DELEGATION (#2) ========================

  /**
   * Delegate to the existing toolPrepareFreight for complex resolution
   * (fuzzy matching plants, lots, branches, trucks, etc.)
   *
   * SAFETY: This is ONLY called AFTER the user explicitly confirmed via
   * the flow confirmation step. Never called during data collection.
   */
  private async delegateToPrepareFreight(
    input: Record<string, any>,
    user: any,
    session: any,
  ): Promise<HybridResponse> {
    // FIX #10: Validate required fields before calling tool
    if (!input.grain || !input.tons || !input.loadDate) {
      return this.responseBuilder.formatError('Faltan datos obligatorios (grano, toneladas, fecha). Escribí "crear flete" para comenzar de nuevo.');
    }

    try {
      const resultStr = await this.freightActionTools.toolPrepareFreight(input, user, session);
      const data = JSON.parse(resultStr);

      if (data.error) {
        return this.responseBuilder.formatError(data.error);
      }

      if (data.status === 'pending_confirmation' && data.summary) {
        const s = data.summary;
        const lines: string[] = [
          '📋 *Resumen del flete*\n',
          `🌾 Grano: ${s.grain}`,
          `⚖️ Toneladas: ${s.tons}`,
          `🚛 Camiones: ${s.truckCount}`,
          `📍 Origen: ${s.origin}`,
          `🏭 Destino: ${s.dest}`,
          `📅 Fecha: ${s.date}`,
          `⏰ Hora: ${s.time}`,
          `🔧 Transporte: ${s.fleet}`,
        ];
        if (s.truck) lines.push(`🚛 Camión: ${s.truck}`);
        if (s.driver) lines.push(`👤 Chofer: ${s.driver}`);
        if (s.notes) lines.push(`📝 Notas: ${s.notes}`);
        lines.push('\n¿Confirmás la creación?');

        return {
          text: lines.join('\n'),
          buttons: [
            { id: 'ai_confirm_freight', title: 'CONFIRMAR' },
            { id: 'ai_cancel_freight', title: 'CANCELAR' },
          ],
        };
      }

      // Interactive selection (list sent by toolPrepareFreight)
      if (data._selectionSent) {
        return { text: data.message || 'Seleccioná una opción de la lista.' };
      }

      return { text: resultStr };
    } catch (err: any) {
      this.logger.error(`[hybrid] prepare_freight error: ${err.message}`);
      return this.responseBuilder.formatError('Error al preparar el flete. Intentá de nuevo.');
    }
  }

  // ======================== IDEMPOTENCY HELPERS (#3) ========================

  /** Generate a deterministic action ID for deduplication */
  private generateActionId(sessionId: string, input: Record<string, any>): string {
    const key = `${sessionId}:${input.grain}:${input.tons}:${input.loadDate}:${input.truckCount || ''}`;
    return crypto.createHash('md5').update(key).digest('hex').slice(0, 16);
  }

  /**
   * Merge parser data (regex) with interpreter data (LLM).
   * Parser takes priority for fields it extracted confidently.
   * Interpreter fills gaps (fuzzy names, informal language).
   */
  private mergeFreightData(parser: ParsedFreightData, interpreter: ParsedFreightData): ParsedFreightData {
    return {
      grain: parser.grain || interpreter.grain || undefined,
      tons: parser.tons || interpreter.tons || undefined,
      loadDate: parser.loadDate || interpreter.loadDate || undefined,
      loadTime: parser.loadTime || interpreter.loadTime || undefined,
      truckCount: parser.truckCount ?? interpreter.truckCount ?? undefined,
      useOwnFleet: parser.useOwnFleet ?? interpreter.useOwnFleet ?? undefined,
      destName: parser.destName || interpreter.destName || undefined,
      originName: parser.originName || interpreter.originName || undefined,
    };
  }
}
