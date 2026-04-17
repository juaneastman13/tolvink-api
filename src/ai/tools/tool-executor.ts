// =====================================================================
// TOLVINK — Tool Executor
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { buildSyntheticUser } from '../../common/build-synthetic-user';
import { fuzzySearch, ENTITY_ALIASES } from '../../common/fuzzy-match';
import { APP_URL, FREIGHT_STATUS_SHORT } from '../core/constants';
import { AiProfile, resolveAiProfile } from '../core/ai-profile';

export const READ_ONLY_TOOLS = new Set([
  'list_freights', 'get_freight_detail', 'get_dashboard',
  'search_plants', 'search_fields', 'search_lots',
]);

export const QUERY_ONLY_TOOLS = new Set(READ_ONLY_TOOLS);

export const TOOLS_BY_PROFILE: Record<AiProfile, Set<string>> = {
  producer_manager: new Set(['list_freights', 'get_freight_detail', 'search_plants', 'search_fields', 'search_lots', 'create_freight_request', 'cancel_freight', 'confirm_action', 'attach_document']),
  producer_operator: new Set(['list_freights', 'get_freight_detail', 'search_plants', 'search_fields', 'search_lots', 'create_freight_request', 'confirm_action', 'attach_document']),
  producer_driver: new Set(['list_freights', 'get_freight_detail', 'start_freight_trip', 'confirm_freight_loaded', 'confirm_freight_arrival', 'finish_freight', 'attach_document', 'confirm_action']),
  transporter_manager: new Set(['list_freights', 'get_freight_detail', 'accept_freight_assignment', 'reject_freight_assignment', 'assign_driver_and_truck', 'confirm_action', 'attach_document']),
  transporter_driver: new Set(['list_freights', 'get_freight_detail', 'start_freight_trip', 'confirm_freight_loaded', 'confirm_freight_arrival', 'finish_freight', 'attach_document', 'confirm_action']),
  plant_manager: new Set(['list_freights', 'get_freight_detail', 'approve_freight_request', 'assign_transport_company', 'cancel_freight', 'confirm_action', 'attach_document']),
  plant_operator: new Set(['list_freights', 'get_freight_detail', 'approve_freight_request', 'assign_transport_company', 'confirm_action', 'attach_document']),
  plant_driver: new Set(['list_freights', 'get_freight_detail', 'start_freight_trip', 'confirm_freight_loaded', 'confirm_freight_arrival', 'finish_freight', 'attach_document', 'confirm_action']),
  autonomous_driver: new Set(['list_freights', 'get_freight_detail', 'get_dashboard', 'search_plants', 'search_fields', 'search_lots', 'prepare_autonomous_freight', 'confirm_action', 'finish_autonomous_freight', 'cancel_freight', 'attach_document']),
};

type PendingActionRecord = {
  actionId: string;
  tool: string;
  params: Record<string, any>;
  summary: string;
  buttons?: Array<{ id: string; title: string }>;
  createdAt: number;
};

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);
  private static readonly PENDING_ACTION_TTL_MS = 5 * 60 * 1000;
  private pendingActions = new Map<string, PendingActionRecord>();

  constructor(
    private prisma: PrismaService,
    private freights: FreightsService,
  ) {}

  cleanupPendingActions(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingActions) {
      if (now - v.createdAt > ToolExecutorService.PENDING_ACTION_TTL_MS) this.pendingActions.delete(k);
    }
  }

  scopeUserToSessionCompany(user: any, session?: any): any {
    return this.applySessionCompanyScope(user, session);
  }

  buildSyntheticUser(user: any, session?: any): any {
    return buildSyntheticUser(this.applySessionCompanyScope(user, session));
  }

  getAiProfile(user: any, session?: any): AiProfile {
    return resolveAiProfile(this.applySessionCompanyScope(user, session));
  }

  isAutonomousDriver(user: any, session?: any): boolean {
    return this.getAiProfile(user, session) === 'autonomous_driver';
  }

  filterTools(allTools: any[], user: any, session?: any): any[] {
    const allowed = TOOLS_BY_PROFILE[this.getAiProfile(user, session)] || QUERY_ONLY_TOOLS;
    return allTools.filter((t) => allowed.has(t.name));
  }

  async executeTool(name: string, input: any, user: any, session: any): Promise<string> {
    const scopedUser = this.applySessionCompanyScope(user, session);
    const synUser = this.buildSyntheticUser(scopedUser, session);
    const profile = this.getAiProfile(scopedUser, session);
    const allowed = TOOLS_BY_PROFILE[profile] || QUERY_ONLY_TOOLS;

    if (!allowed.has(name)) {
      return JSON.stringify({ error: 'Esa accion no esta habilitada para tu rol en la empresa activa.' });
    }

    try {
      switch (name) {
        case 'list_freights': return await this.handleListFreights(input, synUser);
        case 'get_freight_detail': return await this.handleGetFreightDetail(input, scopedUser);
        case 'get_dashboard': return await this.handleGetDashboard(synUser);
        case 'search_plants': return await this.handleSearchPlants(input, scopedUser);
        case 'search_fields': return await this.handleSearchFields(input, scopedUser);
        case 'search_lots': return await this.handleSearchLots(input, scopedUser);
        case 'create_freight_request': return await this.handleCreateFreightRequest(input, scopedUser, session);
        case 'approve_freight_request': return await this.handleApproveFreightRequest(input, scopedUser, session);
        case 'assign_transport_company': return await this.handleAssignTransportCompany(input, scopedUser, session);
        case 'accept_freight_assignment': return await this.handleAcceptFreightAssignment(input, scopedUser, session);
        case 'reject_freight_assignment': return await this.handleRejectFreightAssignment(input, scopedUser, session);
        case 'assign_driver_and_truck': return await this.handleAssignDriverAndTruck(input, scopedUser, session);
        case 'start_freight_trip': return await this.handleStartFreightTrip(input, scopedUser, session);
        case 'confirm_freight_loaded': return await this.handleConfirmFreightLoaded(input, scopedUser, session);
        case 'confirm_freight_arrival': return await this.handleConfirmFreightArrival(input, scopedUser, session);
        case 'finish_freight': return await this.handleFinishFreight(input, scopedUser, session);
        case 'prepare_autonomous_freight': return await this.handlePrepareAutonomousFreight(input, scopedUser, session);
        case 'confirm_action': return await this.handleConfirmAction(scopedUser, synUser, session);
        case 'finish_autonomous_freight': return await this.handleFinishAutonomousFreight(input, scopedUser, session);
        case 'register_plant_arrival': return await this.handleRegisterPlantArrival(input, scopedUser, session);
        case 'cancel_freight': return await this.handleCancelFreight(input, scopedUser, session);
        case 'attach_document': return await this.handleAttachDocument(input, scopedUser, session);
        default:
          return JSON.stringify({ error: 'Esa funcion no esta disponible.' });
      }
    } catch (e: any) {
      this.logger.error(`Tool ${name} error: ${e.message}`, e.stack?.slice(0, 300));
      const msg = e.message || '';
      if (/no encontr/i.test(msg)) return JSON.stringify({ error: 'No se encontro el flete o la entidad indicada.' });
      if (/sin permisos|forbidden|no sos|no tene/i.test(msg)) return JSON.stringify({ error: 'No tenes permisos para hacer eso en la empresa activa.' });
      if (/obligatori|falt/i.test(msg)) return JSON.stringify({ error: msg });
      if (/ambigu|mas de uno|varios/i.test(msg)) return JSON.stringify({ error: msg });
      if (/estado actual|ya /i.test(msg)) return JSON.stringify({ error: msg });
      if (/autonom/i.test(msg)) return JSON.stringify({ error: 'Esa accion solo aplica al flujo de chofer autonomo.' });
      return JSON.stringify({ error: 'Hubo un problema. Intenta de nuevo en unos segundos.' });
    }
  }

  // ======================== QUERIES ========================

  private async handleListFreights(input: any, synUser: any): Promise<string> {
    const result = await this.freights.findAll(synUser, {
      status: input.status,
      grain: input.grain,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      limit: 10,
    });
    if (!result.data?.length) return JSON.stringify({ total: 0, message: 'No tenes fletes con esos filtros.' });
    return JSON.stringify({
      total: result.total,
      freights: result.data.map((f: any) => ({
        code: f.code,
        status: FREIGHT_STATUS_SHORT[f.status] || f.status,
        grain: f.items?.[0]?.grain || '',
        tons: f.items?.[0]?.tons || null,
        origin: f.originName || f.originFreeText || '',
        dest: f.destName || f.destinationFreeText || '',
      })),
    });
  }

  private async handleGetFreightDetail(input: any, user: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete con codigo "${input.code}".` });
    const item = freight.items?.[0];
    const assignment = freight.assignments?.[0];
    return JSON.stringify({
      code: freight.code,
      status: FREIGHT_STATUS_SHORT[freight.status] || freight.status,
      grain: item?.grain || '',
      tons: item?.tons || null,
      origin: freight.originName || freight.originFreeText || '',
      dest: freight.destName || freight.destinationFreeText || '',
      loadDate: freight.loadDate,
      truck: assignment?.plate || null,
      driver: assignment?.driverName || null,
      link: `${APP_URL}/freight/${freight.id}`,
    });
  }

  private async handleGetDashboard(synUser: any): Promise<string> {
    const companyIds = this.resolveAllCompanyIds(synUser);
    const byStatus = await this.prisma.freight.groupBy({
      by: ['status'],
      where: { participantCompanyIds: { hasSome: companyIds } },
      _count: true,
    });
    const summary: Record<string, number> = {};
    let total = 0;
    for (const s of byStatus) {
      const label = FREIGHT_STATUS_SHORT[s.status] || s.status;
      summary[label] = s._count;
      if (!['finished', 'canceled'].includes(s.status)) total += s._count;
    }
    return JSON.stringify({ activeFreights: total, byStatus: summary });
  }

  // ======================== SEARCH ========================

  private async handleSearchPlants(input: any, user: any): Promise<string> {
    const companyIds = this.resolveAllCompanyIds(user);
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: { in: companyIds }, active: true },
      select: { plantCompany: { select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } } } },
    });
    const companies = accesses.map((a) => a.plantCompany).filter(Boolean);
    const plantCompanies = await this.prisma.company.findMany({
      where: { types: { array_contains: ['plant'] }, active: true },
      select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } },
      take: 50,
    });
    const allPlants = new Map<string, any>();
    for (const c of [...companies, ...plantCompanies]) {
      if (c && !allPlants.has(c.id)) allPlants.set(c.id, c);
    }
    const results = fuzzySearch(input.query, Array.from(allPlants.values()), (c: any) => c.name, {
      threshold: 0.5, maxResults: 5, aliases: ENTITY_ALIASES,
    });
    if (results.length > 0) {
      return JSON.stringify({
        total: results.length,
        source: 'company',
        plants: results.map((r) => ({
          companyId: r.item.id,
          name: r.item.name,
          branches: (r.item.plants || []).map((p: any) => ({ id: p.id, name: p.name })),
          score: r.score,
        })),
      });
    }

    const masterPlants = await this.prisma.tolvinkPlant.findMany({
      where: { active: true },
      select: { id: true, name: true, altName: true, department: true, lat: true, lng: true },
      take: 100,
    });
    const masterResults = fuzzySearch(input.query, masterPlants, (p: any) => [p.name, p.altName, p.department].filter(Boolean).join(' '), {
      threshold: 0.5, maxResults: 5, aliases: ENTITY_ALIASES,
    });
    if (masterResults.length === 0) {
      return JSON.stringify({ total: 0, message: `No se encontro planta con nombre "${input.query}".` });
    }
    return JSON.stringify({
      total: masterResults.length,
      source: 'tolvink_directory',
      plants: masterResults.map((r) => ({
        tolvinkPlantId: r.item.id,
        companyId: null,
        name: r.item.name,
        altName: r.item.altName || null,
        department: r.item.department || null,
        lat: r.item.lat != null ? Number(r.item.lat) : null,
        lng: r.item.lng != null ? Number(r.item.lng) : null,
        branches: [],
        score: r.score,
      })),
    });
  }

  private async handleSearchFields(input: any, user: any): Promise<string> {
    const companyIds = this.resolveAllCompanyIds(user);
    const allFields = await this.prisma.field.findMany({
      where: { companyId: { in: companyIds }, active: true },
      select: { id: true, name: true, lots: { where: { active: true }, select: { id: true, name: true } } },
      take: 50,
    });
    const results = fuzzySearch(input.query, allFields, (f: any) => f.name, { threshold: 0.5, maxResults: 5 });
    if (results.length === 0) return JSON.stringify({ total: 0, message: `No se encontro campo con nombre "${input.query}".` });
    return JSON.stringify({
      total: results.length,
      fields: results.map((r) => ({
        id: r.item.id,
        name: r.item.name,
        lots: (r.item.lots || []).map((l: any) => ({ id: l.id, name: l.name })),
        score: r.score,
      })),
    });
  }

  private async handleSearchLots(input: any, user: any): Promise<string> {
    const companyIds = this.resolveAllCompanyIds(user);
    const where: any = { companyId: { in: companyIds }, active: true };
    if (input.fieldId) where.fieldId = input.fieldId;
    const allLots = await this.prisma.lot.findMany({
      where,
      select: { id: true, name: true, fieldId: true, field: { select: { name: true } } },
      take: 50,
    });
    const lots = allLots.map((l: any) => ({ ...l, fieldName: l.field?.name || null }));
    const results = fuzzySearch(input.query, lots, (l: any) => l.name, { threshold: 0.5, maxResults: 5 });
    if (results.length === 0) return JSON.stringify({ total: 0, message: `No se encontro lote con nombre "${input.query}".` });
    return JSON.stringify({
      total: results.length,
      lots: results.map((r) => ({
        id: r.item.id,
        name: r.item.name,
        fieldId: r.item.fieldId,
        fieldName: r.item.fieldName || null,
        score: r.score,
      })),
    });
  }

  // ======================== FLOW CORE ========================

  private async handleCreateFreightRequest(input: any, user: any, session: any): Promise<string> {
    if (!input.grain) return JSON.stringify({ error: 'Falta el grano.' });
    if (!input.weightKg || Number(input.weightKg) <= 0) return JSON.stringify({ error: 'Falta el peso del flete.' });
    if (!input.origin && !input.fieldId && !input.lotId) return JSON.stringify({ error: 'Necesito el origen o un campo/lote.' });
    if (!input.destination && !input.destPlantId && !input.tolvinkPlantId) return JSON.stringify({ error: 'Necesito el destino o una planta.' });

    const { loadDate, loadTime } = this.getDefaultSchedule(input.loadDate, input.loadTime);
    const grain = this.normalizeGrain(input.grain);
    const tons = this.kgToTons(input.weightKg);
    const summary = [
      'Solicitud de flete',
      '',
      `📍 Origen: ${input.origin || 'campo/lote verificado'}`,
      `🏭 Destino: ${input.destination || 'planta verificada'}`,
      `🌾 Grano: ${grain}`,
      `⚖️ Peso: ${this.formatWeightKg(input.weightKg)}`,
      `📅 Carga: ${loadDate} ${loadTime}`,
    ].join('\n');

    return this.stageAction(session.id, 'create_freight_request', {
      origin: input.origin,
      fieldId: input.fieldId,
      lotId: input.lotId,
      destination: input.destination,
      destPlantId: input.destPlantId,
      tolvinkPlantId: input.tolvinkPlantId,
      grain,
      weightKg: Number(input.weightKg),
      loadDate,
      loadTime,
      notes: input.notes,
      tons,
    }, summary);
  }

  private async handleApproveFreightRequest(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    return this.stageAction(session.id, 'approve_freight_request', {
      freightId: freight.id,
      code: freight.code,
    }, `Aprobar flete ${freight.code}`);
  }

  private async handleAssignTransportCompany(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    const resolved = await this.resolveTransportCompany(input.transportCompanyId || input.transportCompanyName);
    if (!resolved) return JSON.stringify({ error: 'No encontre esa empresa transportista. Decime el nombre exacto o usa la web.' });
    if (resolved.ambiguous) return JSON.stringify({ error: `Encontre varias empresas parecidas: ${resolved.options.join(', ')}.` });

    return this.stageAction(session.id, 'assign_transport_company', {
      freightId: freight.id,
      code: freight.code,
      transportCompanyId: resolved.company.id,
      transportCompanyName: resolved.company.name,
    }, `Asignar transportista\n📋 Flete: ${freight.code}\n🚚 Empresa: ${resolved.company.name}`);
  }

  private async handleAcceptFreightAssignment(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    const assignment = await this.resolveOwnedAssignment(freight.id, user, input.tripNumber);
    if (!assignment) return JSON.stringify({ error: 'No encontre una asignacion pendiente de tu empresa para ese flete.' });
    if (assignment.truckId && assignment.driverId && assignment.status === 'accepted') {
      return JSON.stringify({ status: 'already_accepted', message: `El flete ${freight.code} ya tiene camion y chofer asignados.` });
    }

    const defaults = await this.getDefaultTruckAndDriver(assignment.transportCompanyId, user);
    if (!defaults.truckId || !defaults.driverId) {
      return JSON.stringify({ error: 'Para aceptar este flete necesito camion y chofer. Decime el nombre del chofer y la matricula.' });
    }

    return this.stageAction(session.id, 'assign_driver_and_truck', {
      freightId: freight.id,
      code: freight.code,
      assignmentId: assignment.id,
      tripNumber: assignment.tripNumber,
      driverId: defaults.driverId,
      driverName: defaults.driverName,
      truckId: defaults.truckId,
      plate: defaults.plate,
    }, `Aceptar y asignar\n📋 Flete: ${freight.code}\n🚛 Camion: ${defaults.plate}\n👤 Chofer: ${defaults.driverName}`);
  }

  private async handleRejectFreightAssignment(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    if (!input.reason?.trim()) return JSON.stringify({ error: 'Necesito el motivo del rechazo.' });
    const assignment = await this.resolveOwnedAssignment(freight.id, user, input.tripNumber);

    return this.stageAction(session.id, 'reject_freight_assignment', {
      freightId: freight.id,
      code: freight.code,
      assignmentId: assignment?.id || null,
      reason: input.reason.trim(),
    }, `Rechazar asignacion\n📋 Flete: ${freight.code}\n📝 Motivo: ${input.reason.trim()}`);
  }

  private async handleAssignDriverAndTruck(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    const assignment = await this.resolveOwnedAssignment(freight.id, user, input.tripNumber);
    if (!assignment) return JSON.stringify({ error: 'No encontre una asignacion activa para ese flete en tu empresa.' });

    const driver = await this.resolveDriver(assignment.transportCompanyId, user, input.driverId, input.driverName);
    if (!driver) return JSON.stringify({ error: 'No encontre ese chofer. Decime el nombre exacto o usa la web.' });
    if (driver.ambiguous) return JSON.stringify({ error: `Encontre varios choferes parecidos: ${driver.options.join(', ')}.` });

    const truck = await this.resolveTruck(assignment.transportCompanyId, input.truckId, input.plate);
    if (!truck) return JSON.stringify({ error: 'No encontre ese camion. Decime la matricula exacta o usa la web.' });
    if (truck.ambiguous) return JSON.stringify({ error: `Encontre varios camiones parecidos: ${truck.options.join(', ')}.` });

    return this.stageAction(session.id, 'assign_driver_and_truck', {
      freightId: freight.id,
      code: freight.code,
      assignmentId: assignment.id,
      tripNumber: assignment.tripNumber,
      driverId: driver.item.id,
      driverName: driver.item.name,
      truckId: truck.item.id,
      plate: truck.item.plate,
    }, `Asignar chofer y camion\n📋 Flete: ${freight.code}\n🚛 Camion: ${truck.item.plate}\n👤 Chofer: ${driver.item.name}`);
  }

  private async handleStartFreightTrip(input: any, user: any, session: any): Promise<string> {
    const target = await this.resolveDriverTripTarget(user, input.code);
    if (!target) return JSON.stringify({ error: 'No encontre un viaje elegible para iniciar. Decime el codigo del flete.' });
    return this.stageAction(session.id, 'start_freight_trip', {
      freightId: target.freight.id,
      assignmentId: target.assignment?.id || null,
      code: target.freight.code,
    }, `Iniciar viaje\n📋 Flete: ${target.freight.code}`);
  }

  private async handleConfirmFreightLoaded(input: any, user: any, session: any): Promise<string> {
    const target = await this.resolveDriverTripTarget(user, input.code);
    if (!target) return JSON.stringify({ error: 'No encontre un viaje elegible para confirmar carga. Decime el codigo del flete.' });
    return this.stageAction(session.id, 'confirm_freight_loaded', {
      freightId: target.freight.id,
      assignmentId: target.assignment?.id || null,
      code: target.freight.code,
      loadedTons: input.weightKg ? this.kgToTons(input.weightKg) : undefined,
    }, `Confirmar carga\n📋 Flete: ${target.freight.code}${input.weightKg ? `\n⚖️ Peso: ${this.formatWeightKg(input.weightKg)}` : ''}`);
  }

  private async handleConfirmFreightArrival(input: any, user: any, session: any): Promise<string> {
    const target = await this.resolveDriverTripTarget(user, input.code);
    if (!target) return JSON.stringify({ error: 'No encontre un viaje elegible para registrar llegada.' });
    if (!target.freight.isAutonomous) {
      return JSON.stringify({ error: 'En este flujo no hace falta registrar llegada por separado. Cuando descargues, decime "finalizar flete".' });
    }
    return this.stageAction(session.id, 'confirm_freight_arrival', {
      freightId: target.freight.id,
      code: target.freight.code,
    }, `Registrar llegada a planta\n📋 Flete: ${target.freight.code}`);
  }

  private async handleFinishFreight(input: any, user: any, session: any): Promise<string> {
    const target = await this.resolveDriverTripTarget(user, input.code);
    if (!target) return JSON.stringify({ error: 'No encontre un viaje elegible para finalizar. Decime el codigo del flete.' });
    return this.stageAction(session.id, 'finish_freight', {
      freightId: target.freight.id,
      assignmentId: target.assignment?.id || null,
      code: target.freight.code,
      destinationWeightKg: input.destinationWeightKg ? Number(input.destinationWeightKg) : undefined,
    }, `Finalizar flete\n📋 Flete: ${target.freight.code}${input.destinationWeightKg ? `\n⚖️ Peso destino: ${this.formatWeightKg(input.destinationWeightKg)}` : ''}`);
  }

  // ======================== AUTONOMOUS / DOCUMENTS ========================

  private async handlePrepareAutonomousFreight(input: any, user: any, session: any): Promise<string> {
    const activeFreight = await this.prisma.freight.findFirst({
      where: {
        requestedById: user.sub || user.id,
        isAutonomous: true,
        status: { notIn: ['finished', 'canceled'] },
        transporterFinishedConfirmedAt: null,
      },
      select: { id: true, code: true, destName: true, originName: true, originFreeText: true, items: { select: { grain: true, tons: true }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    if (activeFreight) {
      const grain = activeFreight.items?.[0]?.grain || '';
      const tons = activeFreight.items?.[0]?.tons;
      const origin = activeFreight.originName || activeFreight.originFreeText || '';
      const dest = activeFreight.destName || '';
      return this.stageAction(session.id, 'finish_and_create', {
        freightId: activeFreight.id,
        code: activeFreight.code,
        currentGrain: grain,
        currentTons: tons,
        currentOrigin: origin,
        currentDest: dest,
        newFreight: {
          origin: input.origin,
          destination: input.destination,
          grain: input.grain,
          weightKg: input.weightKg,
          notes: input.notes,
          fieldId: input.fieldId,
          originLotId: input.originLotId,
          destPlantId: input.destPlantId,
          tolvinkPlantId: input.tolvinkPlantId,
          branchId: input.branchId,
        },
      }, `Tenes un flete activo:\n📋 ${activeFreight.code}\n🌾 ${grain}${tons ? ` · ${tons} tn` : ''}\n📍 ${origin} → ${dest}\n\nFinalizalo para crear uno nuevo`);
    }
    if (!input.origin) return JSON.stringify({ error: 'Falta el origen.' });
    if (!input.destination) return JSON.stringify({ error: 'Falta el destino.' });
    if (!input.grain) return JSON.stringify({ error: 'Falta el grano.' });
    if (!input.weightKg || Number(input.weightKg) <= 0) return JSON.stringify({ error: 'Falta el peso.' });
    const { truckId, truckPlate } = await this.autoDetectTruck(user);
    return this.stageAction(session.id, 'prepare_autonomous_freight', {
      origin: input.origin,
      destination: input.destination,
      grain: input.grain,
      weightKg: Number(input.weightKg),
      truckPlate,
      notes: input.notes,
      truckId,
      fieldId: input.fieldId,
      originLotId: input.originLotId,
      destPlantId: input.destPlantId,
      tolvinkPlantId: input.tolvinkPlantId,
      branchId: input.branchId,
    }, `Solicitud de flete\n\n🚛 Camion: ${truckPlate || 'auto'}\n📍 Origen: ${input.origin}\n🏭 Destino: ${input.destination}\n🌾 Grano: ${input.grain}\n⚖️ Peso: ${this.formatWeightKg(input.weightKg)}`);
  }

  private async handleFinishAutonomousFreight(input: any, user: any, session: any): Promise<string> {
    let freight: any;
    if (input.code) freight = await this.resolveFreightByCode(input.code, user);
    else {
      freight = await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
        select: { id: true, code: true },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!freight) return JSON.stringify({ error: 'No tenes fletes autonomos activos para finalizar.' });
    return this.stageAction(session.id, 'finish_autonomous_freight', {
      freightId: freight.id,
      code: freight.code,
      destinationWeightKg: input.destinationWeightKg ? Number(input.destinationWeightKg) : undefined,
    }, `Finalizar flete ${freight.code}`);
  }

  private async handleRegisterPlantArrival(input: any, user: any, session: any): Promise<string> {
    let freight: any;
    if (input.code) freight = await this.resolveFreightByCode(input.code, user);
    else {
      freight = await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
        select: { id: true, code: true, destName: true },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!freight) return JSON.stringify({ error: 'No tenes un flete autonomo activo para registrar llegada.' });
    return this.stageAction(session.id, 'register_plant_arrival', {
      freightId: freight.id,
      code: freight.code,
    }, `Registrar llegada${freight.destName ? ` en ${freight.destName}` : ''}\n📋 Flete: ${freight.code}`);
  }

  private async handleCancelFreight(input: any, user: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete "${input.code}".` });
    if (!input.reason?.trim()) return JSON.stringify({ error: 'Para cancelar necesito el motivo.' });
    return this.stageAction(session.id, 'cancel_freight', {
      freightId: freight.id,
      code: freight.code,
      reason: input.reason.trim(),
    }, `Cancelar flete ${freight.code}\n📝 Motivo: ${input.reason.trim()}`);
  }

  private async handleAttachDocument(input: any, user: any, session: any): Promise<string> {
    const state = (session?.flowState as any) || {};
    const pendingDoc = state.pendingDocument;
    if (!pendingDoc?.url) return JSON.stringify({ error: 'No hay foto o archivo pendiente.' });

    let freight: any;
    if (input.code) freight = await this.resolveFreightByCode(input.code, user);
    else {
      const target = await this.resolveDriverTripTarget(user);
      freight = target?.freight || await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: { notIn: ['finished', 'canceled'] } },
        select: { id: true, code: true },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (!freight) return JSON.stringify({ error: 'No encontre un flete activo para adjuntar el archivo.' });
    return this.stageAction(session.id, 'attach_document', {
      freightId: freight.id,
      code: freight.code,
      document: pendingDoc,
    }, `Adjuntar "${pendingDoc.name}" al flete ${freight.code}`);
  }

  // ======================== PENDING ACTIONS ========================

  private async handleConfirmAction(user: any, synUser: any, session: any): Promise<string> {
    const pending = await this.getPendingActionRecord(session.id);
    if (!pending) return JSON.stringify({ error: 'No hay accion pendiente para confirmar.' });
    this.pendingActions.delete(session.id);
    await this.clearPersistedPendingAction(session.id);
    const { tool, params } = pending;

    switch (tool) {
      case 'create_freight_request': {
        const freight = await this.freights.create({
          originLotId: params.lotId || undefined,
          fieldId: params.fieldId || undefined,
          customOriginName: !params.fieldId && !params.lotId ? params.origin : undefined,
          destPlantId: params.destPlantId || undefined,
          tolvinkPlantId: params.tolvinkPlantId || undefined,
          customDestName: !params.destPlantId && !params.tolvinkPlantId ? params.destination : undefined,
          loadDate: params.loadDate,
          loadTime: params.loadTime,
          items: [{ grain: params.grain, tons: params.tons }],
          notes: params.notes,
        }, synUser);
        return JSON.stringify({ status: 'created', code: (freight as any).code, id: (freight as any).id });
      }
      case 'approve_freight_request': {
        const freight = await this.freights.approveProducerFreight(params.freightId, synUser);
        return JSON.stringify({ status: 'approved', code: (freight as any).code });
      }
      case 'assign_transport_company': {
        const freight = await this.freights.assign(params.freightId, { transportCompanyId: params.transportCompanyId }, synUser);
        return JSON.stringify({ status: 'assigned', code: params.code || (freight as any).code, transportCompanyName: params.transportCompanyName });
      }
      case 'reject_freight_assignment': {
        if (params.assignmentId) {
          const freight = await this.freights.respondTrip(params.freightId, params.assignmentId, { action: 'rejected', reason: params.reason }, synUser);
          return JSON.stringify({ status: 'rejected', code: params.code || (freight as any).code });
        }
        const freight = await this.freights.respond(params.freightId, { action: 'rejected', reason: params.reason }, synUser);
        return JSON.stringify({ status: 'rejected', code: params.code || (freight as any).code });
      }
      case 'assign_driver_and_truck': {
        const assignment = await this.freights.updateAssignment(params.freightId, params.assignmentId, {
          truckId: params.truckId,
          driverId: params.driverId,
        }, synUser);
        return JSON.stringify({ status: 'accepted', code: params.code, plate: assignment?.plate || params.plate, driverName: assignment?.driverName || params.driverName });
      }
      case 'start_freight_trip': {
        if (params.assignmentId) {
          const freight = await this.freights.startTrip(params.freightId, params.assignmentId, synUser);
          return JSON.stringify({ status: 'started', code: params.code || (freight as any).code });
        }
        const freight = await this.freights.start(params.freightId, synUser);
        return JSON.stringify({ status: 'started', code: params.code || (freight as any).code });
      }
      case 'confirm_freight_loaded': {
        if (params.assignmentId) {
          const freight = await this.freights.confirmTripLoaded(params.freightId, params.assignmentId, synUser, params.loadedTons);
          return JSON.stringify({ status: 'loaded', code: params.code || (freight as any).code });
        }
        const freight = await this.freights.confirmLoaded(params.freightId, synUser, params.loadedTons);
        return JSON.stringify({ status: 'loaded', code: params.code || (freight as any).code });
      }
      case 'confirm_freight_arrival': {
        const freight = await this.freights.registerPlantArrival(params.freightId, synUser);
        return JSON.stringify({ status: 'arrival_registered', code: params.code || (freight as any).code });
      }
      case 'finish_freight': {
        if (params.assignmentId) {
          const freight = await this.freights.confirmTripFinished(params.freightId, params.assignmentId, synUser);
          return JSON.stringify({ status: 'finished', code: params.code || (freight as any).code });
        }
        const freight = await this.freights.confirmFinished(params.freightId, synUser);
        return JSON.stringify({ status: 'finished', code: params.code || (freight as any).code });
      }
      case 'prepare_autonomous_freight': {
        const freight = await this.freights.createAutonomousFreight({
          origin: params.origin,
          destination: params.destination,
          grain: params.grain,
          weightKg: params.weightKg,
          notes: params.notes,
          truckId: params.truckId,
          fieldId: params.fieldId,
          originLotId: params.originLotId,
          destPlantId: params.destPlantId,
          tolvinkPlantId: params.tolvinkPlantId,
          branchId: params.branchId,
        }, synUser);
        return JSON.stringify({ status: 'created', code: (freight as any).code, id: (freight as any).id });
      }
      case 'finish_autonomous_freight': {
        const freight = await this.freights.finishAutonomousFreight(params.freightId, synUser, params.destinationWeightKg, params.notes);
        return JSON.stringify({ status: 'finished', code: (freight as any).code });
      }
      case 'finish_and_create': {
        const finished = await this.freights.finishAutonomousFreight(params.freightId, synUser);
        const nf = params.newFreight || {};
        if (!nf.origin || !nf.destination || !nf.grain || !nf.weightKg) {
          return JSON.stringify({ status: 'finished', code: (finished as any).code });
        }
        const { truckId, truckPlate } = await this.autoDetectTruck(user);
        return this.stageAction(session.id, 'prepare_autonomous_freight', {
          origin: nf.origin,
          destination: nf.destination,
          grain: nf.grain,
          weightKg: Number(nf.weightKg),
          truckPlate,
          notes: nf.notes,
          truckId,
          fieldId: nf.fieldId,
          originLotId: nf.originLotId,
          destPlantId: nf.destPlantId,
          tolvinkPlantId: nf.tolvinkPlantId,
          branchId: nf.branchId,
        }, `Flete ${(finished as any).code} finalizado.\n\nSolicitud de flete\n\n🚛 Camion: ${truckPlate || 'auto'}\n📍 Origen: ${nf.origin}\n🏭 Destino: ${nf.destination}\n🌾 Grano: ${nf.grain}\n⚖️ Peso: ${this.formatWeightKg(nf.weightKg)}`);
      }
      case 'cancel_freight': {
        const freight = await this.freights.cancel(params.freightId, { reason: params.reason }, synUser);
        return JSON.stringify({ status: 'canceled', code: (freight as any).code });
      }
      case 'register_plant_arrival': {
        const freight = await this.freights.registerPlantArrival(params.freightId, synUser);
        return JSON.stringify({ status: 'arrival_registered', code: (freight as any).code });
      }
      case 'attach_document': {
        const doc = await this.freights.addDocument(params.freightId, {
          name: params.document.name,
          url: params.document.url,
          type: params.document.type || 'photo',
        }, synUser);
        const state = (session?.flowState as any) || {};
        const { pendingDocument, ...cleanState } = state;
        if (session?.id) {
          await this.prisma.whatsAppSession.update({
            where: { id: session.id },
            data: { flowState: cleanState },
          });
        }
        return JSON.stringify({ status: 'attached', code: params.code, documentName: doc.name });
      }
      default:
        return JSON.stringify({ error: 'Accion no reconocida.' });
    }
  }

  private stageAction(sessionId: string, tool: string, params: Record<string, any>, summary: string, buttons?: Array<{ id: string; title: string }>): string {
    const actionId = randomUUID().slice(0, 8);
    const resolvedButtons = (buttons || [{ id: 'ai_confirm', title: 'CONFIRMAR' }, { id: 'ai_cancel', title: 'CANCELAR' }]).map((button) => ({
      ...button,
      id: button.id.includes(':') ? button.id : `${button.id}:${actionId}`,
    }));
    const record = { actionId, tool, params, summary, buttons: resolvedButtons, createdAt: Date.now() };
    this.pendingActions.set(sessionId, record);
    void this.persistPendingAction(sessionId, record);
    return JSON.stringify({ status: 'pending_confirmation', summary, actionId });
  }

  async getPendingSummary(sessionId: string): Promise<string | undefined> {
    const pending = await this.getPendingActionRecord(sessionId);
    if (!pending) return undefined;
    if (pending.tool === 'prepare_autonomous_freight') {
      if (pending.summary) return pending.summary;
      const params = pending.params || {};
      return ['Solicitud de flete', '', `🚛 Camion: ${params.truckPlate || 'auto'}`, `📍 Origen: ${params.origin || ''}`, `🏭 Destino: ${params.destination || ''}`, `🌾 Grano: ${params.grain || ''}`, `⚖️ Peso: ${this.formatWeightKg(params.weightKg || 0)}`].join('\n');
    }
    if (pending.tool === 'finish_and_create') {
      const p = pending.params || {};
      return ['Tenes un flete activo:', '', `📋 ${p.code || ''}`, `🌾 ${p.currentGrain || ''}${p.currentTons ? ` · ${p.currentTons} tn` : ''}`, `📍 ${p.currentOrigin || ''} → ${p.currentDest || ''}`, '', 'Finalizalo para crear uno nuevo'].join('\n');
    }
    return pending.summary;
  }

  async getPendingButtons(sessionId: string): Promise<Array<{ id: string; title: string }> | undefined> {
    const pending = await this.getPendingActionRecord(sessionId);
    if (!pending) return undefined;
    if (pending.tool === 'finish_and_create') return [{ id: `ai_confirm:${pending.actionId}`, title: 'FINALIZAR' }];
    return pending.buttons;
  }

  async getPendingActionId(sessionId: string): Promise<string | undefined> {
    return (await this.getPendingActionRecord(sessionId))?.actionId;
  }

  async confirmPendingAction(session: any, user: any): Promise<string> {
    const scopedUser = this.applySessionCompanyScope(user, session);
    const synUser = this.buildSyntheticUser(scopedUser, session);
    return this.handleConfirmAction(scopedUser, synUser, session);
  }

  async cancelPendingAction(sessionId: string, actionId?: string): Promise<boolean> {
    const pending = await this.getPendingActionRecord(sessionId);
    if (!pending) return false;
    if (actionId && pending.actionId !== actionId) return false;
    this.pendingActions.delete(sessionId);
    void this.clearPersistedPendingAction(sessionId);
    return true;
  }

  async hasPendingAction(sessionId: string): Promise<boolean> {
    return !!(await this.getPendingActionRecord(sessionId));
  }

  // ======================== LOW-LEVEL HELPERS ========================

  private applySessionCompanyScope(user: any, session?: any): any {
    if (!user) return user;
    const selectedCompanyId = (session?.flowState as any)?.selectedCompanyId;
    if (!selectedCompanyId) return user;
    const membership = Array.isArray(user.memberships)
      ? user.memberships.find((m: any) => m.companyId === selectedCompanyId && m.active !== false)
      : null;
    if (!membership) return user;
    return {
      ...user,
      activeCompanyId: selectedCompanyId,
      companyId: selectedCompanyId,
      company: membership.company || user.company,
    };
  }

  private async persistPendingAction(sessionId: string, record: PendingActionRecord): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: sessionId },
      select: { flowState: true },
    });
    if (!session) return;
    const state = (session.flowState as any) || {};
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: {
        flowState: {
          ...state,
          pendingAiAction: record,
        },
      },
    });
  }

  private async getPendingActionRecord(sessionId: string): Promise<PendingActionRecord | undefined> {
    this.cleanupPendingActions();
    const cached = this.pendingActions.get(sessionId);
    if (cached) return cached;

    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: sessionId },
      select: { flowState: true },
    });
    const stored = ((session?.flowState as any) || {}).pendingAiAction as PendingActionRecord | undefined;
    if (!stored) return undefined;

    if (!stored.createdAt || Date.now() - stored.createdAt > ToolExecutorService.PENDING_ACTION_TTL_MS) {
      await this.clearPersistedPendingAction(sessionId);
      return undefined;
    }

    this.pendingActions.set(sessionId, stored);
    return stored;
  }

  private async clearPersistedPendingAction(sessionId: string): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { id: sessionId },
      select: { flowState: true },
    });
    if (!session) return;
    const state = (session.flowState as any) || {};
    if (!('pendingAiAction' in state)) return;
    const { pendingAiAction, ...cleanState } = state;
    await this.prisma.whatsAppSession.update({
      where: { id: sessionId },
      data: { flowState: cleanState },
    });
  }

  private getDefaultSchedule(inputDate?: string, inputTime?: string): { loadDate: string; loadTime: string } {
    const now = new Date();
    const loadDate = inputDate || now.toISOString().slice(0, 10);
    const loadTime = inputTime || `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return { loadDate, loadTime };
  }

  private normalizeGrain(grain: string): string {
    const value = (grain || '').trim();
    if (!value) return value;
    return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
  }

  private kgToTons(weightKg: number): number {
    return Math.round((Number(weightKg) / 1000) * 1000) / 1000;
  }

  private formatWeightKg(weightKg: number): string {
    const num = Number(weightKg || 0);
    return num >= 1000 ? `${Math.round(num / 100) / 10} tn` : `${num} kg`;
  }

  private async autoDetectTruck(user: any): Promise<{ truckId: string | null; truckPlate: string }> {
    const companyId = user.activeCompanyId || user.companyId;
    const trucks = await this.prisma.truck.findMany({
      where: { companyId, active: true, assignedUserId: user.sub || user.id },
      select: { id: true, plate: true },
      take: 2,
    });
    if (trucks.length >= 1) return { truckId: trucks[0].id, truckPlate: trucks[0].plate };
    const anyTruck = await this.prisma.truck.findFirst({
      where: { companyId, active: true },
      select: { id: true, plate: true },
    });
    return { truckId: anyTruck?.id || null, truckPlate: anyTruck?.plate || '' };
  }

  private async resolveTransportCompany(identifier?: string): Promise<any> {
    if (!identifier) return null;
    if (this.isUuid(identifier)) {
      const company = await this.prisma.company.findFirst({
        where: { id: identifier, active: true, OR: [{ types: { array_contains: ['transporter'] } }, { hasInternalFleet: true }] },
        select: { id: true, name: true },
      });
      return company ? { company } : null;
    }
    const companies = await this.prisma.company.findMany({
      where: { active: true, OR: [{ types: { array_contains: ['transporter'] } }, { hasInternalFleet: true }] },
      select: { id: true, name: true },
      take: 100,
    });
    const matches = fuzzySearch(identifier, companies, (c: any) => c.name, { threshold: 0.45, maxResults: 5, aliases: ENTITY_ALIASES });
    if (matches.length === 0) return null;
    if (matches.length > 1 && matches[0].score - matches[1].score < 0.08) return { ambiguous: true, options: matches.map((m) => m.item.name) };
    return { company: matches[0].item };
  }

  private async resolveDriver(companyId: string, user: any, driverId?: string, driverName?: string): Promise<any> {
    if (driverId && this.isUuid(driverId)) {
      const membership = await this.prisma.userCompany.findFirst({
        where: { userId: driverId, companyId, active: true },
        include: { user: { select: { id: true, name: true } } },
      });
      if (membership?.user) return { item: membership.user };
    }
    if (driverName?.trim().toLowerCase() === 'yo') {
      const me = await this.prisma.user.findUnique({ where: { id: user.sub || user.id }, select: { id: true, name: true } });
      if (me) return { item: me };
    }
    const drivers = await this.prisma.userCompany.findMany({
      where: { companyId, active: true, role: 'chofer' },
      include: { user: { select: { id: true, name: true } } },
      take: 50,
    });
    const candidates = drivers.map((d) => d.user).filter(Boolean);
    if (!driverName) {
      if (candidates.length === 1) return { item: candidates[0] };
      return null;
    }
    const matches = fuzzySearch(driverName, candidates, (d: any) => d.name, { threshold: 0.45, maxResults: 5 });
    if (matches.length === 0) return null;
    if (matches.length > 1 && matches[0].score - matches[1].score < 0.08) return { ambiguous: true, options: matches.map((m) => m.item.name) };
    return { item: matches[0].item };
  }

  private async resolveTruck(companyId: string, truckId?: string, plate?: string): Promise<any> {
    if (truckId && this.isUuid(truckId)) {
      const truck = await this.prisma.truck.findFirst({
        where: { id: truckId, companyId, active: true },
        select: { id: true, plate: true },
      });
      if (truck) return { item: truck };
    }
    const trucks = await this.prisma.truck.findMany({
      where: { companyId, active: true },
      select: { id: true, plate: true },
      take: 50,
    });
    if (!plate) {
      if (trucks.length === 1) return { item: trucks[0] };
      return null;
    }
    const normalized = plate.replace(/\s+/g, '').toUpperCase();
    const exact = trucks.find((t) => t.plate.replace(/\s+/g, '').toUpperCase() === normalized);
    if (exact) return { item: exact };
    const matches = fuzzySearch(normalized, trucks, (t: any) => t.plate, { threshold: 0.4, maxResults: 5 });
    if (matches.length === 0) return null;
    if (matches.length > 1 && matches[0].score - matches[1].score < 0.08) return { ambiguous: true, options: matches.map((m) => m.item.plate) };
    return { item: matches[0].item };
  }

  private async getDefaultTruckAndDriver(companyId: string, user: any): Promise<any> {
    const driver = await this.resolveDriver(companyId, user, undefined, user.role === 'chofer' ? 'yo' : undefined);
    const truck = await this.resolveTruck(companyId);
    return {
      driverId: driver?.item?.id || null,
      driverName: driver?.item?.name || null,
      truckId: truck?.item?.id || null,
      plate: truck?.item?.plate || null,
    };
  }

  private async resolveDriverTripTarget(user: any, code?: string): Promise<{ freight: any; assignment?: any } | null> {
    if (code) {
      const freight = await this.resolveFreightByCode(code, user);
      if (!freight) return null;
      const assignment = (freight.assignments || []).find((a: any) => a.driverId === (user.sub || user.id)) || undefined;
      return { freight, assignment };
    }
    const assignments = await this.prisma.freightAssignment.findMany({
      where: {
        driverId: user.sub || user.id,
        status: { in: ['active', 'accepted'] },
        freight: { status: { notIn: ['finished', 'canceled'] } },
      },
      include: { freight: { select: { id: true, code: true, status: true, isAutonomous: true, originName: true, originFreeText: true, destName: true, destinationFreeText: true } } },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (assignments.length === 0) {
      const autonomous = await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: { notIn: ['finished', 'canceled'] } },
        select: { id: true, code: true, status: true, isAutonomous: true, originName: true, originFreeText: true, destName: true, destinationFreeText: true },
        orderBy: { createdAt: 'desc' },
      });
      return autonomous ? { freight: autonomous } : null;
    }
    if (assignments.length > 1) return null;
    return { freight: assignments[0].freight, assignment: assignments[0] };
  }

  private async resolveOwnedAssignment(freightId: string, user: any, tripNumber?: number): Promise<any | null> {
    const companyIds = this.resolveAllCompanyIds(user);
    const assignments = await this.prisma.freightAssignment.findMany({
      where: { freightId, status: { in: ['active', 'accepted'] }, transportCompanyId: { in: companyIds } },
      select: { id: true, freightId: true, transportCompanyId: true, tripNumber: true, status: true, tripStatus: true, truckId: true, driverId: true, plate: true, driverName: true },
      orderBy: { tripNumber: 'asc' },
    });
    if (assignments.length === 0) return null;
    if (tripNumber != null) return assignments.find((a) => a.tripNumber === Number(tripNumber)) || null;
    if (assignments.length > 1) throw new Error('Hay varios viajes activos para ese flete. Indica el numero de viaje.');
    return assignments[0];
  }

  private async resolveFreightByCode(code: string, user: any): Promise<any> {
    if (!code) return null;
    const clean = code.toUpperCase().trim();
    const companyIds = this.resolveAllCompanyIds(user);
    const userId = user.sub || user.id;
    const freight = await this.prisma.freight.findFirst({
      where: {
        code: { equals: clean, mode: 'insensitive' },
        OR: [
          { participantCompanyIds: { hasSome: companyIds } },
          { requestedById: userId },
          { assignments: { some: { driverId: userId } } },
        ],
      },
      include: {
        items: { select: { grain: true, tons: true }, take: 1 },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { id: true, transportCompanyId: true, tripNumber: true, status: true, tripStatus: true, truckId: true, driverId: true, plate: true, driverName: true, isExternal: true },
          orderBy: { tripNumber: 'asc' },
          take: 20,
        },
      },
    });
    return freight || null;
  }

  private resolveAllCompanyIds(user: any): string[] {
    const ids = new Set<string>();
    if (user.activeCompanyId) return [user.activeCompanyId];
    if (user.companyId) return [user.companyId];
    if (user.memberships) {
      for (const m of user.memberships) {
        if (m.companyId && m.active !== false) ids.add(m.companyId);
      }
    }
    return Array.from(ids);
  }

  private isUuid(value?: string): boolean {
    return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }
}
