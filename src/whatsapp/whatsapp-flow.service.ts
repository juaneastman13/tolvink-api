// =====================================================================
// TOLVINK — WhatsApp Conversational Flow Service
// Manages multi-step WhatsApp interactions (reject, confirm loaded, etc.)
// =====================================================================

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { FreightsService } from '../freights/freights.service';

const FLOW_TIMEOUT_MINUTES = 10;

// Footer hint shown on every flow step so non-tech users always know their options
const FLOW_HINT = '\n\n_Escribi *cancelar* para salir · *menu* para opciones_';

@Injectable()
export class WhatsAppFlowService {
  private readonly logger = new Logger(WhatsAppFlowService.name);

  constructor(
    private prisma: PrismaService,
    private wa: WhatsAppService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
  ) {}

  // ======================== START FLOW ==================================

  async startFlow(
    flowType: string,
    phone: string,
    user: any,
    initialData?: Record<string, any>,
  ) {
    // Clean up old sessions for this user
    await this.prisma.whatsAppSession.deleteMany({
      where: { userId: user.id },
    });

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
    const flowType = session.flowType;
    const flowStep = session.flowStep;
    const state = (session.flowState as any) || {};

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
          await this.wa.sendText(phone, 'Flujo no reconocido. Escribi *menu* para volver al inicio.');
          await this.endFlow(session.id);
      }
    } catch (e) {
      this.logger.error(`Flow "${flowType}" step "${flowStep}" error: ${e.message}`);
      await this.wa.sendText(phone, `Error: ${e.message}`);
      await this.endFlow(session.id);
    }
  }

  // ======================== REJECT FREIGHT FLOW =========================
  // Step 1: Ask for reason
  // Step 2: Execute rejection

  private async rejectFreightStart(phone: string, session: any) {
    await this.updateStep(session.id, 'awaiting_reason');
    await this.wa.sendText(phone,
      'Escribi el motivo del rechazo:\n\n_(Escribi "cancelar" para volver al menu)_',
    );
  }

  private async rejectFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    if (session.flowStep === 'awaiting_reason' && type === 'text') {
      const reason = payload.body?.trim();
      if (!reason || reason.length < 3) {
        await this.wa.sendText(phone, 'El motivo debe tener al menos 3 caracteres. Intenta de nuevo:');
        return;
      }

      const synUser = this.buildSyntheticUser(user);
      await this.freights.respond(state.freightId, { action: 'rejected', reason } as any, synUser);
      await this.wa.sendText(phone, `❌ Flete rechazado.\nMotivo: ${reason}`);
      await this.endFlow(session.id);
      return;
    }

    await this.wa.sendText(phone, 'Escribi el motivo del rechazo como texto:');
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
      `Cuantas toneladas se cargaron?\n` +
      `_(Planificadas: ${planned} tn)_\n\n` +
      'Escribi el numero (ej: 30.5) o "cancelar" para volver.',
    );
  }

  private async confirmLoadedContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    if (session.flowStep === 'awaiting_tons' && type === 'text') {
      const text = payload.body?.trim().replace(',', '.');
      const tons = parseFloat(text);

      if (isNaN(tons) || tons <= 0) {
        await this.wa.sendText(phone, 'Ingresa un numero valido de toneladas (ej: 30.5):');
        return;
      }

      if (tons > 100) {
        await this.wa.sendText(phone, `Ingresaste ${tons} tn. Parece mucho. Confirma escribiendo el numero nuevamente o escribi "cancelar":`);
        // Allow it through if they repeat
      }

      const synUser = this.buildSyntheticUser(user);
      await this.freights.confirmLoaded(state.freightId, synUser, tons);
      await this.wa.sendText(phone, `📦 Carga confirmada: *${tons} tn*`);
      await this.endFlow(session.id);
      return;
    }

    await this.wa.sendText(phone, 'Escribi la cantidad de toneladas cargadas (ej: 30.5):');
  }

  // ======================== CANCEL FREIGHT FLOW =========================
  // Step 1: Ask for reason
  // Step 2: Execute cancellation

  private async cancelFreightStart(phone: string, session: any) {
    await this.updateStep(session.id, 'awaiting_reason');
    await this.wa.sendText(phone,
      'Escribi el motivo de la cancelacion:\n\n_(Escribi "cancelar" para volver al menu)_',
    );
  }

  private async cancelFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    if (session.flowStep === 'awaiting_reason' && type === 'text') {
      const reason = payload.body?.trim();
      if (!reason || reason.length < 3) {
        await this.wa.sendText(phone, 'El motivo debe tener al menos 3 caracteres. Intenta de nuevo:');
        return;
      }

      const synUser = this.buildSyntheticUser(user);
      await this.freights.cancel(state.freightId, { reason } as any, synUser);
      await this.wa.sendText(phone, `❌ Flete cancelado.\nMotivo: ${reason}`);
      await this.endFlow(session.id);
      return;
    }

    await this.wa.sendText(phone, 'Escribi el motivo de la cancelacion como texto:');
  }

  // ======================== CREATE FREIGHT FLOW ==========================
  // Multi-step guided freight creation
  // Steps: grain → tons → truckCount → (ownFleet?) → (selectTruck?) → plant → lot → date(buttons) → time(list) → confirm

  private async createFreightStart(phone: string, session: any, user: any) {
    // Check if user is a producer
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      await this.wa.sendText(phone, 'Solo los productores pueden crear fletes.');
      await this.endFlow(session.id);
      return;
    }

    // Store producer company ID in flow state for later steps
    await this.updateState(session.id, 'awaiting_grain', { producerCompanyId });
    await this.wa.sendList(phone,
      'Vamos a crear un nuevo flete.\nSi necesitas corregir algo, vas a poder editarlo al final.' + FLOW_HINT + '\n\nQue grano vas a enviar?',
      'Seleccionar grano',
      [{
        title: 'Tipo de grano',
        rows: [
          { id: 'grain:Soja', title: 'Soja' },
          { id: 'grain:Maiz', title: 'Maiz' },
          { id: 'grain:Trigo', title: 'Trigo' },
          { id: 'grain:Girasol', title: 'Girasol' },
          { id: 'grain:Sorgo', title: 'Sorgo' },
          { id: 'grain:Cebada', title: 'Cebada' },
          { id: 'grain:Otros', title: 'Otros' },
        ],
      }],
    );
  }

  private async createFreightContinue(
    phone: string, session: any, type: string, payload: any, user: any, state: any,
  ) {
    const step = session.flowStep;

    // ---- Step: Grain Selection ----
    if (step === 'awaiting_grain') {
      let grain: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('grain:')) {
        grain = payload.id.split(':')[1];
      } else if (type === 'text') {
        // Allow text input
        const g = payload.body?.trim();
        const valid = ['soja', 'maiz', 'trigo', 'girasol', 'sorgo', 'cebada', 'otros'];
        const match = valid.find(v => v === g.toLowerCase());
        if (match) grain = match.charAt(0).toUpperCase() + match.slice(1);
      }

      if (!grain) {
        await this.wa.sendText(phone, 'Selecciona un grano de la lista o escribi el nombre (Soja, Maiz, Trigo, etc.).' + FLOW_HINT);
        return;
      }

      const newState = { ...state, grain };
      if (state.editing) {
        delete newState.editing;
        await this.showConfirmation(phone, session, newState);
        return;
      }
      await this.updateState(session.id, 'awaiting_tons', newState);
      await this.wa.sendText(phone, `Grano: *${grain}*\n\nCuantas toneladas? (ej: 30)` + FLOW_HINT);
      return;
    }

    // ---- Step: Tons ----
    if (step === 'awaiting_tons') {
      if (type !== 'text') {
        await this.wa.sendText(phone, 'Escribi la cantidad de toneladas (ej: 30).' + FLOW_HINT);
        return;
      }

      const tons = parseFloat(payload.body?.trim().replace(',', '.'));
      if (isNaN(tons) || tons <= 0) {
        await this.wa.sendText(phone, 'Ingresa un numero valido (ej: 30).' + FLOW_HINT);
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

      const truckWord = suggested === 1 ? 'camion' : 'camiones';
      await this.wa.sendButtons(phone,
        `Grano: *${state.grain}* | Toneladas: *${tons}*\n\n` +
        `Para ${tons} tn se necesita${suggested > 1 ? 'n' : ''} aprox. *${suggested} ${truckWord}*.\n` +
        `Cuantos camiones necesitas?` + FLOW_HINT,
        [
          { id: `trucks:${suggested}`, title: `${suggested} ${truckWord}` },
          { id: 'trucks:other', title: 'Otra cantidad' },
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
          await this.wa.sendText(phone, 'Cuantos camiones necesitas? (escribi el numero)' + FLOW_HINT);
          return;
        }
        if (payload.id?.startsWith('trucks:')) {
          truckCount = parseInt(payload.id.split(':')[1], 10);
        }
      } else if (type === 'text') {
        truckCount = parseInt(payload.body?.trim(), 10);
      }

      if (!truckCount || truckCount < 1 || truckCount > 50) {
        await this.wa.sendText(phone, 'Ingresa un numero entre 1 y 50.' + FLOW_HINT);
        return;
      }

      await this.afterTruckCount(phone, session, { ...state, truckCount });
      return;
    }

    // ---- Step: Truck Count Custom Input ----
    if (step === 'awaiting_truck_count_input') {
      if (type !== 'text') {
        await this.wa.sendText(phone, 'Escribi la cantidad de camiones (ej: 3).' + FLOW_HINT);
        return;
      }
      const truckCount = parseInt(payload.body?.trim(), 10);
      if (!truckCount || truckCount < 1 || truckCount > 50) {
        await this.wa.sendText(phone, 'Ingresa un numero valido entre 1 y 50.' + FLOW_HINT);
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
        take: 10,
      });

      if (trucks.length === 0) {
        await this.wa.sendText(phone, 'No tenes camiones registrados. Continuamos sin flota propia.');
        await this.sendPlantSelection(phone, session, state);
        return;
      }

      await this.updateState(session.id, 'awaiting_truck_select', state);
      await this.wa.sendList(phone,
        'Selecciona un camion de tu flota:' + FLOW_HINT,
        'Ver camiones',
        [{
          title: 'Tus camiones',
          rows: trucks.map((t: any) => {
            const driver = t.assignedUser?.name ? ` · ${t.assignedUser.name}` : '';
            const info = [t.brand, t.model].filter(Boolean).join(' ');
            return {
              id: `truck:${t.id}`,
              title: t.plate.slice(0, 24),
              description: `${info}${driver}`.slice(0, 72) || undefined,
            };
          }),
        }],
      );
      return;
    }

    // ---- Step: Truck Selection ----
    if (step === 'awaiting_truck_select') {
      let truckId: string | null = null;
      if ((type === 'list_reply' || type === 'button_reply') && payload.id?.startsWith('truck:')) {
        truckId = payload.id.split(':')[1];
      }

      if (!truckId) {
        await this.wa.sendText(phone, 'Selecciona un camion de la lista.' + FLOW_HINT);
        return;
      }

      // Get truck plate for summary
      const truck = await this.prisma.truck.findUnique({
        where: { id: truckId },
        select: { plate: true },
      });

      const newState = { ...state, truckId, truckPlate: truck?.plate || '' };
      await this.sendPlantSelection(phone, session, newState);
      return;
    }

    // ---- Step: Plant Selection ----
    if (step === 'awaiting_plant') {
      let plantId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('plant:')) {
        plantId = payload.id.split(':')[1];
      } else if (type === 'button_reply' && payload.id?.startsWith('plant:')) {
        plantId = payload.id.split(':')[1];
      }

      if (!plantId) {
        await this.wa.sendText(phone, 'Selecciona una planta de la lista.' + FLOW_HINT);
        return;
      }

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
        take: 10,
      });

      if (lots.length === 0) {
        // No lots → ask for custom origin name
        await this.updateState(session.id, 'awaiting_origin_name', { ...state, destPlantId: plantId });
        await this.wa.sendText(phone,
          'No tenes lotes registrados.\n' +
          'Escribi el nombre del campo/lugar de origen.' + FLOW_HINT);
        return;
      }

      await this.updateState(session.id, 'awaiting_lot', { ...state, destPlantId: plantId });
      await this.wa.sendList(phone,
        'Desde que lote se carga?' + FLOW_HINT,
        'Seleccionar lote',
        [{
          title: 'Tus lotes',
          rows: lots.map((l: any) => ({
            id: `lot:${l.id}`,
            title: l.name.slice(0, 24),
            description: l.field?.name?.slice(0, 72) || '',
          })),
        }],
      );
      return;
    }

    // ---- Step: Custom Dest Name (no plants available) ----
    if (step === 'awaiting_dest_name') {
      if (type !== 'text' || !payload.body?.trim()) {
        await this.wa.sendText(phone, 'Escribi el nombre del destino.' + FLOW_HINT);
        return;
      }
      const customDestName = payload.body.trim();
      // Fetch lots for producer
      const lots = await this.prisma.lot.findMany({
        where: { companyId: state.producerCompanyId, active: true },
        include: { field: { select: { id: true, name: true } } },
        take: 10,
      });

      if (lots.length === 0) {
        await this.updateState(session.id, 'awaiting_origin_name', { ...state, customDestName });
        await this.wa.sendText(phone, 'Escribi el nombre del campo/lugar de origen.' + FLOW_HINT);
        return;
      }

      await this.updateState(session.id, 'awaiting_lot', { ...state, customDestName });
      await this.wa.sendList(phone, 'Desde que lote se carga?' + FLOW_HINT, 'Seleccionar lote', [{
        title: 'Tus lotes',
        rows: lots.map((l: any) => ({
          id: `lot:${l.id}`,
          title: l.name.slice(0, 24),
          description: l.field?.name?.slice(0, 72) || '',
        })),
      }]);
      return;
    }

    // ---- Step: Custom Origin Name (no lots available) ----
    if (step === 'awaiting_origin_name') {
      if (type !== 'text' || !payload.body?.trim()) {
        await this.wa.sendText(phone, 'Escribi el nombre del campo/lugar de origen.' + FLOW_HINT);
        return;
      }
      const customOriginName = payload.body.trim();
      const originState = { ...state, customOriginName };
      if (state.editing) {
        delete originState.editing;
        await this.showConfirmation(phone, session, originState);
        return;
      }
      await this.sendDateSelection(phone, session, originState);
      return;
    }

    // ---- Step: Lot Selection ----
    if (step === 'awaiting_lot') {
      let lotId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('lot:')) {
        lotId = payload.id.split(':')[1];
      }

      if (!lotId) {
        await this.wa.sendText(phone, 'Selecciona un lote de la lista.' + FLOW_HINT);
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
          await this.wa.sendText(phone, 'Escribi la fecha (dd/mm/aaaa).' + FLOW_HINT);
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
        await this.wa.sendText(phone, 'Selecciona una fecha o escribi dd/mm/aaaa.' + FLOW_HINT);
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
        await this.wa.sendText(phone, 'Escribi la fecha (dd/mm/aaaa).' + FLOW_HINT);
        return;
      }
      const text = payload.body?.trim();
      const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
      if (!match) {
        await this.wa.sendText(phone, 'Formato invalido. Escribi dd/mm/aaaa (ej: 25/02/2026).' + FLOW_HINT);
        return;
      }
      const loadDate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
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
          await this.wa.sendText(phone, 'Escribi la hora (HH:mm, ej: 14:30).' + FLOW_HINT);
          return;
        }
        if (payload.id?.startsWith('time:')) {
          loadTime = payload.id.split(':').slice(1).join(':'); // "time:08:00" → "08:00"
        }
      } else if (type === 'text') {
        const text = payload.body?.trim();
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (match) {
          loadTime = `${match[1].padStart(2, '0')}:${match[2]}`;
        }
      }

      if (!loadTime) {
        await this.wa.sendText(phone, 'Selecciona un horario de la lista o escribi HH:mm.' + FLOW_HINT);
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
        await this.wa.sendText(phone, 'Escribi la hora (HH:mm, ej: 14:30).' + FLOW_HINT);
        return;
      }
      const text = payload.body?.trim();
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        await this.wa.sendText(phone, 'Formato invalido. Escribi HH:mm (ej: 14:30).' + FLOW_HINT);
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
        await this.wa.sendText(phone, 'Selecciona un campo de la lista para editar.' + FLOW_HINT);
        return;
      }

      const editState = { ...state, editing: true };

      switch (field) {
        case 'grain':
          await this.updateState(session.id, 'awaiting_grain', editState);
          await this.wa.sendList(phone, 'Selecciona el nuevo grano:', 'Seleccionar grano', [{
            title: 'Tipo de grano',
            rows: [
              { id: 'grain:Soja', title: 'Soja' },
              { id: 'grain:Maiz', title: 'Maiz' },
              { id: 'grain:Trigo', title: 'Trigo' },
              { id: 'grain:Girasol', title: 'Girasol' },
              { id: 'grain:Sorgo', title: 'Sorgo' },
              { id: 'grain:Cebada', title: 'Cebada' },
              { id: 'grain:Otros', title: 'Otros' },
            ],
          }]);
          break;
        case 'tons':
          await this.updateState(session.id, 'awaiting_tons', editState);
          await this.wa.sendText(phone, `Toneladas actuales: *${state.tons}*\n\nEscribi las nuevas toneladas.` + FLOW_HINT);
          break;
        case 'trucks':
          await this.updateState(session.id, 'awaiting_truck_count', editState);
          const suggested = Math.max(1, Math.ceil((state.tons || 30) / 30));
          const truckWord = suggested === 1 ? 'camion' : 'camiones';
          await this.wa.sendButtons(phone,
            `Camiones actuales: *${state.truckCount || 1}*\n\nCuantos camiones?` + FLOW_HINT,
            [
              { id: `trucks:${suggested}`, title: `${suggested} ${truckWord}` },
              { id: 'trucks:other', title: 'Otra cantidad' },
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
            take: 10,
          });
          if (lots.length === 0) {
            await this.updateState(session.id, 'awaiting_origin_name', editState);
            await this.wa.sendText(phone, 'Escribi el nuevo nombre del campo/lugar de origen.' + FLOW_HINT);
          } else {
            await this.updateState(session.id, 'awaiting_lot', editState);
            await this.wa.sendList(phone, 'Selecciona el nuevo lote:', 'Seleccionar lote', [{
              title: 'Tus lotes',
              rows: lots.map((l: any) => ({
                id: `lot:${l.id}`,
                title: l.name.slice(0, 24),
                description: l.field?.name?.slice(0, 72) || '',
              })),
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
          await this.wa.sendText(phone, 'Campo no reconocido.');
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
        await this.wa.sendText(phone, 'Creacion cancelada.');
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

      // Own fleet truck assignment
      if (state.truckId) {
        dto.truckId = state.truckId;
      }

      // Destination: plant ID or custom name
      if (state.destPlantId) {
        dto.destPlantId = state.destPlantId;
      } else if (state.customDestName) {
        dto.customDestName = state.customDestName;
      }

      // Origin: lot ID or custom origin name (with dummy coords for validation)
      if (state.originLotId) {
        dto.originLotId = state.originLotId;
      } else {
        dto.customOriginName = state.customOriginName || 'Origen WhatsApp';
        dto.overrideOriginLat = -34.0;
        dto.overrideOriginLng = -56.0;
      }

      const freight = await this.freights.create(dto as any, synUser);
      const successMsg = state.truckId
        ? `✅ Flete creado: *${(freight as any).code}*\n\nAsignado a tu flota propia (${state.truckPlate || 'camion seleccionado'}).`
        : `✅ Flete creado: *${(freight as any).code}*\n\nEl flete esta pendiente de asignacion de transportista.`;
      await this.wa.sendText(phone, successMsg);
      await this.endFlow(session.id);
      return;
    }

    // Fallback
    await this.wa.sendText(phone, 'No entendi tu respuesta.' + FLOW_HINT);
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
        `Camiones: *${state.truckCount}*\n\nQueres usar tu flota propia?` + FLOW_HINT,
        [
          { id: 'own_fleet:yes', title: 'Si, flota propia' },
          { id: 'own_fleet:no', title: 'No' },
        ],
      );
      return;
    }

    // No own fleet → go to plant selection
    await this.sendPlantSelection(phone, session, state);
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
        take: 10,
      });
    }

    if (plantCompanies.length === 0) {
      await this.updateState(session.id, 'awaiting_dest_name', state);
      await this.wa.sendText(phone,
        'No tenes plantas habilitadas.\n' +
        'Escribi el nombre del destino o pedi acceso a una planta desde la app.' + FLOW_HINT);
      return;
    }

    await this.updateState(session.id, 'awaiting_plant', state);
    await this.wa.sendList(phone,
      `*${state.grain}* · ${state.tons} tn · ${state.truckCount} camion${state.truckCount > 1 ? 'es' : ''}\n\nA que planta?` + FLOW_HINT,
      'Seleccionar planta',
      [{
        title: 'Plantas disponibles',
        rows: plantCompanies.map((c: any) => ({
          id: `plant:${c.id}`,
          title: c.name.slice(0, 24),
        })),
      }],
    );
  }

  /** Show date selection buttons (Hoy, Mañana, Pasado mañana, Otra fecha) */
  private async sendDateSelection(phone: string, session: any, state: any) {
    const today = new Date();
    const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
    const dayAfter = new Date(); dayAfter.setDate(today.getDate() + 2);

    const fmt = (d: Date) => `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}`;

    await this.updateState(session.id, 'awaiting_date', state);
    await this.wa.sendButtons(phone,
      'Cuando se carga?' + FLOW_HINT,
      [
        { id: 'date:today', title: `Hoy ${fmt(today)}` },
        { id: 'date:tomorrow', title: `Manana ${fmt(tomorrow)}` },
        { id: 'date:other', title: 'Otra fecha' },
      ],
    );
  }

  /** Show time selection list with common loading hours */
  private async sendTimeSelection(phone: string, session: any, state: any) {
    const dateFormatted = state.loadDate.split('-').reverse().join('/');

    await this.updateState(session.id, 'awaiting_time', state);
    await this.wa.sendList(phone,
      `Fecha: *${dateFormatted}*\n\nA que hora se carga?` + FLOW_HINT,
      'Seleccionar hora',
      [{
        title: 'Horarios',
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
          { id: 'time:other', title: 'Otro horario', description: 'Escribir hora manualmente' },
        ],
      }],
    );
  }

  /** Show confirmation summary with all freight details */
  private async showConfirmation(phone: string, session: any, finalState: any) {
    let destName = finalState.customDestName || 'Destino';
    if (finalState.destPlantId) {
      const company = await this.prisma.company.findUnique({ where: { id: finalState.destPlantId }, select: { name: true } });
      if (company) {
        destName = company.name;
      } else {
        const plant = await this.prisma.plant.findUnique({ where: { id: finalState.destPlantId }, select: { name: true } });
        destName = plant?.name || destName;
      }
    }
    let originName = finalState.customOriginName || 'Origen';
    if (finalState.originLotId) {
      const lot = await this.prisma.lot.findUnique({ where: { id: finalState.originLotId }, select: { name: true } });
      originName = lot?.name || originName;
    }

    const dateFormatted = finalState.loadDate.split('-').reverse().join('/');
    const truckCount = finalState.truckCount || 1;
    const truckLine = finalState.truckPlate
      ? `🚛 ${truckCount} camion${truckCount > 1 ? 'es' : ''} · Flota propia (${finalState.truckPlate})`
      : `🚛 ${truckCount} camion${truckCount > 1 ? 'es' : ''}`;

    await this.updateState(session.id, 'awaiting_confirm', finalState);
    await this.wa.sendButtons(phone,
      `*Resumen del flete:*\n` +
      `━━━━━━━━━━━━━━━\n` +
      `📦 ${finalState.grain} · ${finalState.tons} tn\n` +
      `${truckLine}\n` +
      `📍 ${originName} → ${destName}\n` +
      `📅 ${dateFormatted} ${finalState.loadTime}\n\n` +
      `Confirmas la creacion?`,
      [
        { id: 'flow_confirm:yes', title: 'Confirmar' },
        { id: 'flow_confirm:edit', title: 'Editar' },
        { id: 'flow_confirm:no', title: 'Cancelar' },
      ],
    );
  }

  /** Show edit menu with current values for each field */
  private async showEditMenu(phone: string, session: any, state: any) {
    // Resolve names for descriptions
    let destDesc = state.customDestName || 'Sin planta';
    if (state.destPlantId) {
      const company = await this.prisma.company.findUnique({ where: { id: state.destPlantId }, select: { name: true } });
      destDesc = company?.name || destDesc;
    }
    let originDesc = state.customOriginName || 'Sin origen';
    if (state.originLotId) {
      const lot = await this.prisma.lot.findUnique({ where: { id: state.originLotId }, select: { name: true } });
      originDesc = lot?.name || originDesc;
    }
    const dateDesc = state.loadDate?.split('-').reverse().join('/') || '';

    await this.updateState(session.id, 'awaiting_edit_field', state);
    await this.wa.sendList(phone,
      'Que campo queres modificar?' + FLOW_HINT,
      'Ver campos',
      [{
        title: 'Campos editables',
        rows: [
          { id: 'edit:grain',  title: 'Grano',     description: state.grain || '' },
          { id: 'edit:tons',   title: 'Toneladas', description: `${state.tons} tn` },
          { id: 'edit:trucks', title: 'Camiones',  description: `${state.truckCount || 1}` },
          { id: 'edit:plant',  title: 'Planta',    description: destDesc.slice(0, 72) },
          { id: 'edit:origin', title: 'Origen',    description: originDesc.slice(0, 72) },
          { id: 'edit:date',   title: 'Fecha',     description: dateDesc },
          { id: 'edit:time',   title: 'Hora',      description: state.loadTime || '' },
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
    await this.prisma.whatsAppSession.delete({ where: { id: sessionId } }).catch(() => {});
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

    // Fallback to activeCompanyId
    return user.activeCompanyId || user.companyId || null;
  }

  private buildSyntheticUser(dbUser: any): any {
    const companyByType = (dbUser.companyByType as any) || {};
    const userTypes = Array.isArray(dbUser.userTypes) ? dbUser.userTypes : [];

    let companyType = 'unknown';
    let companyId = dbUser.activeCompanyId || dbUser.companyId || '';

    if (userTypes.length > 0) {
      companyType = userTypes[0];
    } else if (dbUser.company?.type) {
      companyType = dbUser.company.type;
    } else if (dbUser.memberships?.length > 0) {
      const firstMembership = dbUser.memberships[0];
      const types = Array.isArray(firstMembership.company?.types) && firstMembership.company.types.length > 0
        ? firstMembership.company.types
        : [firstMembership.company?.type];
      companyType = types[0] || 'unknown';
      companyId = companyId || firstMembership.companyId;
    }

    return {
      sub: dbUser.id,
      role: dbUser.role || 'operator',
      companyId,
      companyType,
      userType: companyType,
      activeCompanyId: dbUser.activeCompanyId,
    };
  }
}
