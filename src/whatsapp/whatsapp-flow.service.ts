// =====================================================================
// TOLVINK — WhatsApp Conversational Flow Service
// Manages multi-step WhatsApp interactions (reject, confirm loaded, etc.)
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { FreightsService } from '../freights/freights.service';
import { buildSyntheticUser as buildSyntheticUserHelper } from '../common/build-synthetic-user';

const FLOW_TIMEOUT_MINUTES = 10;

// M4: Per-user flow rate limiting (30 flow messages per 5 minutes)
const FLOW_RATE_WINDOW_MS = 5 * 60 * 1000;
const FLOW_RATE_MAX = 30;
const flowRateMap = new Map<string, { count: number; resetAt: number }>();

@Injectable()
export class WhatsAppFlowService implements OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppFlowService.name);
  private rateCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of flowRateMap) { if (now > v.resetAt) flowRateMap.delete(k); }
  }, 5 * 60 * 1000);

  constructor(
    private prisma: PrismaService,
    private wa: WhatsAppService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
  ) {}

  onModuleDestroy() { clearInterval(this.rateCleanupTimer); }

  // ======================== START FLOW ==================================

  async startFlow(
    flowType: string,
    phone: string,
    user: any,
    initialData?: Record<string, any>,
  ) {
    // Clean up old sessions for this user, but preserve sessions with active locationToken or pendingDocument
    const existingSessions = await this.prisma.whatsAppSession.findMany({ where: { userId: user.id } });
    const toDelete = existingSessions.filter(s => {
      const st = (s.flowState as any) || {};
      return !st.locationToken && !st.pendingDocument;
    });
    if (toDelete.length > 0) {
      await this.prisma.whatsAppSession.deleteMany({
        where: { id: { in: toDelete.map(s => s.id) } },
      });
    }

    const expiresAt = new Date(Date.now() + FLOW_TIMEOUT_MINUTES * 60 * 1000);

    const session = await this.prisma.whatsAppSession.create({
      data: {
        userId: user.id,
        phone: this.wa.normalizePhone(phone),
        flowType,
        flowStep: 'start',
        flowState: initialData || {},
        expiresAt,
      },
    });

    // Dispatch to the appropriate flow's first step
    switch (flowType) {
      case 'reject_freight':
        await this.rejectFreightStart(phone, session);
        break;
      case 'confirm_loaded':
        await this.confirmLoadedStart(phone, session);
        break;
      case 'cancel_freight':
        await this.cancelFreightStart(phone, session);
        break;
      case 'create_freight':
        // Deprecated — freight creation is now handled by AI agent conversationally
        await this.wa.sendText(phone, 'Escribí "Quiero crear un flete" para iniciar.');
        await this.endFlow(session.id);
        break;
      default:
        await this.wa.sendText(phone, 'Flujo no reconocido.');
        await this.endFlow(session.id);
    }
  }

  // ======================== CONTINUE FLOW ===============================

  async continueFlow(
    session: any,
    type: string,
    payload: any,
    phone: string,
    user: any,
  ) {
    // Check if session has expired
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      await this.endFlow(session.id);
      await this.wa.sendText(phone, 'Se agotó el tiempo de la sesión. Escribí "menu" para empezar de nuevo.');
      return;
    }

    const flowType = session.flowType;
    const flowStep = session.flowStep;
    const state = (session.flowState as any) || {};

    // M4: Flow rate limiting
    const userId = user?.id || phone;
    const now = Date.now();
    const rateEntry = flowRateMap.get(userId);
    if (rateEntry && now < rateEntry.resetAt) {
      if (rateEntry.count >= FLOW_RATE_MAX) {
        await this.wa.sendText(phone, 'Ha enviado muchos mensajes en poco tiempo. Aguarde unos minutos.');
        return;
      }
      rateEntry.count++;
    } else {
      flowRateMap.set(userId, { count: 1, resetAt: now + FLOW_RATE_WINDOW_MS });
    }
    if (flowRateMap.size > 100) {
      for (const [k, v] of flowRateMap) { if (now > v.resetAt) flowRateMap.delete(k); }
    }

    try {
      switch (flowType) {
        case 'reject_freight':
          await this.rejectFreightContinue(phone, session, type, payload, user, state);
          break;
        case 'confirm_loaded':
          await this.confirmLoadedContinue(phone, session, type, payload, user, state);
          break;
        case 'cancel_freight':
          await this.cancelFreightContinue(phone, session, type, payload, user, state);
          break;
        case 'create_freight':
          // Deprecated — end flow and redirect to AI
          await this.wa.sendText(phone, 'El asistente de creación de fletes cambió. Escribí "Quiero crear un flete" para continuar.');
          await this.endFlow(session.id);
          break;
        default:
          await this.wa.sendText(phone, 'Flujo no reconocido. Escriba "menu" para volver al inicio.');
          await this.endFlow(session.id);
      }
    } catch (e) {
      this.logger.error(`Flow "${flowType}" step "${flowStep}" error: ${e.message}`, e.stack);
      // H2: Sanitize — map known safe patterns, strip everything else
      const raw = String(e.message || '').slice(0, 200);
      const isSafe = e.status === 400 || e.response?.statusCode === 400;
      const cleaned = isSafe ? raw.replace(/[^\w\sáéíóúñÁÉÍÓÚÑ.,;:()!?¿¡\-]/g, '').trim() : '';
      const userMessage = cleaned || 'Ocurrió un error procesando su solicitud. Intente nuevamente.';
      // H3: Guarantee endFlow even if sendText fails
      try { await this.wa.sendText(phone, userMessage); } catch {}
      try { await this.endFlow(session.id); } catch {}
    }
  }

  // ======================== REJECT FREIGHT FLOW =========================
  // Step 1: Ask for reason
  // Step 2: Execute rejection

  private async rejectFreightStart(phone: string, session: any) {
    await this.updateStep(session.id, 'awaiting_reason');
    await this.wa.sendText(phone,
      'Indique el motivo del rechazo:\n\n_(Escriba "cancelar" para volver al menú)_',
    );
  }

  private async rejectFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    if (session.flowStep === 'awaiting_reason' && type === 'text') {
      const reason = (payload.body || '').trim().replace(/[\x00-\x1f]/g, '').slice(0, 255);
      if (!reason || reason.length < 3) {
        await this.wa.sendText(phone, 'El motivo debe tener al menos 3 caracteres. Intente nuevamente:');
        return;
      }

      if (!state.freightId) { await this.wa.sendText(phone, 'No se pudo identificar el flete. Intente de nuevo.'); await this.endFlow(session.id); return; }
      const synUser = this.buildSyntheticUser(user);
      await this.freights.respond(state.freightId, { action: 'rejected', reason } as any, synUser);
      await this.wa.sendText(phone, `❌ Flete rechazado.\n\n📝 Motivo: ${reason}`);
      await this.endFlow(session.id);
      return;
    }

    await this.wa.sendText(phone, 'Indique el motivo del rechazo como texto:');
  }

  // ======================== CONFIRM LOADED FLOW =========================
  // Step 1: Ask for loaded tons
  // Step 2: Execute confirmation

  private async confirmLoadedStart(phone: string, session: any) {
    // Get freight info for context
    const state = (session.flowState as any) || {};
    const freight = await this.prisma.freight.findUnique({
      where: { id: state.freightId },
      include: { items: true },
    });

    const planned = freight?.items?.[0]?.tons || '?';
    await this.updateStep(session.id, 'awaiting_tons');
    await this.wa.sendText(phone,
      `Indique las toneladas cargadas.\n` +
      `_(Planificadas: ${planned} tn)_\n\n` +
      'Escriba el número (ej: 30.5) o "cancelar" para volver.',
    );
  }

  private async confirmLoadedContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    // Step: awaiting_tons — user types the number
    if (session.flowStep === 'awaiting_tons' && type === 'text') {
      const text = payload.body?.trim().replace(',', '.');
      const tons = parseFloat(text);

      if (isNaN(tons) || tons <= 0) {
        await this.wa.sendText(phone, 'Ingrese un número válido de toneladas (ej: 30.5):');
        return;
      }

      if (tons > 100) {
        // High tonnage → ask for button confirmation
        await this.updateState(session.id, 'awaiting_tons_confirm', { ...state, pendingTons: tons });
        await this.wa.sendButtons(phone,
          `Se indicaron ${tons} tn.\n¿Confirma esta cantidad?`,
          [
            { id: 'tons_confirm:yes', title: `CONFIRMAR ${tons} TN` },
            { id: 'tons_confirm:no', title: 'CANCELAR' },
          ],
        );
        return;
      }

      if (!state.freightId) { await this.wa.sendText(phone, 'No se pudo identificar el flete. Intente de nuevo.'); await this.endFlow(session.id); return; }
      const synUser = this.buildSyntheticUser(user);
      await this.freights.confirmLoaded(state.freightId, synUser, tons);
      await this.wa.sendText(phone, `✅ Carga confirmada: ${tons} tn.`);
      await this.endFlow(session.id);
      return;
    }

    // Step: awaiting_tons_confirm — button confirmation for tons > 100
    if (session.flowStep === 'awaiting_tons_confirm' && type === 'button_reply') {
      const btnId = payload.id || '';
      if (btnId === 'tons_confirm:yes') {
        if (!state.freightId) { await this.wa.sendText(phone, 'No se pudo identificar el flete. Intente de nuevo.'); await this.endFlow(session.id); return; }
        const tons = state.pendingTons;
        const synUser = this.buildSyntheticUser(user);
        await this.freights.confirmLoaded(state.freightId, synUser, tons);
        await this.wa.sendText(phone, `✅ Carga confirmada: ${tons} tn.`);
        await this.endFlow(session.id);
      } else {
        await this.wa.sendText(phone, '❌ Operación cancelada.');
        await this.endFlow(session.id);
      }
      return;
    }

    await this.wa.sendText(phone, 'Indique la cantidad de toneladas cargadas (ej: 30.5):');
  }

  // ======================== CANCEL FREIGHT FLOW =========================
  // Step 1: Ask for reason
  // Step 2: Execute cancellation

  private async cancelFreightStart(phone: string, session: any) {
    await this.updateStep(session.id, 'awaiting_reason');
    await this.wa.sendText(phone,
      'Indique el motivo de la cancelación:\n\n_(Escriba "cancelar" para volver al menú)_',
    );
  }

  private async cancelFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    if (session.flowStep === 'awaiting_reason' && type === 'text') {
      const reason = (payload.body || '').trim().replace(/[\x00-\x1f]/g, '').slice(0, 255);
      if (!reason || reason.length < 3) {
        await this.wa.sendText(phone, 'El motivo debe tener al menos 3 caracteres. Intente nuevamente:');
        return;
      }

      if (!state.freightId) { await this.wa.sendText(phone, 'No se pudo identificar el flete. Intente de nuevo.'); await this.endFlow(session.id); return; }
      const synUser = this.buildSyntheticUser(user);
      await this.freights.cancel(state.freightId, { reason } as any, synUser);
      await this.wa.sendText(phone, `❌ Flete cancelado.\n\n📝 Motivo: ${reason}`);
      await this.endFlow(session.id);
      return;
    }

    await this.wa.sendText(phone, 'Indique el motivo de la cancelación como texto:');
  }

  // NOTE: create_freight wizard flow was removed. Freight creation is now
  // handled entirely by the AI agent (prepare_freight → confirm_create_freight).

  // ======================== HELPERS =====================================

  private async updateStep(sessionId: string, step: string) {
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowStep: step },
    });
  }

  private async updateState(sessionId: string, step: string, state: any) {
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowStep: step, flowState: state },
    });
  }

  private async endFlow(sessionId: string) {
    await this.prisma.whatsAppSession.delete({ where: { id: sessionId } }).catch(e => this.logger.warn(e.message));
  }

  private buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUserHelper(dbUser);
  }
}
