// =====================================================================
// TOLVINK — WhatsApp Conversational Flow Service
// Manages multi-step WhatsApp interactions (reject, confirm loaded, etc.)
// =====================================================================

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from './whatsapp.service';
import { FreightsService } from '../freights/freights.service';

const FLOW_TIMEOUT_MINUTES = 10;

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
  // Steps: grain → tons → plant → field → date → time → confirm

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
      'Vamos a crear un nuevo flete.\n\nQue grano vas a enviar?',
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
        await this.wa.sendText(phone, 'Selecciona un grano de la lista o escribi el nombre (Soja, Maiz, Trigo, etc.):');
        return;
      }

      await this.updateState(session.id, 'awaiting_tons', { ...state, grain });
      await this.wa.sendText(phone, `Grano: *${grain}*\n\nCuantas toneladas? (ej: 30)`);
      return;
    }

    // ---- Step: Tons ----
    if (step === 'awaiting_tons') {
      if (type !== 'text') {
        await this.wa.sendText(phone, 'Escribi la cantidad de toneladas (ej: 30):');
        return;
      }

      const tons = parseFloat(payload.body?.trim().replace(',', '.'));
      if (isNaN(tons) || tons <= 0) {
        await this.wa.sendText(phone, 'Ingresa un numero valido (ej: 30):');
        return;
      }

      // Fetch plants the producer has access to via PlantProducerAccess
      const accessRecords = await this.prisma.plantProducerAccess.findMany({
        where: { producerCompanyId: state.producerCompanyId, active: true },
        select: { plantCompanyId: true, allowedPlantIds: true },
      });

      let plants: any[] = [];
      if (accessRecords.length > 0) {
        // Collect specific plant IDs from access records
        const specificPlantIds: string[] = [];
        const plantCompanyIds: string[] = [];
        for (const ar of accessRecords) {
          const allowed = Array.isArray(ar.allowedPlantIds) ? ar.allowedPlantIds as string[] : [];
          if (allowed.length > 0) {
            specificPlantIds.push(...allowed);
          } else {
            plantCompanyIds.push(ar.plantCompanyId);
          }
        }

        plants = await this.prisma.plant.findMany({
          where: {
            active: true,
            OR: [
              ...(specificPlantIds.length > 0 ? [{ id: { in: specificPlantIds } }] : []),
              ...(plantCompanyIds.length > 0 ? [{ companyId: { in: plantCompanyIds } }] : []),
            ],
          },
          include: { company: { select: { id: true, name: true } } },
          take: 10,
        });
      }

      if (plants.length === 0) {
        await this.updateState(session.id, 'awaiting_dest_name', { ...state, tons });
        await this.wa.sendText(phone,
          'No tenes plantas habilitadas.\n' +
          'Escribi el nombre del destino o pedi acceso a una planta desde la app.');
        return;
      }

      await this.updateState(session.id, 'awaiting_plant', { ...state, tons });
      await this.wa.sendList(phone,
        `Grano: *${state.grain}* | Toneladas: *${tons}*\n\nA que planta?`,
        'Seleccionar planta',
        [{
          title: 'Plantas disponibles',
          rows: plants.map((p: any) => ({
            id: `plant:${p.id}`,
            title: p.name.slice(0, 24),
            description: p.company?.name?.slice(0, 72) || '',
          })),
        }],
      );
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
        await this.wa.sendText(phone, 'Selecciona una planta de la lista.');
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
          'Escribi el nombre del campo/lugar de origen:');
        return;
      }

      await this.updateState(session.id, 'awaiting_lot', { ...state, destPlantId: plantId });
      await this.wa.sendList(phone,
        'Desde que lote se carga?',
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
        await this.wa.sendText(phone, 'Escribi el nombre del destino:');
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
        await this.wa.sendText(phone, 'Escribi el nombre del campo/lugar de origen:');
        return;
      }

      await this.updateState(session.id, 'awaiting_lot', { ...state, customDestName });
      await this.wa.sendList(phone, 'Desde que lote se carga?', 'Seleccionar lote', [{
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
        await this.wa.sendText(phone, 'Escribi el nombre del campo/lugar de origen:');
        return;
      }
      const customOriginName = payload.body.trim();
      await this.updateState(session.id, 'awaiting_date', { ...state, customOriginName });
      await this.wa.sendText(phone, 'Fecha de carga? (dd/mm/aaaa o "hoy" o "manana")');
      return;
    }

    // ---- Step: Lot Selection ----
    if (step === 'awaiting_lot') {
      let lotId: string | null = null;
      if (type === 'list_reply' && payload.id?.startsWith('lot:')) {
        lotId = payload.id.split(':')[1];
      }

      if (!lotId) {
        await this.wa.sendText(phone, 'Selecciona un lote de la lista.');
        return;
      }

      await this.updateState(session.id, 'awaiting_date', { ...state, originLotId: lotId });
      await this.wa.sendText(phone, 'Fecha de carga? (dd/mm/aaaa o "hoy" o "manana")');
      return;
    }

    // ---- Step: Date ----
    if (step === 'awaiting_date') {
      if (type !== 'text') {
        await this.wa.sendText(phone, 'Escribi la fecha (dd/mm/aaaa, "hoy" o "manana"):');
        return;
      }

      const text = payload.body?.trim().toLowerCase();
      let loadDate: string;

      if (text === 'hoy') {
        loadDate = new Date().toISOString().split('T')[0];
      } else if (text === 'manana' || text === 'mañana') {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        loadDate = d.toISOString().split('T')[0];
      } else {
        // Parse dd/mm/yyyy
        const match = text.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (!match) {
          await this.wa.sendText(phone, 'Formato invalido. Escribi dd/mm/aaaa, "hoy" o "manana":');
          return;
        }
        loadDate = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
      }

      await this.updateState(session.id, 'awaiting_time', { ...state, loadDate });
      await this.wa.sendText(phone, 'Hora de carga? (HH:mm, ej: 08:00)');
      return;
    }

    // ---- Step: Time ----
    if (step === 'awaiting_time') {
      if (type !== 'text') {
        await this.wa.sendText(phone, 'Escribi la hora (HH:mm, ej: 08:00):');
        return;
      }

      const text = payload.body?.trim();
      const match = text.match(/^(\d{1,2}):(\d{2})$/);
      if (!match) {
        await this.wa.sendText(phone, 'Formato invalido. Escribi HH:mm (ej: 08:00):');
        return;
      }

      const loadTime = `${match[1].padStart(2, '0')}:${match[2]}`;
      const finalState = { ...state, loadTime };

      // Show summary for confirmation
      let destName = finalState.customDestName || 'Destino';
      if (finalState.destPlantId) {
        const plant = await this.prisma.plant.findUnique({ where: { id: finalState.destPlantId }, select: { name: true } });
        destName = plant?.name || destName;
      }
      let originName = finalState.customOriginName || 'Origen';
      if (finalState.originLotId) {
        const lot = await this.prisma.lot.findUnique({ where: { id: finalState.originLotId }, select: { name: true } });
        originName = lot?.name || originName;
      }

      const dateFormatted = finalState.loadDate.split('-').reverse().join('/');

      await this.updateState(session.id, 'awaiting_confirm', finalState);
      await this.wa.sendButtons(phone,
        `*Resumen del flete:*\n` +
        `━━━━━━━━━━━━━━━\n` +
        `📦 ${finalState.grain} · ${finalState.tons} tn\n` +
        `📍 ${originName} → ${destName}\n` +
        `📅 ${dateFormatted} ${loadTime}\n\n` +
        `Confirmas la creacion?`,
        [
          { id: 'flow_confirm:yes', title: 'Confirmar' },
          { id: 'flow_confirm:no', title: 'Cancelar' },
        ],
      );
      return;
    }

    // ---- Step: Confirmation ----
    if (step === 'awaiting_confirm') {
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
      };

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
      await this.wa.sendText(phone,
        `✅ Flete creado: *${(freight as any).code}*\n\n` +
        `El flete esta pendiente de asignacion de transportista.`,
      );
      await this.endFlow(session.id);
      return;
    }

    // Fallback
    await this.wa.sendText(phone, 'No entendi tu respuesta. Escribi "cancelar" para volver al menu.');
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
