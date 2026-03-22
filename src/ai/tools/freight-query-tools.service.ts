// =====================================================================
// TOLVINK — Freight Read-Only Query AI Tool Handlers
// Extracted from ai.service.ts for modularity
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { SessionManagerService } from '../session/session-manager.service';
import { AiContextService } from './ai-context.service';
import { hasType } from '../ai.utils';
import { fuzzySearch, classifyFuzzyResult, ENTITY_ALIASES } from '../../common/fuzzy-match';
import { FREIGHT_STATUS_LABELS, FREIGHT_STATUS_SHORT, APP_URL } from '../ai.constants';

@Injectable()
export class FreightQueryToolsService {
  private readonly logger = new Logger(FreightQueryToolsService.name);

  constructor(
    private prisma: PrismaService,
    private freights: FreightsService,
    private sessionManager: SessionManagerService,
    private aiContext: AiContextService,
  ) {}

  // ======================== HELPERS (delegated) ========================

  private async resolveFreightWithAccess(code: string, user: any) {
    return this.aiContext.resolveFreightWithAccess(code, user);
  }

  private resolveProducerCompanyId(user: any): string | null {
    return this.aiContext.resolveProducerCompanyId(user);
  }

  private resolveCompanyType(user: any): string {
    return this.aiContext.resolveCompanyType(user);
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

  // ======================== TOOL HANDLERS ========================

  // ---- list_freights ----
  async toolListFreights(synUser: any, input: any, session: any): Promise<string> {
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
      headerText: `📦 ${filtered.length} flete${filtered.length !== 1 ? 's' : ''}${statusLabel}.\nSeleccione uno:`,
      listButtonLabel: 'Ver fletes',
      sectionTitle: 'FLETES',
    }, 'freight_selection');
  }

  // ---- summarize_freights ----
  async toolSummarizeFreights(synUser: any, input: any): Promise<string> {
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

  // ---- get_freight_detail ----
  async toolGetFreightDetail(input: any, user: any, session?: any): Promise<string> {
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
      this.sessionManager.updateActiveContext(session.id, {
        lastFreightId: freight.id,
        lastFreightCode: freight.code,
        lastFreightSummary: `${grain} ${tons}tn, ${originName} → ${destName}, ${freight.status}`,
      });
    }

    // ── Build available actions based on user role + freight status ──
    const isOriginCompany = allUserCompanies.includes(freight.originCompanyId);
    const isDestCompany = allUserCompanies.includes(freight.destCompanyId || '');
    const isTransporter = freight.assignments.some((a: any) => allUserCompanies.includes(a.transportCompanyId));
    const isDriver = freight.assignments.some((a: any) => a.driverId === (user.id || user.sub));
    const isOwnFleet = (freight as any).useOwnFleet === true;
    const status = freight.status as string;
    const companyType = this.resolveCompanyType(user);
    const hasAssignment = freight.assignments.length > 0;

    const actions: { id: string; title: string; description: string }[] = [];

    // pending_assignment
    if (status === 'pending_assignment') {
      if (isDestCompany) actions.push({ id: 'action:assign', title: '🚛 Asignar transportista', description: 'Asignar camión al flete' });
      if (isOriginCompany) actions.push({ id: 'action:cancel', title: '❌ Cancelar flete', description: 'Cancelar este flete' });
    }
    // assigned
    if (status === 'assigned') {
      if (isTransporter || isDriver) {
        actions.push({ id: 'action:accept', title: '✅ Aceptar flete', description: 'Aceptar la asignación' });
        actions.push({ id: 'action:reject', title: '🚫 Rechazar flete', description: 'Rechazar la asignación' });
      }
      if (isDestCompany && isOwnFleet) actions.push({ id: 'action:authorize', title: '🔑 Autorizar flete', description: 'Autorizar flota propia' });
      if (isOriginCompany || isDestCompany) actions.push({ id: 'action:cancel', title: '❌ Cancelar flete', description: 'Cancelar este flete' });
    }
    // accepted
    if (status === 'accepted') {
      if (isTransporter || isDriver || (isOriginCompany && isOwnFleet)) {
        actions.push({ id: 'action:start', title: '🚀 Iniciar viaje', description: 'Comenzar el transporte' });
      }
      if (isOriginCompany || isDestCompany) actions.push({ id: 'action:cancel', title: '❌ Cancelar flete', description: 'Cancelar este flete' });
    }
    // in_progress
    if (status === 'in_progress') {
      if (isTransporter || isDriver || isOriginCompany) {
        actions.push({ id: 'action:confirm_loaded', title: '📦 Confirmar carga', description: 'Confirmar que se cargó' });
      }
    }
    // loaded
    if (status === 'loaded') {
      if (isTransporter || isDestCompany) {
        actions.push({ id: 'action:confirm_finished', title: '🏁 Confirmar entrega', description: 'Confirmar que se entregó' });
      }
    }
    // Common actions for non-terminal statuses
    if (!['finished', 'canceled'].includes(status)) {
      if (isOriginCompany || isDestCompany) {
        actions.push({ id: 'action:edit', title: '✏️ Editar flete', description: 'Modificar datos del flete' });
        actions.push({ id: 'action:add_truck', title: '➕ Agregar camión', description: 'Agregar un camión al flete' });
        const truckCountVal = (freight as any).truckCount || 1;
        if (truckCountVal > 1 || freight.assignments.length > 0) {
          actions.push({ id: 'action:remove_truck', title: '➖ Quitar camión', description: 'Quitar un camión del flete' });
        }
      }
    }
    // Always available (non-terminal)
    if (!['canceled'].includes(status)) {
      actions.push({ id: 'action:tracking', title: '📍 Ver ubicación', description: 'Enlace de seguimiento' });
      actions.push({ id: 'action:duplicate', title: '📋 Duplicar flete', description: 'Crear copia con nueva fecha' });
    }

    // Fetch last rejection info if freight is pending_assignment
    let lastRejection: { transporter: string; reason: string } | undefined;
    if (freight.status === 'pending_assignment') {
      const rejectedAssignment = await this.prisma.freightAssignment.findFirst({
        where: { freightId: freight.id, status: 'rejected' },
        orderBy: { updatedAt: 'desc' },
        include: { transportCompany: { select: { name: true } } },
      });
      if (rejectedAssignment) {
        lastRejection = {
          transporter: rejectedAssignment.transportCompany?.name || 'Desconocido',
          reason: rejectedAssignment.reason || 'Sin motivo',
        };
      }
    }

    // Store actions list as pending selection if there are any
    if (actions.length > 0 && session?.id) {
      const effects = this.sessionManager.getSideEffects(session.id);
      effects._pendingSelection = {
        items: actions,
        config: {
          headerText: `⚡ Acciones para ${freight.code}:`,
          listButtonLabel: 'Acciones',
          sectionTitle: 'ACCIONES DISPONIBLES',
        },
        purpose: 'freight_actions',
      };
      // Also set quick-action buttons (max 3) based on status + role
      const quickButtons = this.getQuickActionButtons(status, freight.id, isOriginCompany, isDestCompany, isTransporter);
      if (quickButtons.length > 0) {
        effects._pendingButtons = quickButtons;
      }
      effects._ts = effects._ts || Date.now();
      this.sessionManager.setSideEffects(session.id, effects);
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
      truckCount: (freight as any).truckCount || 1,
      assignedTruckCount: freight.assignments.length,
      assignments: freight.assignments.map((a: any) => ({
          id: a.id,
          tripNumber: a.tripNumber || null,
          transporter: a.transportCompany?.name || null,
          transportCompanyId: a.transportCompanyId || null,
          driver: a.driver?.name || null,
          truck: a.truck?.plate || null,
          tripStatus: a.tripStatus || null,
        })),
      notes: isOriginOrDest ? ((freight as any).notes || null) : null,
      lastRejection: lastRejection || undefined,
      link: `${APP_URL}/freight/${freight.id}`,
      mapLink,
      _selectionSent: actions.length > 0,
      availableActions: actions.map(a => a.title),
    });
  }

  /** Get top 3 quick-action buttons based on freight status and user role. */
  private getQuickActionButtons(
    status: string, freightId: string,
    isOrigin: boolean, isDest: boolean, isTransporter: boolean,
  ): Array<{ id: string; title: string }> {
    const btns: Array<{ id: string; title: string }> = [];
    if (status === 'pending_assignment' && isDest) {
      btns.push({ id: `reassign:${freightId}`, title: 'Asignar transporte' });
    }
    if (status === 'assigned' && isTransporter) {
      btns.push({ id: `accept:${freightId}`, title: 'Aceptar' });
      btns.push({ id: `reject:${freightId}`, title: 'Rechazar' });
    }
    if (status === 'accepted' && isTransporter) {
      btns.push({ id: `start:${freightId}`, title: 'Iniciar viaje' });
    }
    if ((status === 'in_progress' || status === 'loaded') && (isOrigin || isTransporter)) {
      btns.push({ id: `confirm_loaded:${freightId}`, title: 'Confirmar carga' });
    }
    if (status === 'loaded' && isDest) {
      btns.push({ id: `confirm_finished:${freightId}`, title: 'Confirmar entrega' });
    }
    if (btns.length < 3 && !['finished', 'canceled'].includes(status) && (isOrigin || isDest)) {
      btns.push({ id: `cancel:${freightId}`, title: 'Cancelar' });
    }
    return btns.slice(0, 3);
  }

  // ---- get_dashboard ----
  async toolGetDashboard(user: any): Promise<string> {
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
        take: 100,
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

  // ---- freight_history ----
  async toolFreightHistory(input: any, user: any): Promise<string> {
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

  // ---- list_documents ----
  async toolListDocuments(input: any, user: any): Promise<string> {
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

  // ---- search_plants ----
  async toolSearchPlants(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', plants: [] });
    }

    // LEGACY: PlantProducerAccess — to be migrated to CompanyAccess
    const accessRecords = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      select: { plantCompanyId: true },
      take: 500,
    });

    // CompanyAccess: plants that granted OPERATOR access to this producer
    const companyAccessRecords = await this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: producerCompanyId, isActive: true, accessLevel: 'OPERATOR' },
      select: { grantorCompanyId: true },
      take: 200,
    });

    const plantCompanyIds = [...new Set([
      ...accessRecords.map(ar => ar.plantCompanyId),
      ...companyAccessRecords.map(r => r.grantorCompanyId),
    ])];
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
      // Search by company name first (P2-5: include entity aliases)
      const fuzzyResults = fuzzySearch(input.query, companies, (c) => c.name, { threshold: 0.55, maxResults: 10, aliases: ENTITY_ALIASES });

      // P1 fix: also search by branch/sucursal name for better matching
      const branchResults = fuzzySearch(
        input.query,
        companies.flatMap((c: any) => (c.plants || []).map((b: any) => ({ ...b, _parentCompany: c }))),
        (b: any) => b.name,
        { threshold: 0.55, maxResults: 10, aliases: ENTITY_ALIASES },
      );
      // Merge: add parent companies from branch matches not already in results
      const resultIds = new Set(fuzzyResults.map(r => r.item.id));
      for (const br of branchResults) {
        const parent = (br.item as any)._parentCompany;
        if (parent && !resultIds.has(parent.id)) {
          fuzzyResults.push({ item: parent, score: br.score, matchedLabel: br.matchedLabel });
          resultIds.add(parent.id);
        }
      }
      fuzzyResults.sort((a, b) => b.score - a.score);

      matchType = classifyFuzzyResult(fuzzyResults);
      filtered = fuzzyResults.slice(0, 10).map(r => r.item) as any;
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
  async toolListLots(user: any, session: any, input?: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) {
      return JSON.stringify({ error: 'No es productor', lots: [] });
    }

    const where: any = { companyId: producerCompanyId, active: true };
    if (input?.fieldId) where.fieldId = input.fieldId;

    const lots = await this.prisma.lot.findMany({
      where,
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

    const fieldName = input?.fieldId && lots[0]?.field?.name ? lots[0].field.name : null;
    const headerText = fieldName
      ? `🗺️ Lotes de ${fieldName}.\nSeleccione uno:`
      : '🗺️ Lotes registrados.\nSeleccione uno:';

    return this.storePendingSelection(session, items, {
      headerText,
      listButtonLabel: 'Ver lotes',
      sectionTitle: 'LOTES',
    }, 'lot_info', { lots: lotsData });
  }

  // ---- list_fields ----
  async toolListFields(user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No es productor', fields: [] });
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      include: { lots: { where: { active: true } } },
      orderBy: { name: 'asc' },
      take: 100,
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
      headerText: '🌾 Campos registrados.\nSeleccione uno:',
      listButtonLabel: 'Ver campos',
      sectionTitle: 'CAMPOS',
    }, 'field_info', { fields: fieldsData });
  }

  // ---- search_fields ----
  async toolSearchFields(input: any, user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No es productor.' });
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      select: { id: true, name: true, address: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    if (fields.length === 0) return JSON.stringify({ results: [], message: 'No hay campos registrados.' });
    const results = fuzzySearch(input.query, fields, (f) => f.name, { threshold: 0.4, maxResults: 10 });
    if (results.length === 0) {
      return JSON.stringify({ results: [], message: `No se encontraron campos con "${input.query}".`, total: fields.length });
    }
    return JSON.stringify({ results: results.map(r => ({ ...r.item, score: r.score })) });
  }

  // ---- search_lots ----
  async toolSearchLots(input: any, user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No es productor.' });
    const where: any = { companyId: producerCompanyId, active: true };
    if (input.fieldId) where.fieldId = input.fieldId;
    const lots = await this.prisma.lot.findMany({
      where,
      select: { id: true, name: true, hectares: true, field: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
      take: 500,
    });
    if (lots.length === 0) return JSON.stringify({ results: [], message: 'No hay lotes registrados.' });
    const results = fuzzySearch(input.query, lots, (l) => l.name, { threshold: 0.4, maxResults: 10 });
    if (results.length === 0) {
      return JSON.stringify({ results: [], message: `No se encontraron lotes con "${input.query}".`, total: lots.length });
    }
    return JSON.stringify({ results: results.map(r => ({ ...r.item, score: r.score })) });
  }
}
