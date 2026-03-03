// =====================================================================
// TOLVINK — WhatsApp Conversational Flow Service
// Manages multi-step WhatsApp interactions (reject, confirm loaded, etc.)
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { FreightsService } from '../freights/freights.service';
import { buildSyntheticUser as buildSyntheticUserHelper } from '../common/build-synthetic-user';
import { SelectionItem, resolveSelectionReply } from '../common/selection-helpers';
import { fuzzySearch, classifyFuzzyResult, GRAIN_ALIASES } from '../common/fuzzy-match';

const FLOW_TIMEOUT_MINUTES = 10;

// Header hint shown at the top of every flow message
const FLOW_HINT = '_cancelar / menu_\n\n';

const APP_URL = process.env.FRONTEND_URL || 'https://tolvink.com';

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
        await this.createFreightStart(phone, session, user);
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
      await this.wa.sendText(phone, 'La sesión expiró. Escriba "menu" para comenzar de nuevo.');
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
          await this.createFreightContinue(phone, session, type, payload, user, state);
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
      'Indique el motivo del rechazo:\n\n_(Escriba "cancelar" para volver al menu)_',
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
      'Escriba el numero (ej: 30.5) o "cancelar" para volver.',
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
      'Indique el motivo de la cancelación:\n\n_(Escriba "cancelar" para volver al menu)_',
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

  // ======================== CREATE FREIGHT FLOW ==========================
  // Multi-step guided freight creation
  // Steps: grain → tons → truckCount → (ownFleet?) → (selectTruck?) → plant → lot → date(buttons) → time(list) → confirm

  private async createFreightStart(phone: string, session: any, user: any) {
    // Check if user is a producer
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      await this.wa.sendText(phone, 'Solo los usuarios con perfil de productor pueden crear fletes.');
      await this.endFlow(session.id);
      return;
    }

    // Store producer company ID in flow state for later steps
    await this.updateState(session.id, 'awaiting_grain', { producerCompanyId });
    await this.wa.sendList(phone,
      FLOW_HINT + 'Inicio de creación de flete.\nPodrá modificar los datos antes de confirmar.\n\nIndique el tipo de grano:',
      'SELECCIONAR GRANO',
      [{
        title: 'TIPO DE GRANO',
        rows: [
          { id: 'grain:Soja', title: 'SOJA' },
          { id: 'grain:Maiz', title: 'MAÍZ' },
          { id: 'grain:Trigo', title: 'TRIGO' },
          { id: 'grain:Girasol', title: 'GIRASOL' },
          { id: 'grain:Sorgo', title: 'SORGO' },
          { id: 'grain:Cebada', title: 'CEBADA' },
          { id: 'grain:Otros', title: 'OTROS' },
        ],
      }],
    );
  }

  private async createFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    const step = session.flowStep;

    // ---- Generic: handle "Mostrar más" from interactive list pagination ----
    if (type === 'list_reply' && payload.id === '__show_more__' && state.selectionContext) {
      const ctx = state.selectionContext;
      const newPage = ctx.page + 1;
      if (newPage > ctx.totalPages) {
        await this.wa.sendText(phone, FLOW_HINT + 'No hay más opciones.');
        return;
      }
      const result = await this.wa.sendSelection(phone, ctx.items, { ...ctx.config, page: newPage });
      await this.updateState(session.id, step, {
        ...state,
        selectionContext: { ...ctx, page: result.page, shownItems: result.shownItems },
      });
      return;
    }

    // ---- Generic: resolve numbered text replies for any step with selectionContext ----
    if (type === 'text' && state.selectionContext) {
      const resolved = resolveSelectionReply(payload.body?.trim() || '', state.selectionContext);
      if (resolved === 'next_page' || resolved === 'prev_page') {
        const ctx = state.selectionContext;
        const newPage = resolved === 'next_page' ? ctx.page + 1 : ctx.page - 1;
        if (newPage < 1 || newPage > ctx.totalPages) {
          await this.wa.sendText(phone, FLOW_HINT + 'No hay más opciones.');
          return;
        }
        const result = await this.wa.sendSelection(phone, ctx.items, { ...ctx.config, page: newPage });
        await this.updateState(session.id, step, {
          ...state,
          selectionContext: { ...ctx, page: result.page, shownItems: result.shownItems },
        });
        return;
      }
      if (resolved && typeof resolved === 'object') {
        // Clear selectionContext and re-invoke as synthetic list_reply
        const { selectionContext: _sc, ...cleanState } = state;
        await this.prisma.whatsAppSession.update({
          where: { id: session.id },
          data: { flowState: cleanState },
        });
        const synPayload = { id: resolved.id, title: resolved.title };
        return this.createFreightContinue(phone, session, 'list_reply', synPayload, user, cleanState);
      }
      // Not a valid selection reply — clear stale context, fall through
      const { selectionContext: _sc, ...cleanState } = state;
      state = cleanState;
    }

    // ---- Step: Grain Selection ----
    if (step === 'awaiting_grain') {
      let grain: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('grain:')) {
        grain = payload.id.split(':')[1];
      } else if (type === 'text') {
        // Allow text input — fuzzy match for audio transcription tolerance
        const g = payload.body?.trim();
        if (g) {
          const grainItems = ['Soja', 'Maiz', 'Trigo', 'Girasol', 'Sorgo', 'Cebada', 'Otros'];
          const results = fuzzySearch(g, grainItems, (x) => x, { aliases: GRAIN_ALIASES, threshold: 0.65 });
          const cls = classifyFuzzyResult(results);
          if (cls === 'exact' || cls === 'confident') {
            grain = results[0].item;
          }
        }
      }

      if (!grain) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione un grano de la lista o escriba el nombre (Soja, Maíz, Trigo, etc.).');
        return;
      }

      const newState = { ...state, grain };
      if (state.editing) {
        delete newState.editing;
        await this.showConfirmation(phone, session, newState);
        return;
      }
      await this.updateState(session.id, 'awaiting_tons', newState);
      await this.wa.sendText(phone, FLOW_HINT + `Grano: ${grain}\n\nIndique las toneladas a cargar (ej: 30)`);
      return;
    }

    // ---- Step: Tons ----
    if (step === 'awaiting_tons') {
      if (type !== 'text') {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique la cantidad de toneladas (ej: 30).');
        return;
      }

      const tons = parseFloat(payload.body?.trim().replace(',', '.'));
      if (isNaN(tons) || tons <= 0) {
        await this.wa.sendText(phone, FLOW_HINT + 'Ingrese un número válido (ej: 30).');
        return;
      }

      if (state.editing) {
        const newState = { ...state, tons };
        delete newState.editing;
        await this.showConfirmation(phone, session, newState);
        return;
      }

      // Calculate suggested truck count (30 tn standard capacity)
      const suggested = Math.max(1, Math.ceil(tons / 30));
      await this.updateState(session.id, 'awaiting_truck_count', { ...state, tons });

      const truckWord = suggested === 1 ? 'camión' : 'camiones';
      await this.wa.sendButtons(phone,
        FLOW_HINT +
        `${state.grain}, ${tons} tn\n\n` +
        `Para ${tons} tn se necesita${suggested > 1 ? 'n' : ''} aprox. ${suggested} ${truckWord}.\n` +
        `Indique la cantidad de camiones:`,
        [
          { id: `trucks:${suggested}`, title: `${suggested} ${truckWord.toUpperCase()}` },
          { id: 'trucks:other', title: 'OTRA CANTIDAD' },
        ],
      );
      return;
    }

    // ---- Step: Truck Count ----
    if (step === 'awaiting_truck_count') {
      let truckCount: number | null = null;

      if (type === 'button_reply') {
        if (payload.id === 'trucks:other') {
          await this.updateState(session.id, 'awaiting_truck_count_input', state);
          await this.wa.sendText(phone, FLOW_HINT + 'Indique la cantidad de camiones (escriba el número)');
          return;
        }
        if (payload.id?.startsWith('trucks:')) {
          truckCount = parseInt(payload.id.split(':')[1], 10);
        }
      } else if (type === 'text') {
        truckCount = parseInt(payload.body?.trim(), 10);
      }

      if (!truckCount || truckCount < 1 || truckCount > 50) {
        await this.wa.sendText(phone, FLOW_HINT + 'Ingrese un número entre 1 y 50.');
        return;
      }

      await this.afterTruckCount(phone, session, { ...state, truckCount });
      return;
    }

    // ---- Step: Truck Count Custom Input ----
    if (step === 'awaiting_truck_count_input') {
      if (type !== 'text') {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique la cantidad de camiones (ej: 3).');
        return;
      }
      const truckCount = parseInt(payload.body?.trim(), 10);
      if (!truckCount || truckCount < 1 || truckCount > 50) {
        await this.wa.sendText(phone, FLOW_HINT + 'Ingrese un número válido entre 1 y 50.');
        return;
      }
      await this.afterTruckCount(phone, session, { ...state, truckCount });
      return;
    }

    // ---- Step: Own Fleet Decision ----
    if (step === 'awaiting_own_fleet') {
      let useOwnFleet = false;
      if (type === 'button_reply') {
        useOwnFleet = payload.id === 'own_fleet:yes';
      } else if (type === 'text') {
        useOwnFleet = /^(si|sí|yes)$/i.test(payload.body?.trim());
      }

      if (!useOwnFleet) {
        // Skip to plant selection
        await this.sendPlantSelection(phone, session, state);
        return;
      }

      // Show available trucks
      const trucks = await this.prisma.truck.findMany({
        where: { companyId: state.producerCompanyId, active: true },
        include: { assignedUser: { select: { id: true, name: true } } },
        take: 30,
      });

      if (trucks.length === 0) {
        await this.wa.sendText(phone, 'No se encontraron camiones registrados. Se continúa sin flota propia.');
        await this.sendPlantSelection(phone, session, state);
        return;
      }

      const items: SelectionItem[] = trucks.map((t: any) => {
        const driver = t.assignedUser?.name ? ` - ${t.assignedUser.name}` : '';
        const info = [t.brand, t.model].filter(Boolean).join(' ');
        return {
          id: `truck:${t.id}`,
          title: t.plate.toUpperCase().slice(0, 24),
          description: `${info}${driver}`.slice(0, 72) || undefined,
        };
      });

      const selConfig = {
        headerText: FLOW_HINT + 'Seleccione un camión de su flota:',
        listButtonLabel: 'VER CAMIONES',
        sectionTitle: 'CAMIONES DISPONIBLES',
      };
      const result = await this.wa.sendSelection(phone, items, selConfig);
      const newState: any = { ...state };
      if (result.totalPages > 1) {
        newState.selectionContext = {
          items, shownItems: result.shownItems,
          page: result.page, totalPages: result.totalPages, pageSize: 20,
          purpose: 'truck_select', config: selConfig,
        };
      }
      await this.updateState(session.id, 'awaiting_truck_select', newState);
      return;
    }

    // ---- Step: Truck Selection ----
    if (step === 'awaiting_truck_select') {
      let truckId: string | null = null;
      if ((type === 'list_reply' || type === 'button_reply') && payload.id?.startsWith('truck:')) {
        truckId = payload.id.split(':')[1];
      }

      if (!truckId) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione un camión de la lista.');
        return;
      }

      // Get truck plate for summary — verify ownership
      const truck = await this.prisma.truck.findFirst({
        where: { id: truckId, companyId: state.producerCompanyId, active: true },
        select: { plate: true },
      });
      if (!truck) {
        await this.wa.sendText(phone, FLOW_HINT + 'El camión seleccionado no pertenece a su empresa.');
        return;
      }

      const newState = { ...state, truckId, truckPlate: truck.plate || '' };
      await this.sendPlantSelection(phone, session, newState);
      return;
    }

    // ---- Step: Plant Selection ----
    if (step === 'awaiting_plant') {
      let companyId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('plant:')) {
        companyId = payload.id.split(':')[1];
      } else if (type === 'button_reply' && payload.id?.startsWith('plant:')) {
        companyId = payload.id.split(':')[1];
      }

      if (!companyId) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione una planta de la lista.');
        return;
      }

      // Check for physical branches (Plant records) of this company
      const branches = await this.prisma.plant.findMany({
        where: { companyId, active: true },
        select: { id: true, name: true, address: true },
        take: 30,
      });

      let plantId = companyId; // Default: company ID (fallback path in freights.service)

      if (branches.length === 1) {
        // Single branch → auto-select
        plantId = branches[0].id;
      } else if (branches.length > 1) {
        // Multiple branches → show selection
        const branchItems: SelectionItem[] = branches.map(b => ({
          id: `branch:${b.id}`,
          title: b.name.toUpperCase().slice(0, 24),
          description: b.address?.slice(0, 72) || '',
        }));
        const selConfig = {
          headerText: FLOW_HINT + 'Seleccione la sucursal:',
          listButtonLabel: 'VER SUCURSALES',
          sectionTitle: 'SUCURSALES',
        };
        const result = await this.wa.sendSelection(phone, branchItems, selConfig);
        const branchState: any = {
          ...state, destCompanyId: companyId, editing: state.editing || false,
        };
        if (result.totalPages > 1) {
          branchState.selectionContext = {
            items: branchItems, shownItems: result.shownItems,
            page: result.page, totalPages: result.totalPages, pageSize: 20,
            purpose: 'branch_select', config: selConfig,
          };
        }
        await this.updateState(session.id, 'awaiting_plant_branch', branchState);
        return;
      }
      // 0 or 1 branch → continue with plantId
      await this.afterPlantSelected(phone, session, state, plantId);
      return;
    }

    // ---- Step: Plant Branch Selection ----
    if (step === 'awaiting_plant_branch') {
      let branchId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('branch:')) {
        branchId = payload.id.split(':')[1];
      }

      if (!branchId) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione una sucursal de la lista.');
        return;
      }

      await this.afterPlantSelected(phone, session, state, branchId);
      return;
    }

    // ---- Step: Custom Dest Name (no plants available) ----
    if (step === 'awaiting_dest_name') {
      if (type !== 'text' || !payload.body?.trim()) {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique el nombre del destino.');
        return;
      }
      const customDestName = payload.body.trim();
      const destState = { ...state, customDestName };
      // Location is mandatory for custom destination
      await this.sendDestLocationPrompt(phone, session, destState);
      return;
    }

    // ---- Step: Custom Dest Location (mandatory) ----
    if (step === 'awaiting_dest_location') {
      let lat: number | null = null;
      let lng: number | null = null;

      if (type === 'location') {
        lat = payload.latitude;
        lng = payload.longitude;
      } else if (type === 'button_reply' && payload.id === 'location_done') {
        // Picker saved → check lastLocation in fresh session
        const freshSess = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
        const freshState = (freshSess?.flowState as any) || {};
        if (freshState.lastLocation) {
          lat = freshState.lastLocation.lat;
          lng = freshState.lastLocation.lng;
        } else {
          await this.wa.sendButtons(phone,
            FLOW_HINT + 'Aún no se ha registrado la ubicación. Comparta su ubicación desde WhatsApp o marque el punto en el enlace:\n' +
            (state.locationToken?.slug ? `${APP_URL}/campo/${state.locationToken.slug}/ubicacion` : ''),
            [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
          );
          return;
        }
      } else {
        const pickerUrl = state.locationToken?.slug ? `\n${APP_URL}/campo/${state.locationToken.slug}/ubicacion` : '';
        await this.wa.sendButtons(phone,
          FLOW_HINT + 'Debe compartir su ubicación desde WhatsApp o usar el enlace provisto. No se aceptan direcciones en texto.' + pickerUrl,
          [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
        );
        return;
      }

      const locState = { ...state, customDestLat: lat, customDestLng: lng };
      delete locState.locationToken;
      delete locState.lastLocation;

      if (state.editing) {
        delete locState.editing;
        await this.showConfirmation(phone, session, locState);
        return;
      }

      // Continue to lot/origin selection (logic previously in awaiting_dest_name)
      await this.afterDestLocationConfirmed(phone, session, locState);
      return;
    }

    // ---- Step: Custom Origin Name ----
    if (step === 'awaiting_origin_name') {
      if (type !== 'text' || !payload.body?.trim()) {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique el nombre del campo o lugar de origen.');
        return;
      }
      const customOriginName = payload.body.trim();
      const originState = { ...state, customOriginName };
      // Ask for location before continuing
      await this.sendOriginLocationPrompt(phone, session, originState);
      return;
    }

    // ---- Step: Origin Location (mandatory) ----
    if (step === 'awaiting_origin_location') {
      let lat: number | null = null;
      let lng: number | null = null;

      if (type === 'location') {
        lat = payload.latitude;
        lng = payload.longitude;
      } else if (type === 'button_reply' && payload.id === 'location_done') {
        // Picker saved → check lastLocation in fresh session
        const freshSess = await this.prisma.whatsAppSession.findUnique({ where: { id: session.id } });
        const freshState = (freshSess?.flowState as any) || {};
        if (freshState.lastLocation) {
          lat = freshState.lastLocation.lat;
          lng = freshState.lastLocation.lng;
        } else {
          await this.wa.sendButtons(phone,
            FLOW_HINT + 'Aún no se ha registrado la ubicación. Comparta su ubicación desde WhatsApp o marque el punto en el enlace:\n' +
            (state.locationToken?.slug ? `${APP_URL}/campo/${state.locationToken.slug}/ubicacion` : ''),
            [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
          );
          return;
        }
      } else {
        const pickerUrl = state.locationToken?.slug ? `\n${APP_URL}/campo/${state.locationToken.slug}/ubicacion` : '';
        await this.wa.sendButtons(phone,
          FLOW_HINT + 'Debe compartir su ubicación desde WhatsApp o usar el enlace provisto. No se aceptan direcciones en texto.' + pickerUrl,
          [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
        );
        return;
      }

      const locState = { ...state, originLat: lat, originLng: lng };
      delete locState.locationToken;
      delete locState.lastLocation;

      if (state.editing) {
        delete locState.editing;
        await this.showConfirmation(phone, session, locState);
        return;
      }
      await this.sendDateSelection(phone, session, locState);
      return;
    }

    // ---- Step: Lot Selection ----
    if (step === 'awaiting_lot') {
      if (type === 'list_reply' && payload.id === 'lot:custom') {
        // User wants to enter a custom origin
        await this.updateState(session.id, 'awaiting_origin_name', state);
        await this.wa.sendText(phone, FLOW_HINT + 'Indique el nombre del campo o lugar de origen.');
        return;
      }

      let lotId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('lot:')) {
        lotId = payload.id.split(':')[1];
      }

      if (!lotId) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione un lote de la lista.');
        return;
      }

      const lotState = { ...state, originLotId: lotId };
      if (state.editing) {
        delete lotState.editing;
        await this.showConfirmation(phone, session, lotState);
        return;
      }
      await this.sendDateSelection(phone, session, lotState);
      return;
    }

    // ---- Step: Date (buttons) ----
    if (step === 'awaiting_date') {
      let loadDate: string | null = null;

      if (type === 'button_reply') {
        if (payload.id === 'date:other') {
          await this.updateState(session.id, 'awaiting_date_input', state);
          await this.wa.sendText(phone, FLOW_HINT + 'Indique la fecha (dd/mm/aaaa).');
          return;
        }
        if (payload.id === 'date:today') {
          loadDate = new Date().toISOString().split('T')[0];
        } else if (payload.id === 'date:tomorrow') {
          const d = new Date(); d.setDate(d.getDate() + 1);
          loadDate = d.toISOString().split('T')[0];
        } else if (payload.id === 'date:day_after') {
          const d = new Date(); d.setDate(d.getDate() + 2);
          loadDate = d.toISOString().split('T')[0];
        }
      } else if (type === 'text') {
        // Allow text shortcuts
        const text = payload.body?.trim().toLowerCase();
        if (text === 'hoy') {
          loadDate = new Date().toISOString().split('T')[0];
        } else if (text === 'manana' || text === 'mañana') {
          const d = new Date(); d.setDate(d.getDate() + 1);
          loadDate = d.toISOString().split('T')[0];
        } else {
          const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
          if (match) {
            loadDate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
          }
        }
      }

      if (!loadDate) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione una fecha o indique dd/mm/aaaa.');
        return;
      }

      // Validate date is today or in the future
      const parsedDate = new Date(loadDate + 'T00:00:00');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (isNaN(parsedDate.getTime()) || parsedDate < today) {
        await this.wa.sendText(phone, FLOW_HINT + 'La fecha debe ser hoy o posterior.');
        return;
      }

      const dateState = { ...state, loadDate };
      if (state.editing) {
        delete dateState.editing;
        await this.showConfirmation(phone, session, dateState);
        return;
      }
      await this.sendTimeSelection(phone, session, dateState);
      return;
    }

    // ---- Step: Date Custom Input ----
    if (step === 'awaiting_date_input') {
      if (type !== 'text') {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique la fecha (dd/mm/aaaa).');
        return;
      }
      const text = payload.body?.trim();
      const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (!match) {
        await this.wa.sendText(phone, FLOW_HINT + 'Formato inválido. Indique dd/mm/aaaa (ej: 25/02/2026).');
        return;
      }
      const loadDate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      const parsedInputDate = new Date(loadDate + 'T00:00:00');
      const todayInput = new Date(); todayInput.setHours(0, 0, 0, 0);
      if (isNaN(parsedInputDate.getTime()) || parsedInputDate < todayInput) {
        await this.wa.sendText(phone, FLOW_HINT + 'La fecha debe ser hoy o posterior. Indique dd/mm/aaaa.');
        return;
      }
      const dateInputState = { ...state, loadDate };
      if (state.editing) {
        delete dateInputState.editing;
        await this.showConfirmation(phone, session, dateInputState);
        return;
      }
      await this.sendTimeSelection(phone, session, dateInputState);
      return;
    }

    // ---- Step: Time (list) ----
    if (step === 'awaiting_time') {
      let loadTime: string | null = null;

      if (type === 'list_reply') {
        if (payload.id === 'time:other') {
          await this.updateState(session.id, 'awaiting_time_input', state);
          await this.wa.sendText(phone, FLOW_HINT + 'Indique la hora (HH:mm, ej: 14:30).');
          return;
        }
        if (payload.id?.startsWith('time:')) {
          loadTime = payload.id.split(':').slice(1).join(':'); // "time:08:00" → "08:00"
        }
      } else if (type === 'text') {
        const text = payload.body?.trim();
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (match) {
          const h = parseInt(match[1], 10), m = parseInt(match[2], 10);
          if (h <= 23 && m <= 59) {
            loadTime = `${match[1].padStart(2, '0')}:${match[2]}`;
          }
        }
      }

      if (!loadTime) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione un horario de la lista o indique HH:mm (ej: 14:30).');
        return;
      }

      const timeState = { ...state, loadTime };
      delete timeState.editing;
      await this.showConfirmation(phone, session, timeState);
      return;
    }

    // ---- Step: Time Custom Input ----
    if (step === 'awaiting_time_input') {
      if (type !== 'text') {
        await this.wa.sendText(phone, FLOW_HINT + 'Indique la hora (HH:mm, ej: 14:30).');
        return;
      }
      const text = payload.body?.trim();
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        await this.wa.sendText(phone, FLOW_HINT + 'Formato inválido. Indique HH:mm (ej: 14:30).');
        return;
      }
      const h = parseInt(match[1], 10), m = parseInt(match[2], 10);
      if (h > 23 || m > 59) {
        await this.wa.sendText(phone, FLOW_HINT + 'Hora inválida. Indique HH:mm (ej: 14:30).');
        return;
      }
      const loadTime = `${match[1].padStart(2, '0')}:${match[2]}`;
      const finalState = { ...state, loadTime };
      delete finalState.editing;
      await this.showConfirmation(phone, session, finalState);
      return;
    }

    // ---- Step: Edit Field Selection ----
    if (step === 'awaiting_edit_field') {
      let field: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('edit:')) {
        field = payload.id.split(':')[1];
      }

      if (!field) {
        await this.wa.sendText(phone, FLOW_HINT + 'Seleccione un campo de la lista para modificar.');
        return;
      }

      const editState = { ...state, editing: true };

      switch (field) {
        case 'grain':
          await this.updateState(session.id, 'awaiting_grain', editState);
          await this.wa.sendList(phone, FLOW_HINT + 'Seleccione el nuevo grano:', 'SELECCIONAR GRANO', [{
            title: 'TIPO DE GRANO',
            rows: [
              { id: 'grain:Soja', title: 'SOJA' },
              { id: 'grain:Maiz', title: 'MAÍZ' },
              { id: 'grain:Trigo', title: 'TRIGO' },
              { id: 'grain:Girasol', title: 'GIRASOL' },
              { id: 'grain:Sorgo', title: 'SORGO' },
              { id: 'grain:Cebada', title: 'CEBADA' },
              { id: 'grain:Otros', title: 'OTROS' },
            ],
          }]);
          break;
        case 'tons':
          await this.updateState(session.id, 'awaiting_tons', editState);
          await this.wa.sendText(phone, FLOW_HINT + `Toneladas actuales: ${state.tons}\n\nIndique las nuevas toneladas.`);
          break;
        case 'trucks':
          await this.updateState(session.id, 'awaiting_truck_count', editState);
          const suggested = Math.max(1, Math.ceil((state.tons || 30) / 30));
          const truckWord = suggested === 1 ? 'camión' : 'camiones';
          await this.wa.sendButtons(phone,
            FLOW_HINT + `Camiones actuales: ${state.truckCount || 1}\n\nIndique la cantidad de camiones:`,
            [
              { id: `trucks:${suggested}`, title: `${suggested} ${truckWord.toUpperCase()}` },
              { id: 'trucks:other', title: 'OTRA CANTIDAD' },
            ],
          );
          break;
        case 'plant':
          await this.sendPlantSelection(phone, session, editState);
          break;
        case 'origin':
          const lots = await this.prisma.lot.findMany({
            where: { companyId: state.producerCompanyId, active: true },
            include: { field: { select: { id: true, name: true } } },
            take: 9,
          });
          if (lots.length === 0) {
            await this.updateState(session.id, 'awaiting_origin_name', editState);
            await this.wa.sendText(phone, FLOW_HINT + 'Indique el nuevo nombre del campo o lugar de origen.');
          } else {
            await this.updateState(session.id, 'awaiting_lot', editState);
            await this.wa.sendList(phone, FLOW_HINT + 'Seleccione el nuevo lote:', 'SELECCIONAR LOTE', [{
              title: 'LOTES REGISTRADOS',
              rows: [
                ...lots.map((l: any) => ({
                  id: `lot:${l.id}`,
                  title: l.name.toUpperCase().slice(0, 24),
                  description: l.field?.name?.slice(0, 72) || '',
                })),
                { id: 'lot:custom', title: 'OTRO ORIGEN', description: 'Ingresar manualmente' },
              ],
            }]);
          }
          break;
        case 'date':
          await this.sendDateSelection(phone, session, editState);
          break;
        case 'time':
          await this.sendTimeSelection(phone, session, editState);
          break;
        default:
          await this.wa.sendText(phone, 'Campo no reconocido. Intente nuevamente.');
          await this.showConfirmation(phone, session, state);
      }
      return;
    }

    // ---- Step: Confirmation ----
    if (step === 'awaiting_confirm') {
      // Handle edit button
      if (type === 'button_reply' && payload.id === 'flow_confirm:edit') {
        await this.showEditMenu(phone, session, state);
        return;
      }

      let confirmed = false;
      if (type === 'button_reply') {
        confirmed = payload.id === 'flow_confirm:yes';
      } else if (type === 'text') {
        confirmed = /^(si|sí|yes|confirmar)$/i.test(payload.body?.trim());
      }

      if (!confirmed) {
        await this.wa.sendText(phone, 'Creación de flete cancelada.');
        await this.endFlow(session.id);
        return;
      }

      // Execute freight creation
      const synUser = this.buildSyntheticUser(user);
      // Ensure synUser resolves as producer with the correct company
      synUser.companyId = state.producerCompanyId;
      synUser.companyType = 'producer';
      synUser.userType = 'producer';

      const dto: any = {
        items: [{ grain: state.grain, tons: parseFloat(state.tons) }],
        loadDate: state.loadDate,
        loadTime: state.loadTime,
        truckCount: state.truckCount || 1,
      };

      // Own fleet decision (persisted on freight)
      dto.useOwnFleet = state.truckId ? true : false;

      // Own fleet truck assignment
      if (state.truckId) {
        dto.truckId = state.truckId;
      }

      // Destination: plant ID or custom name + coordinates
      if (state.destPlantId) {
        dto.destPlantId = state.destPlantId;
      } else if (state.customDestName) {
        dto.customDestName = state.customDestName;
        if (state.customDestLat != null) dto.overrideDestLat = state.customDestLat;
        if (state.customDestLng != null) dto.overrideDestLng = state.customDestLng;
      }

      // Origin: lot ID or custom origin name + coordinates
      if (state.originLotId) {
        dto.originLotId = state.originLotId;
      } else {
        dto.customOriginName = state.customOriginName || 'Origen WhatsApp';
        dto.overrideOriginLat = state.originLat ?? null;
        dto.overrideOriginLng = state.originLng ?? null;
      }

      const freight = await this.freights.create(dto as any, synUser);

      // Generate shareToken for public tracking link
      const shareToken = require('crypto').randomUUID();
      await this.prisma.freight.update({ where: { id: (freight as any).id }, data: { shareToken } });

      const code = (freight as any).code;
      const freightLink = `\n\n${APP_URL}/${code}/ubicacion?s=${shareToken}`;
      const successMsg = state.truckId
        ? `✅ Flete creado: ${code}\n🚛 Asignado a flota propia (${state.truckPlate || 'camión asignado'}).` + freightLink
        : `✅ Flete creado: ${code}\n📋 Pendiente de asignación de transportista.` + freightLink;
      await this.wa.sendText(phone, successMsg);
      await this.endFlow(session.id);
      return;
    }

    // Fallback
    await this.wa.sendText(phone, FLOW_HINT + 'No se pudo interpretar su respuesta. Intente nuevamente.');
  }

  // ======================== CREATE FREIGHT HELPERS ========================

  /** After truck count is confirmed, check own fleet or go to plant selection */
  private async afterTruckCount(phone: string, session: any, state: any) {
    // If editing, go straight back to confirmation
    if (state.editing) {
      const newState = { ...state };
      delete newState.editing;
      await this.showConfirmation(phone, session, newState);
      return;
    }

    // Check if producer has own fleet
    const company = await this.prisma.company.findUnique({
      where: { id: state.producerCompanyId },
      select: { hasInternalFleet: true },
    });

    if (company?.hasInternalFleet) {
      await this.updateState(session.id, 'awaiting_own_fleet', state);
      await this.wa.sendButtons(phone,
        FLOW_HINT + `Camiones: ${state.truckCount}\n\n¿Desea utilizar su flota propia?`,
        [
          { id: 'own_fleet:yes', title: 'SI, FLOTA PROPIA' },
          { id: 'own_fleet:no', title: 'NO' },
        ],
      );
      return;
    }

    // No own fleet → go to plant selection
    await this.sendPlantSelection(phone, session, state);
  }

  /** After a plant (or branch) is selected, continue to lot selection or confirmation */
  private async afterPlantSelected(phone: string, session: any, state: any, plantId: string) {
    if (state.editing) {
      const newState = { ...state, destPlantId: plantId };
      delete newState.editing;
      await this.showConfirmation(phone, session, newState);
      return;
    }

    // Fetch available lots for this producer's company
    const lots = await this.prisma.lot.findMany({
      where: { companyId: state.producerCompanyId, active: true },
      include: { field: { select: { id: true, name: true } } },
      take: 30,
    });

    if (lots.length === 0) {
      // No lots → ask for custom origin name
      await this.updateState(session.id, 'awaiting_origin_name', { ...state, destPlantId: plantId });
      await this.wa.sendText(phone,
        FLOW_HINT + 'No se encontraron lotes registrados.\n' +
        'Indique el nombre del campo o lugar de origen.');
      return;
    }

    const lotItems: SelectionItem[] = lots.map((l: any) => ({
      id: `lot:${l.id}`,
      title: l.name.toUpperCase().slice(0, 24),
      description: l.field?.name?.slice(0, 72) || '',
    }));
    const lotConfig = {
      headerText: FLOW_HINT + 'Indicar desde qué lote / campo se carga.',
      listButtonLabel: 'SELECCIONAR LOTE',
      sectionTitle: 'LOTES REGISTRADOS',
      footer: { id: 'lot:custom', title: 'OTRO ORIGEN', description: 'Ingresar manualmente' },
    };
    const lotResult = await this.wa.sendSelection(phone, lotItems, lotConfig);
    const lotState: any = { ...state, destPlantId: plantId };
    if (lotResult.totalPages > 1) {
      lotState.selectionContext = {
        items: lotItems, shownItems: lotResult.shownItems,
        page: lotResult.page, totalPages: lotResult.totalPages, pageSize: 20,
        footer: lotConfig.footer, purpose: 'lot_select', config: lotConfig,
      };
    }
    await this.updateState(session.id, 'awaiting_lot', lotState);
  }

  /** Show plant selection (reused from multiple steps) */
  private async sendPlantSelection(phone: string, session: any, state: any) {
    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: state.producerCompanyId, active: true },
      select: { plantCompanyId: true },
    });

    let plantCompanies: any[] = [];
    if (accessRecords.length > 0) {
      const plantCompanyIds = [...new Set(accessRecords.map(ar => ar.plantCompanyId))];
      plantCompanies = await this.prisma.company.findMany({
        where: { id: { in: plantCompanyIds }, active: true },
        select: { id: true, name: true },
        take: 30,
      });
    }

    if (plantCompanies.length === 0) {
      await this.updateState(session.id, 'awaiting_dest_name', state);
      await this.wa.sendText(phone,
        FLOW_HINT + 'No se encontraron plantas habilitadas.\n' +
        'Indique el nombre del destino o solicite acceso a una planta desde la plataforma.');
      return;
    }

    const plantItems: SelectionItem[] = plantCompanies.map((c: any) => ({
      id: `plant:${c.id}`,
      title: c.name.toUpperCase().slice(0, 24),
    }));
    const plantConfig = {
      headerText: FLOW_HINT + `${state.grain}, ${state.tons} tn, ${state.truckCount} camión${state.truckCount > 1 ? 'es' : ''}\n\nIndique la empresa destino.`,
      listButtonLabel: 'SELECCIONAR PLANTA',
      sectionTitle: 'PLANTAS DISPONIBLES',
    };
    const result = await this.wa.sendSelection(phone, plantItems, plantConfig);
    const plantState: any = { ...state };
    if (result.totalPages > 1) {
      plantState.selectionContext = {
        items: plantItems, shownItems: result.shownItems,
        page: result.page, totalPages: result.totalPages, pageSize: 20,
        purpose: 'plant_select', config: plantConfig,
      };
    }
    await this.updateState(session.id, 'awaiting_plant', plantState);
  }

  /** Show date selection buttons */
  private async sendDateSelection(phone: string, session: any, state: any) {
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const dayAfter = new Date(); dayAfter.setDate(today.getDate() + 2);

    const fmt = (d: Date) => `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;

    await this.updateState(session.id, 'awaiting_date', state);
    await this.wa.sendButtons(phone,
      FLOW_HINT + 'Indicar qué día es la carga.',
      [
        { id: 'date:today', title: `HOY ${fmt(today)}` },
        { id: 'date:tomorrow', title: `MAÑANA ${fmt(tomorrow)}` },
        { id: 'date:other', title: 'OTRA FECHA' },
      ],
    );
  }

  /** Show time selection list with common loading hours */
  private async sendTimeSelection(phone: string, session: any, state: any) {
    const dateFormatted = state.loadDate.split('-').reverse().join('/');

    await this.updateState(session.id, 'awaiting_time', state);
    await this.wa.sendList(phone,
      FLOW_HINT + `Fecha: ${dateFormatted}\n\nIndique la hora de carga.`,
      'SELECCIONAR HORA',
      [{
        title: 'HORARIOS',
        rows: [
          { id: 'time:05:00', title: '05:00' },
          { id: 'time:06:00', title: '06:00' },
          { id: 'time:07:00', title: '07:00' },
          { id: 'time:08:00', title: '08:00' },
          { id: 'time:09:00', title: '09:00' },
          { id: 'time:10:00', title: '10:00' },
          { id: 'time:12:00', title: '12:00' },
          { id: 'time:14:00', title: '14:00' },
          { id: 'time:16:00', title: '16:00' },
          { id: 'time:other', title: 'OTRO HORARIO', description: 'Indicar hora manualmente' },
        ],
      }],
    );
  }

  /** Generate a location picker token and URL (pure, no DB write) */
  private generateLocationToken(purpose: string): { token: string; slug: string; url: string; data: any } {
    const crypto = require('crypto');
    const token = crypto.randomUUID();
    const slug = `${purpose}-${crypto.randomBytes(4).toString('hex')}`;
    const url = `${APP_URL}/campo/${slug}/ubicacion`;
    return { token, slug, url, data: { token, slug, purpose, createdAt: new Date().toISOString() } };
  }

  /** Prompt the user to share their origin location (mandatory) */
  private async sendOriginLocationPrompt(phone: string, session: any, state: any) {
    const loc = this.generateLocationToken('origin');
    const stateWithToken = { ...state, locationToken: loc.data };
    await this.updateState(session.id, 'awaiting_origin_location', stateWithToken);
    await this.wa.sendButtons(phone,
      FLOW_HINT +
      `Origen: ${state.customOriginName}\n\n` +
      'Ahora necesito la ubicación exacta.\n' +
      'Puede compartir su ubicación desde WhatsApp o marcar el punto en el siguiente enlace:\n' +
      `${loc.url}\n\n` +
      'Sin ubicación no es posible continuar.',
      [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
    );
  }

  /** Prompt the user to share their destination location (mandatory) */
  private async sendDestLocationPrompt(phone: string, session: any, state: any) {
    const loc = this.generateLocationToken('destination');
    const stateWithToken = { ...state, locationToken: loc.data };
    await this.updateState(session.id, 'awaiting_dest_location', stateWithToken);
    await this.wa.sendButtons(phone,
      FLOW_HINT +
      `Destino: ${state.customDestName}\n\n` +
      'Ahora necesito la ubicación exacta.\n' +
      'Puede compartir su ubicación desde WhatsApp o marcar el punto en el siguiente enlace:\n' +
      `${loc.url}\n\n` +
      'Sin ubicación no es posible continuar.',
      [{ id: 'location_done', title: 'UBICACIÓN LISTA' }],
    );
  }

  /** After custom dest location is confirmed, continue to lot/origin selection */
  private async afterDestLocationConfirmed(phone: string, session: any, state: any) {
    const lots = await this.prisma.lot.findMany({
      where: { companyId: state.producerCompanyId, active: true },
      include: { field: { select: { id: true, name: true } } },
      take: 30,
    });

    if (lots.length === 0) {
      await this.updateState(session.id, 'awaiting_origin_name', state);
      await this.wa.sendText(phone, FLOW_HINT + 'Indique el nombre del campo o lugar de origen.');
      return;
    }

    const lotItems: SelectionItem[] = lots.map((l: any) => ({
      id: `lot:${l.id}`,
      title: l.name.toUpperCase().slice(0, 24),
      description: l.field?.name?.slice(0, 72) || '',
    }));
    const lotConfig = {
      headerText: FLOW_HINT + 'Indicar desde qué lote / campo se carga.',
      listButtonLabel: 'SELECCIONAR LOTE',
      sectionTitle: 'LOTES REGISTRADOS',
      footer: { id: 'lot:custom', title: 'OTRO ORIGEN', description: 'Ingresar manualmente' },
    };
    const lotResult = await this.wa.sendSelection(phone, lotItems, lotConfig);
    const lotState: any = { ...state };
    if (lotResult.totalPages > 1) {
      lotState.selectionContext = {
        items: lotItems, shownItems: lotResult.shownItems,
        page: lotResult.page, totalPages: lotResult.totalPages, pageSize: 20,
        footer: lotConfig.footer, purpose: 'lot_select', config: lotConfig,
      };
    }
    await this.updateState(session.id, 'awaiting_lot', lotState);
  }

  /** Resolve destination name from Plant or Company */
  private async resolveDestName(destPlantId: string): Promise<string> {
    const plant = await this.prisma.plant.findUnique({
      where: { id: destPlantId },
      select: { name: true, company: { select: { name: true } } },
    });
    if (plant) return `${plant.company?.name || ''} - ${plant.name}`;
    const company = await this.prisma.company.findUnique({
      where: { id: destPlantId },
      select: { name: true },
    });
    return company?.name || 'Sin planta';
  }

  /** Show confirmation summary with all freight details */
  private async showConfirmation(phone: string, session: any, finalState: any) {
    let destName = finalState.customDestName || 'Destino';
    if (finalState.destPlantId) {
      destName = await this.resolveDestName(finalState.destPlantId);
    }
    if (finalState.customDestLat && !finalState.destPlantId) destName += ' (con ubicación)';

    let originName = finalState.customOriginName || 'Origen';
    if (finalState.originLotId) {
      const lot = await this.prisma.lot.findUnique({ where: { id: finalState.originLotId }, select: { name: true } });
      originName = lot?.name || originName;
    }
    if (finalState.originLat && !finalState.originLotId) originName += ' (con ubicación)';

    const dateFormatted = finalState.loadDate.split('-').reverse().join('/');
    const truckCount = finalState.truckCount || 1;
    const truckLine = finalState.truckPlate
      ? `${truckCount} camión${truckCount > 1 ? 'es' : ''} - Flota propia (${finalState.truckPlate})`
      : `${truckCount} camión${truckCount > 1 ? 'es' : ''}`;

    await this.updateState(session.id, 'awaiting_confirm', finalState);
    await this.wa.sendButtons(phone,
      `📋 Resumen del flete\n\n` +
      `📦 Carga: ${finalState.grain}, ${finalState.tons} tn\n` +
      `🚛 Transporte: ${truckLine}\n` +
      `📍 Origen: ${originName}\n` +
      `📍 Destino: ${destName}\n` +
      `📅 Fecha: ${dateFormatted} ${finalState.loadTime}\n\n` +
      `¿Confirma la creación del flete?`,
      [
        { id: 'flow_confirm:yes', title: 'CONFIRMAR' },
        { id: 'flow_confirm:edit', title: 'EDITAR' },
        { id: 'flow_confirm:no', title: 'CANCELAR' },
      ],
    );
  }

  /** Show edit menu with current values for each field */
  private async showEditMenu(phone: string, session: any, state: any) {
    // Resolve names for descriptions
    let destDesc = state.customDestName || 'Sin planta';
    if (state.destPlantId) {
      destDesc = await this.resolveDestName(state.destPlantId);
    }
    let originDesc = state.customOriginName || 'Sin origen';
    if (state.originLotId) {
      const lot = await this.prisma.lot.findUnique({ where: { id: state.originLotId }, select: { name: true } });
      originDesc = lot?.name || originDesc;
    }
    const dateDesc = state.loadDate?.split('-').reverse().join('/') || '';

    await this.updateState(session.id, 'awaiting_edit_field', state);
    await this.wa.sendList(phone,
      FLOW_HINT + 'Seleccione el campo que desea modificar.',
      'VER CAMPOS',
      [{
        title: 'CAMPOS EDITABLES',
        rows: [
          { id: 'edit:grain',  title: 'GRANO',     description: state.grain || '' },
          { id: 'edit:tons',   title: 'TONELADAS', description: `${state.tons} tn` },
          { id: 'edit:trucks', title: 'CAMIONES',  description: `${state.truckCount || 1}` },
          { id: 'edit:plant',  title: 'PLANTA',    description: destDesc.slice(0, 72) },
          { id: 'edit:origin', title: 'ORIGEN',    description: originDesc.slice(0, 72) },
          { id: 'edit:date',   title: 'FECHA',     description: dateDesc },
          { id: 'edit:time',   title: 'HORA',      description: state.loadTime || '' },
        ],
      }],
    );
  }

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

  /** Resolve the producer company ID from user data */
  private resolveProducerCompanyId(user: any): string | null {
    // Check memberships for a producer company
    if (user.memberships?.length > 0) {
      const pm = user.memberships.find((m: any) =>
        m.company?.type === 'producer' ||
        (Array.isArray(m.company?.types) && m.company.types.includes('producer')),
      );
      if (pm) return pm.companyId;
    }

    // Check userTypes + companyByType
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) {
      return companyByType.producer;
    }

    // Fallback to company type
    if (user.company?.type === 'producer') {
      return user.companyId;
    }

    // No fallback — only producer companies allowed
    return null;
  }

  private buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUserHelper(dbUser);
  }
}
