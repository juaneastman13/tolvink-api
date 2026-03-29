// =====================================================================
// TOLVINK — Transport/Truck/Driver AI Tool Handlers
// Extracted from ai.service.ts for modularity
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { TrucksService } from '../../trucks/trucks.controller';
import { FreightsService } from '../../freights/freights.service';
import { SessionManagerService } from '../session/session-manager.service';
import { AiContextService } from './ai-context.service';
import { hasType } from '../ai.utils';
import { fuzzySearch } from '../../common/fuzzy-match';
import { OWN_FLEET_SHORTCUT } from '../ai.constants';

@Injectable()
export class TransportToolsService {
  private readonly logger = new Logger(TransportToolsService.name);

  constructor(
    private prisma: PrismaService,
    private trucksService: TrucksService,
    private freights: FreightsService,
    private sessionManager: SessionManagerService,
    private aiContext: AiContextService,
  ) {}

  // ======================== HELPERS (delegated) ========================

  private buildSyntheticUser(dbUser: any): any {
    return this.aiContext.buildSyntheticUser(dbUser);
  }

  private resolveCompanyType(user: any): string {
    return this.aiContext.resolveCompanyType(user);
  }

  private resolvePlantCompanyId(user: any): string | null {
    return this.aiContext.resolvePlantCompanyId(user);
  }

  private isCallerAdminForCompany(user: any, companyId?: string): boolean {
    return this.aiContext.isCallerAdminForCompany(user, companyId);
  }

  private async resolveFreightWithAccess(code: string, user: any) {
    return this.aiContext.resolveFreightWithAccess(code, user);
  }

  private stageAction(
    session: any,
    tool: string,
    params: Record<string, any>,
    summary: string,
    user?: any,
  ): string {
    return this.sessionManager.stageAction(session.id, tool, params, summary, user);
  }

  private storePendingSelection(
    session: any,
    items: { id: string; title: string; description?: string }[],
    config: { headerText: string; listButtonLabel: string; sectionTitle: string },
    purpose: string,
    extraJson?: Record<string, any>,
  ): string {
    return this.sessionManager.storePendingSelection(session.id, items, config, purpose, extraJson);
  }

  private async resolveAssignment(code: string, assignmentId: string | undefined, user: any, session?: any): Promise<{ freight?: any; assignment?: any; error?: string }> {
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
    // Multiple assignments → show interactive selection list if session available
    if (session?.id) {
      const items = freight.assignments.map((a: any) => ({
        id: `assignment:${a.id}`,
        title: `#${a.tripNumber || '?'} ${a.truck?.plate || 'Sin camión'}`,
        description: `${a.driver?.name || 'Sin chofer'} — ${a.tripStatus || 'pendiente'}`,
      }));
      this.storePendingSelection(session, items, {
        headerText: `${freight.code} tiene ${freight.assignments.length} viajes.\nSeleccione cuál:`,
        listButtonLabel: 'Ver viajes',
        sectionTitle: 'VIAJES ASIGNADOS',
      }, 'assignment_selection');
      return { error: `_selectionSent` };
    }
    const list = freight.assignments.map((a: any) => `- ${a.id}: ${a.truck?.plate || 'sin camión'} (${a.driver?.name || 'sin chofer'}) — ${a.tripStatus || 'sin estado'}`).join('\n');
    return { error: `El flete ${code} tiene ${freight.assignments.length} viajes. Indique el assignmentId. Viajes:\n${list}` };
  }

  // ======================== TOOL HANDLERS ========================

  // ---- list_transporters ----
  async toolListTransporters(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!hasType(companyType, 'plant') && !hasType(companyType, 'producer')) {
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

    // LEGACY: PlantProducerAccess — to be migrated to CompanyAccess
    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { OR: [{ producerCompanyId: ownCompanyId }, { plantCompanyId: ownCompanyId }], active: true },
      select: { producerCompanyId: true, plantCompanyId: true },
      take: 500,
    });
    // CompanyAccess: both directions (grantor and grantee)
    const caRecords = await this.prisma.companyAccess.findMany({
      where: { OR: [{ granteeCompanyId: ownCompanyId }, { grantorCompanyId: ownCompanyId }], isActive: true },
      select: { grantorCompanyId: true, granteeCompanyId: true },
      take: 200,
    });
    const relatedCompanyIds = [...new Set([
      ...accessRecords.map(a => a.producerCompanyId === ownCompanyId ? a.plantCompanyId : a.producerCompanyId),
      ...caRecords.map(r => r.grantorCompanyId === ownCompanyId ? r.granteeCompanyId : r.grantorCompanyId),
    ])];
    const freightRelated = await this.prisma.freightAssignment.findMany({
      where: {
        transportCompanyId: { not: null },
        freight: { OR: [{ originCompanyId: ownCompanyId }, { destCompanyId: ownCompanyId }] },
      },
      distinct: ['transportCompanyId'],
      select: { transportCompanyId: true },
      take: 100,
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

    let result: any[] = transporters.map(c => ({ id: c.id, name: c.name, phone: c.phone }));

    // P2-4: If query provided, apply fuzzy filter
    if (input?.query && typeof input.query === 'string' && input.query.trim()) {
      const fuzzyResults = fuzzySearch(input.query.trim(), result, (r) => r.name, { threshold: 0.4, maxResults: 10 });
      if (fuzzyResults.length > 0) {
        result = fuzzyResults.map(r => r.item);
      }
      // If no fuzzy match, keep full list so user sees all options
    }

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
  async toolAssignTransporter(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    const isPlant = hasType(companyType, 'plant');
    const isOwnFleetInput = input.transporterCompanyId === OWN_FLEET_SHORTCUT;
    const isProducerWithOwnFleet = hasType(companyType, 'producer') && isOwnFleetInput;
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
  async toolAssignTruckToTrip(input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!hasType(companyType, 'plant')) {
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
  async toolAssignTruckToFreight(input: any, user: any, synUser: any, session: any): Promise<string> {
    // Only plants or producers with own fleet can assign additional trucks
    const companyType = this.resolveCompanyType(user);
    const isPlant = hasType(companyType, 'plant');
    const isProducerOwnFleet = hasType(companyType, 'producer') && input.transporterCompanyId === OWN_FLEET_SHORTCUT;
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
    if (hasType(companyType, 'plant')) {
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

  // ---- assign_multi_trucks ----
  async toolAssignMultiTrucks(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden asignar múltiples camiones.' });
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

  // ---- cancel_assignment ----
  async toolCancelAssignment(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    const isPlant = hasType(companyType, 'plant');
    const isProducer = hasType(companyType, 'producer');
    if (!isPlant && !isProducer) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta o productor pueden cancelar asignaciones.' });
    }
    const res = await this.resolveAssignment(input.code, input.assignmentId, user, session);
    if (res.error) {
      if (res.error === '_selectionSent') return JSON.stringify({ _selectionSent: true, message: 'Seleccione el viaje a cancelar.' });
      return JSON.stringify({ error: res.error });
    }
    const { freight, assignment } = res;
    // Producers can only cancel own-fleet assignments
    if (isProducer && !isPlant) {
      const userCompanyId = user.activeCompanyId || user.companyId;
      if (assignment.transportCompanyId !== userCompanyId) {
        return JSON.stringify({ error: 'Solo puede cancelar asignaciones de su propia flota. Para asignaciones de otros transportistas, contacte a la planta.' });
      }
    }
    const tripInfo = `${assignment.truck?.plate || 'sin camión'} — ${assignment.driver?.name || 'sin chofer'}`;
    return this.stageAction(session, 'cancel_assignment', {
      freightId: freight.id, assignmentId: assignment.id, code: freight.code, reason: input.reason, tripInfo,
    }, `Cancelar asignación de ${freight.code} (${tripInfo}) — Motivo: ${input.reason}`);
  }

  // ---- update_assignment ----
  async toolUpdateAssignment(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!hasType(companyType, 'plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden editar asignaciones.' });
    }
    const res = await this.resolveAssignment(input.code, input.assignmentId, user, session);
    if (res.error) { if (res.error === '_selectionSent') return JSON.stringify({ _selectionSent: true, message: 'Seleccione el viaje a editar.' }); return JSON.stringify({ error: res.error }); }
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

  // ---- list_trucks ----
  async toolListTrucks(user: any, session: any): Promise<string> {
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
      headerText: '🚛 Camiones registrados.\nSeleccione uno:',
      listButtonLabel: 'Ver camiones',
      sectionTitle: 'CAMIONES',
    }, 'truck_info');
  }

  // ---- create_truck ----
  async toolCreateTruck(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente pueden registrar camiones.' });
    }
    const synUser = this.buildSyntheticUser(user);
    const dto = { plate: input.plate, model: input.model || null };
    const summary = `Registrar camión ${input.plate}${input.model ? ` (${input.model})` : ''}`;

    return this.stageAction(session, 'create_truck', { dto, actionSynUser: synUser }, summary);
  }

  // ---- update_truck ----
  async toolUpdateTruck(input: any, user: any, session: any): Promise<string> {
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

  // ---- deactivate_truck ----
  async toolDeactivateTruck(input: any, user: any, session: any): Promise<string> {
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

  // ---- list_drivers ----
  async toolListDrivers(user: any, session: any): Promise<string> {
    const synUser = this.buildSyntheticUser(user);
    const drivers = await this.trucksService.listDrivers(synUser);

    if ((drivers as any[]).length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay choferes registrados.' });
    }

    const driverIds = (drivers as any[]).map(d => d.id);
    const trucks = await this.prisma.truck.findMany({
      where: { assignedUserId: { in: driverIds }, active: true },
      select: { assignedUserId: true, plate: true, model: true },
      take: 100,
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
      headerText: '👤 Choferes registrados.\nSeleccione uno:',
      listButtonLabel: 'Ver choferes',
      sectionTitle: 'CHOFERES',
    }, 'driver_info', { drivers: driversData });
  }

  // ---- create_driver ----
  async toolCreateDriver(input: any, user: any, session: any): Promise<string> {
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

  // ---- deactivate_driver ----
  async toolDeactivateDriver(input: any, user: any, session: any): Promise<string> {
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

  // ---- view_driver_queue ----
  async toolViewDriverQueue(input: any, user: any): Promise<string> {
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
  async toolReorderDriverQueue(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!hasType(companyType, 'plant') && !['admin', 'platform_admin'].includes(user.role)) {
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

  // ======================== G1: ASSIGN EXTERNAL TRUCK =======================

  async toolAssignExternalTruck(input: any, user: any, synUser: any, session: any): Promise<string> {
    if (!input.plate?.trim()) return JSON.stringify({ error: 'Matrícula (plate) es obligatoria.' });
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    return this.stageAction(session, 'assign_external_truck', {
      freightId: freight.id,
      code: freight.code,
      plate: input.plate.trim().toUpperCase(),
      externalCompanyName: input.externalCompanyName?.trim() || null,
      externalDriverName: input.externalDriverName?.trim() || null,
    }, `Asignar camión externo ${input.plate.trim().toUpperCase()} a flete ${freight.code}`, user);
  }

  // ======================== G2: ASSIGN MIXED TRUCKS =========================

  async toolAssignMixedTrucks(input: any, user: any, synUser: any, session: any): Promise<string> {
    if (!Array.isArray(input.trucks) || input.trucks.length === 0) {
      return JSON.stringify({ error: 'Debe indicar al menos un camión en la lista trucks[].' });
    }
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    // Validate each truck entry
    for (let i = 0; i < input.trucks.length; i++) {
      const t = input.trucks[i];
      if (t.isExternal && !t.plate?.trim()) {
        return JSON.stringify({ error: `Camión #${i + 1}: matrícula obligatoria para camión externo.` });
      }
      if (!t.isExternal && !t.transportCompanyId) {
        return JSON.stringify({ error: `Camión #${i + 1}: transportCompanyId obligatorio para camión interno.` });
      }
    }

    const summary = input.trucks.map((t: any, i: number) =>
      t.isExternal ? `#${i + 1} Externo: ${t.plate}` : `#${i + 1} Empresa: ${t.transportCompanyId?.substring(0, 8)}...`
    ).join('\n');

    return this.stageAction(session, 'assign_mixed_trucks', {
      freightId: freight.id,
      code: freight.code,
      trucks: input.trucks,
    }, `Asignar ${input.trucks.length} camiones a flete ${freight.code}:\n${summary}`, user);
  }

  // ======================== G3: EDIT EXTERNAL ASSIGNMENT ====================

  async toolEditExternalAssignment(input: any, user: any, synUser: any, session: any): Promise<string> {
    const result = await this.resolveFreightWithAccess(input.code, user);
    if (result.error) return JSON.stringify({ error: result.error });
    const freight = result.freight;

    // Find external assignment
    const assignments = (freight as any).assignments?.filter((a: any) => a.isExternal && ['active', 'accepted'].includes(a.status)) || [];
    if (assignments.length === 0) {
      return JSON.stringify({ error: 'Este flete no tiene asignaciones de camiones externos activas.' });
    }

    let assignment = assignments[0];
    if (input.assignmentId) {
      assignment = assignments.find((a: any) => a.id === input.assignmentId);
      if (!assignment) return JSON.stringify({ error: 'Asignación no encontrada.' });
    } else if (assignments.length > 1) {
      return JSON.stringify({ error: `Hay ${assignments.length} asignaciones externas. Indique assignmentId.`, assignments: assignments.map((a: any) => ({ id: a.id, plate: a.plate, tripNumber: a.tripNumber })) });
    }

    const changes: string[] = [];
    if (input.plate) changes.push(`Matrícula: ${assignment.plate || '—'} → ${input.plate.toUpperCase()}`);
    if (input.externalCompanyName !== undefined) changes.push(`Empresa: ${assignment.externalCompanyName || '—'} → ${input.externalCompanyName || '—'}`);
    if (input.externalDriverName !== undefined) changes.push(`Chofer: ${assignment.externalDriverName || '—'} → ${input.externalDriverName || '—'}`);
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });

    return this.stageAction(session, 'edit_external_assignment', {
      freightId: freight.id,
      code: freight.code,
      assignmentId: assignment.id,
      plate: input.plate?.trim().toUpperCase() || undefined,
      externalCompanyName: input.externalCompanyName?.trim() || undefined,
      externalDriverName: input.externalDriverName?.trim() || undefined,
    }, `Editar camión externo en flete ${freight.code}:\n${changes.join('\n')}`, user);
  }
}
