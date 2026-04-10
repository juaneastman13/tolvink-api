// =====================================================================
// TOLVINK — Tool Executor
// Dispatches tool calls to business service handlers
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { FieldsService } from '../../fields/fields.service';
import { TrucksService } from '../../trucks/trucks.controller';
import { buildSyntheticUser } from '../../common/build-synthetic-user';
import { fuzzySearch, classifyFuzzyResult, ENTITY_ALIASES } from '../../common/fuzzy-match';
import { APP_URL, FREIGHT_STATUS_SHORT } from '../core/constants';
import { randomUUID } from 'crypto';

/** Read-only tools safe for parallel execution */
export const READ_ONLY_TOOLS = new Set([
  'list_freights', 'get_freight_detail', 'get_dashboard',
  'search_plants', 'search_fields', 'search_lots',
]);

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  /** In-memory pending actions per session */
  private pendingActions = new Map<string, {
    actionId: string;
    tool: string;
    params: Record<string, any>;
    summary: string;
    createdAt: number;
  }>();

  constructor(
    private prisma: PrismaService,
    private freights: FreightsService,
    private fields: FieldsService,
    private trucks: TrucksService,
  ) {}

  /** Clean up stale pending actions (older than 5 minutes) */
  cleanupPendingActions(): void {
    const now = Date.now();
    for (const [k, v] of this.pendingActions) {
      if (now - v.createdAt > 5 * 60 * 1000) this.pendingActions.delete(k);
    }
  }

  buildSyntheticUser(user: any): any {
    return buildSyntheticUser(user);
  }

  resolveCompanyType(user: any): string {
    const activeCoId = user.activeCompanyId || user.companyId;
    if (activeCoId && user.memberships?.length > 0) {
      const mem = user.memberships.find((m: any) => m.companyId === activeCoId);
      if (mem?.company?.types?.length > 0) return mem.company.types.join(',');
      if (mem?.company?.type) return mem.company.type;
    }
    if (user.company?.types?.length > 0) return user.company.types.join(',');
    if (user.company?.type) return user.company.type;
    return 'unknown';
  }

  async executeTool(
    name: string,
    input: any,
    user: any,
    session: any,
  ): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    try {
      switch (name) {
        // ---- Queries ----
        case 'list_freights': return await this.handleListFreights(input, synUser);
        case 'get_freight_detail': return await this.handleGetFreightDetail(input, user);
        case 'get_dashboard': return await this.handleGetDashboard(synUser);

        // ---- Search ----
        case 'search_plants': return await this.handleSearchPlants(input, user);
        case 'search_fields': return await this.handleSearchFields(input, user);
        case 'search_lots': return await this.handleSearchLots(input, user);

        // ---- Autonomous freight ----
        case 'prepare_autonomous_freight': return await this.handlePrepareAutonomousFreight(input, user, synUser, session);
        case 'confirm_action': return await this.handleConfirmAction(user, synUser, session);
        case 'finish_autonomous_freight': return await this.handleFinishAutonomousFreight(input, user, synUser, session);
        case 'register_plant_arrival': return await this.handleRegisterPlantArrival(input, user, synUser, session);
        case 'cancel_freight': return await this.handleCancelFreight(input, user, synUser, session);

        // ---- Documents ----
        case 'attach_document': return await this.handleAttachDocument(input, user, synUser, session);

        default:
          return JSON.stringify({ error: `Herramienta desconocida: ${name}` });
      }
    } catch (e: any) {
      this.logger.error(`Tool ${name} error: ${e.message}`, e.stack?.slice(0, 300));
      const msg = e.message || '';
      // Pass through business errors
      if (/no encontr|no tiene|no puede|no pertenec|ya existe|estado.*no permite|obligatori/i.test(msg)) {
        return JSON.stringify({ error: msg });
      }
      return JSON.stringify({ error: 'Error al procesar la solicitud.' });
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
    if (!result.data?.length) return JSON.stringify({ total: 0, message: 'No se encontraron fletes con esos filtros.' });
    const items = result.data.map((f: any) => ({
      code: f.code,
      status: FREIGHT_STATUS_SHORT[f.status] || f.status,
      grain: f.items?.[0]?.grain || '',
      tons: f.items?.[0]?.tons || null,
      origin: f.originName || f.originFreeText || '',
      dest: f.destName || f.destinationFreeText || '',
    }));
    return JSON.stringify({ total: result.total, freights: items });
  }

  private async handleGetFreightDetail(input: any, user: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete ${input.code}` });
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
    // Find plant companies via PlantProducerAccess
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: { in: companyIds }, active: true },
      select: { plantCompany: { select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } } } },
    });
    const companies = accesses.map(a => a.plantCompany).filter(Boolean);
    // Also include companies of type plant in user's network
    const plantCompanies = await this.prisma.company.findMany({
      where: { types: { array_contains: ['plant'] }, active: true },
      select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } },
      take: 50,
    });
    // Merge unique
    const allPlants = new Map<string, any>();
    for (const c of [...companies, ...plantCompanies]) {
      if (c && !allPlants.has(c.id)) allPlants.set(c.id, c);
    }
    const results = fuzzySearch(input.query, Array.from(allPlants.values()), (c: any) => c.name, { threshold: 0.5, maxResults: 5, aliases: ENTITY_ALIASES });
    if (results.length === 0) return JSON.stringify({ total: 0, message: `No se encontro planta "${input.query}".` });
    return JSON.stringify({
      total: results.length,
      plants: results.map(r => ({
        companyId: r.item.id,
        name: r.item.name,
        branches: (r.item.plants || []).map((p: any) => ({ id: p.id, name: p.name })),
        score: r.score,
      })),
    });
  }

  private async handleSearchFields(input: any, user: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const allFields = await this.fields.getFields(synUser);
    const results = fuzzySearch(input.query, allFields, (f: any) => f.name, { threshold: 0.5, maxResults: 5 });
    if (results.length === 0) return JSON.stringify({ total: 0, message: `No se encontro campo "${input.query}".` });
    return JSON.stringify({
      total: results.length,
      fields: results.map(r => ({
        id: r.item.id,
        name: r.item.name,
        lots: (r.item.lots || []).map((l: any) => ({ id: l.id, name: l.name })),
        score: r.score,
      })),
    });
  }

  private async handleSearchLots(input: any, user: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    let lots: any[] = [];
    if (input.fieldId) {
      lots = await this.fields.getLots(synUser, input.fieldId);
    } else {
      const allFields = await this.fields.getFields(synUser);
      lots = allFields.flatMap((f: any) => (f.lots || []).map((l: any) => ({ ...l, fieldName: f.name, fieldId: f.id })));
    }
    const results = fuzzySearch(input.query, lots, (l: any) => l.name, { threshold: 0.5, maxResults: 5 });
    if (results.length === 0) return JSON.stringify({ total: 0, message: `No se encontro lote "${input.query}".` });
    return JSON.stringify({
      total: results.length,
      lots: results.map(r => ({
        id: r.item.id,
        name: r.item.name,
        fieldId: r.item.fieldId,
        fieldName: r.item.fieldName || null,
        score: r.score,
      })),
    });
  }

  // ======================== AUTONOMOUS FREIGHT ========================

  private async handlePrepareAutonomousFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    // Check for active autonomous freight
    const activeFreight = await this.prisma.freight.findFirst({
      where: {
        requestedById: user.sub || user.id,
        isAutonomous: true,
        status: { notIn: ['finished', 'canceled'] },
        transporterFinishedConfirmedAt: null,
      },
      select: { id: true, code: true, destName: true, items: { select: { grain: true, tons: true }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    if (activeFreight) {
      const grain = activeFreight.items?.[0]?.grain || '';
      const tons = activeFreight.items?.[0]?.tons;
      return JSON.stringify({
        error: `Ya tenes un flete activo: ${activeFreight.code} (${grain}${tons ? ` · ${tons} tn` : ''} → ${activeFreight.destName || ''}). Finalizalo o cancelalo primero.`,
        activeFreightCode: activeFreight.code,
      });
    }

    // Validate required fields
    if (!input.origin) return JSON.stringify({ error: 'Origen obligatorio.' });
    if (!input.destination) return JSON.stringify({ error: 'Destino obligatorio.' });
    if (!input.grain) return JSON.stringify({ error: 'Grano obligatorio.' });
    if (!input.weightKg || isNaN(Number(input.weightKg)) || Number(input.weightKg) <= 0) {
      return JSON.stringify({ error: 'Peso obligatorio (en kg).' });
    }

    // Auto-detect truck
    const companyId = user.activeCompanyId || user.companyId;
    let truckPlate = '';
    let truckId = null;
    const trucks = await this.prisma.truck.findMany({
      where: { companyId, active: true, assignedUserId: user.sub || user.id },
      select: { id: true, plate: true },
      take: 2,
    });
    if (trucks.length === 1) {
      truckId = trucks[0].id;
      truckPlate = trucks[0].plate;
    } else if (trucks.length === 0) {
      const anyTruck = await this.prisma.truck.findFirst({
        where: { companyId, active: true },
        select: { id: true, plate: true },
      });
      if (anyTruck) { truckId = anyTruck.id; truckPlate = anyTruck.plate; }
    }

    const weightKg = Number(input.weightKg);
    const summary = `📋 Flete autonomo:\n🚛 Camion: ${truckPlate || 'auto-detectar'}\n📍 Origen: ${input.origin}\n🏭 Destino: ${input.destination}\n🌾 Grano: ${input.grain}\n⚖️ Peso: ${weightKg} kg`;

    return this.stageAction(session.id, 'create_autonomous_freight', {
      origin: input.origin,
      destination: input.destination,
      grain: input.grain,
      weightKg,
      notes: input.notes,
      truckId,
      fieldId: input.fieldId,
      originLotId: input.originLotId,
      destPlantId: input.destPlantId,
      branchId: input.branchId,
    }, summary);
  }

  private async handleConfirmAction(user: any, synUser: any, session: any): Promise<string> {
    const pending = this.pendingActions.get(session.id);
    if (!pending) return JSON.stringify({ error: 'No hay accion pendiente.' });
    this.pendingActions.delete(session.id);

    const { tool, params } = pending;

    switch (tool) {
      case 'create_autonomous_freight': {
        const dto = {
          origin: params.origin,
          destination: params.destination,
          grain: params.grain,
          weightKg: params.weightKg,
          notes: params.notes,
          truckId: params.truckId,
          fieldId: params.fieldId,
          originLotId: params.originLotId,
          destPlantId: params.destPlantId,
          branchId: params.branchId,
        };
        const freight = await this.freights.createAutonomousFreight(dto, synUser);
        return JSON.stringify({ status: 'created', code: (freight as any).code, link: `${APP_URL}/freight/${(freight as any).id}` });
      }
      case 'finish_autonomous_freight': {
        const freight = await this.freights.finishAutonomousFreight(params.freightId, synUser, params.destinationWeightKg, params.notes);
        return JSON.stringify({ status: 'finished', code: (freight as any).code });
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
        return JSON.stringify({ status: 'attached', code: params.code, documentName: doc.name });
      }
      default:
        return JSON.stringify({ error: `Accion desconocida: ${tool}` });
    }
  }

  private async handleFinishAutonomousFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    let freight: any;
    if (input.code) {
      freight = await this.resolveFreightByCode(input.code, user);
      if (!freight) return JSON.stringify({ error: `No se encontro flete ${input.code}` });
    } else {
      freight = await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
        select: { id: true, code: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!freight) return JSON.stringify({ error: 'No tenes fletes autonomos activos para finalizar.' });
    }

    const weightKg = input.destinationWeightKg ? Number(input.destinationWeightKg) : undefined;
    return this.stageAction(session.id, 'finish_autonomous_freight', {
      freightId: freight.id,
      code: freight.code,
      destinationWeightKg: weightKg,
    }, `Finalizar flete ${freight.code}${weightKg ? ` (${weightKg} kg)` : ''}`);
  }

  private async handleRegisterPlantArrival(input: any, user: any, synUser: any, session: any): Promise<string> {
    let freight: any;
    if (input.code) {
      freight = await this.resolveFreightByCode(input.code, user);
      if (!freight) return JSON.stringify({ error: `No se encontro flete ${input.code}` });
    } else {
      freight = await this.prisma.freight.findFirst({
        where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
        select: { id: true, code: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!freight) return JSON.stringify({ error: 'No tenes fletes autonomos activos.' });
    }

    return this.stageAction(session.id, 'register_plant_arrival', {
      freightId: freight.id,
      code: freight.code,
    }, `Registrar llegada a planta del flete ${freight.code}`);
  }

  private async handleCancelFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete ${input.code}` });
    if (!input.reason) return JSON.stringify({ error: 'Motivo de cancelacion obligatorio.' });

    return this.stageAction(session.id, 'cancel_freight', {
      freightId: freight.id,
      code: freight.code,
      reason: input.reason,
    }, `Cancelar flete ${freight.code}`);
  }

  // ======================== DOCUMENTS ========================

  private async handleAttachDocument(input: any, user: any, synUser: any, session: any): Promise<string> {
    const freight = await this.resolveFreightByCode(input.code, user);
    if (!freight) return JSON.stringify({ error: `No se encontro flete ${input.code}` });

    const state = (session?.flowState as any) || {};
    const pendingDoc = state.pendingDocument;
    if (!pendingDoc?.url) return JSON.stringify({ error: 'No hay archivo pendiente para adjuntar.' });

    return this.stageAction(session.id, 'attach_document', {
      freightId: freight.id,
      code: freight.code,
      document: pendingDoc,
    }, `Adjuntar "${pendingDoc.name}" a ${freight.code}`);
  }

  // ======================== HELPERS ========================

  private stageAction(sessionId: string, tool: string, params: Record<string, any>, summary: string): string {
    const actionId = randomUUID().slice(0, 8);
    this.pendingActions.set(sessionId, { actionId, tool, params, summary, createdAt: Date.now() });
    return JSON.stringify({
      status: 'pending_confirmation',
      summary,
      actionId,
    });
  }

  /** Get pending buttons for a session (called by agent after tool execution) */
  getPendingButtons(sessionId: string): Array<{ id: string; title: string }> | undefined {
    const pending = this.pendingActions.get(sessionId);
    if (!pending) return undefined;
    return [
      { id: `ai_confirm:${pending.actionId}`, title: 'CONFIRMAR' },
      { id: `ai_cancel:${pending.actionId}`, title: 'CANCELAR' },
    ];
  }

  /** Check if there's a pending action for this session */
  hasPendingAction(sessionId: string): boolean {
    return this.pendingActions.has(sessionId);
  }

  private async resolveFreightByCode(code: string, user: any): Promise<any> {
    if (!code) return null;
    const clean = code.toUpperCase().trim();
    const freight = await this.prisma.freight.findFirst({
      where: { code: { equals: clean, mode: 'insensitive' } },
      include: {
        items: { select: { grain: true, tons: true }, take: 1 },
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { plate: true, driverName: true }, take: 1 },
      },
    });
    return freight || null;
  }

  private resolveAllCompanyIds(user: any): string[] {
    const ids = new Set<string>();
    if (user.activeCompanyId) ids.add(user.activeCompanyId);
    if (user.companyId) ids.add(user.companyId);
    if (user.memberships) {
      for (const m of user.memberships) {
        if (m.companyId && m.active !== false) ids.add(m.companyId);
      }
    }
    return Array.from(ids);
  }
}
