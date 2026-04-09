// =====================================================================
// TOLVINK — Tool executor: dispatches tool calls to service methods
// Mirrors the original _executeToolInner switch/case from ai.service.ts
// =====================================================================

import { Injectable, Logger, Inject, forwardRef, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { FieldsService } from '../../fields/fields.service';
import { TrucksService } from '../../trucks/trucks.controller';
import { AdminService } from '../../admin/admin.controller';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { OcrService } from '../../ocr/ocr.service';
import { SessionManagerService } from '../conversation/session-manager';
import { sanitizeForPrompt, hasType, resolveActiveRole, resolveCompanyTypes, isProducerMembership } from '../utils/ai-utils';
import { sanitizeToolError, sanitizeConfirmError, sanitizeErrorForLog, classifyAiError } from '../utils/error-handler';
import { CONSULTA_BLOCKED_TOOLS, ACTION_TOOLS, SEARCH_TOOLS } from './tool-permissions';
import { APP_URL, OWN_FLEET_SHORTCUT, FREIGHT_STATUS_LABELS, FREIGHT_STATUS_SHORT, URUGUAY_UTC_OFFSET_MS } from '../core/constants';
import { fuzzySearch, classifyFuzzyResult, ENTITY_ALIASES } from '../../common/fuzzy-match';
import { buildSyntheticUser } from '../../common/build-synthetic-user';
import { createSignedToken } from '../../common/signed-token';
import { buildFreightSelectionItems } from './handlers/freight-query.handlers';
import { RunTree } from 'langsmith/run_trees';
import * as crypto from 'crypto';
import * as bcryptAi from 'bcryptjs';

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);
  private readonly langsmithEnabled = String(process.env.LANGSMITH_TRACING || '').toLowerCase() === 'true' && !!process.env.LANGSMITH_API_KEY;
  /** Per-user GPS request cooldown */
  private locationCooldowns = new Map<string, number>();

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    @Inject(forwardRef(() => FreightsService)) private freights: FreightsService,
    @Inject(forwardRef(() => WhatsAppService)) private wa: WhatsAppService,
    private fieldsService: FieldsService,
    private trucksService: TrucksService,
    private adminService: AdminService,
    private ocrService: OcrService,
    private sessionManager: SessionManagerService,
  ) {}

  cleanupCooldowns(): void {
    const now = Date.now();
    for (const [k, v] of this.locationCooldowns) {
      if (v < now) this.locationCooldowns.delete(k);
    }
  }

  // ======================== CONTEXT HELPERS ========================

  buildSyntheticUser(dbUser: any): any { return buildSyntheticUser(dbUser); }

  resolveCompanyType(user: any): string {
    const activeCoId = user.activeCompanyId || user.companyId;
    if (activeCoId && user.memberships?.length > 0) {
      const activeMem = user.memberships.find((m: any) => m.companyId === activeCoId);
      if (activeMem?.company) {
        const types = resolveCompanyTypes(activeMem.company);
        if (types.length > 0) return types.join(', ');
      }
    }
    if (user.company) {
      const types = resolveCompanyTypes(user.company);
      if (types.length > 0) return types.join(', ');
    }
    return 'unknown';
  }

  resolveProducerCompanyId(user: any): string | null {
    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isProducerMembership(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isProducerMembership);
      if (pm) return pm.companyId;
    }
    if (resolveCompanyTypes(user.company).includes('producer')) return user.companyId;
    return null;
  }

  resolveProducerCompanyIdForCompany(user: any, targetCompanyId: string): string | null {
    if (user.memberships?.length > 0) {
      const targetMem = user.memberships.find((m: any) => m.companyId === targetCompanyId && isProducerMembership(m));
      if (targetMem) return targetMem.companyId;
    }
    return this.resolveProducerCompanyId(user);
  }

  resolvePlantCompanyId(user: any): string | null {
    const isPlant = (m: any) => m.company?.type === 'plant' || (Array.isArray(m.company?.types) && m.company.types.includes('plant'));
    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isPlant(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isPlant);
      if (pm) return pm.companyId;
    }
    if (resolveCompanyTypes(user.company).includes('plant')) return user.companyId;
    return null;
  }

  isCallerAdminForCompany(user: any, companyId?: string): boolean {
    if (user.isSuperAdmin || user.role === 'platform_admin') return true;
    if (!companyId) {
      const memberRoles = (user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.role);
      return [user.role || '', ...memberRoles].some((r: string) => ['admin', 'gerente', 'platform_admin'].includes(r));
    }
    const membership = (user.memberships || []).find((m: any) => m.companyId === companyId && m.active);
    if (!membership) return false;
    return ['admin', 'gerente'].includes(membership.role);
  }

  canAccessCompany(user: any, synUser: any, companyId: string): boolean {
    const ids = [synUser.companyId, ...(user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.companyId)].filter(Boolean);
    return ids.includes(companyId);
  }

  async resolveFreightWithAccess(code: string, user: any): Promise<{ freight?: any; error?: string }> {
    if (!code || typeof code !== 'string') return { error: 'Codigo de flete requerido.' };
    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).filter((m: any) => m.active).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);

    let freight: any = await this.prisma.freight.findFirst({
      where: { code: code.toUpperCase() },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true, isAutonomous: true, requestedById: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
    });

    if (!freight) {
      const sanitized = code.replace(/[^a-zA-Z0-9.\-]/g, '').toUpperCase();
      if (sanitized.length >= 3) {
        const candidates = await this.prisma.freight.findMany({
          where: {
            code: { contains: sanitized, mode: 'insensitive' },
            OR: [
              { originCompanyId: { in: allUserCompanies } },
              { destCompanyId: { in: allUserCompanies } },
              { assignments: { some: { transportCompanyId: { in: allUserCompanies } } } },
              { assignments: { some: { driverId: user.id } } },
            ],
          },
          select: {
            id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
            isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
            assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
          },
          take: 5,
        });
        if (candidates.length === 1) freight = candidates[0];
        else if (candidates.length > 1) {
          const codes = candidates.map((c: any) => c.code).join(', ');
          return { error: `Se encontraron varios fletes: ${codes}. Indique el codigo completo.` };
        }
      }
    }

    if (!freight) return { error: `No se encontro el flete ${code} o no tiene acceso.` };

    const freightCompanies = [freight.originCompanyId, freight.destCompanyId, ...(freight.assignments || []).map((a: any) => a.transportCompanyId)].filter(Boolean);
    const isDriver = (freight.assignments || []).some((a: any) => a.driverId === user.id);
    const isCompanyUser = allUserCompanies.some((c: string) => freightCompanies.includes(c));
    if (!isDriver && !isCompanyUser) return { error: `No se encontro el flete ${code} o no tiene acceso.` };
    if (isDriver && !isCompanyUser) {
      freight.assignments = (freight.assignments || []).filter((a: any) => a.driverId === user.id);
    }
    return { freight };
  }

  // ======================== MAIN DISPATCH ========================

  async executeTool(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
    plantAccessMap?: Map<string, string>,
  ): Promise<string> {
    let toolTrace: RunTree | null = null;
    if (this.langsmithEnabled) {
      try {
        toolTrace = new RunTree({
          name: 'tool.execute',
          run_type: 'tool',
          inputs: {
            toolName,
            sessionId: session?.id || null,
            userId: user?.id || null,
            companyId: user?.activeCompanyId || user?.companyId || null,
            input,
          },
          tags: ['tolvink', 'ai', 'tool', toolName],
          metadata: { component: 'ToolExecutorService' },
        });
        await toolTrace.postRun();
      } catch (e: any) {
        this.logger.warn(`LangSmith tool trace init failed (${toolName}): ${sanitizeErrorForLog(e?.message)}`);
        toolTrace = null;
      }
    }

    try {
      // Pre-check: block action tools for CONSULTA users
      if (plantAccessMap && CONSULTA_BLOCKED_TOOLS.has(toolName)) {
        const isConsulta = this.isGlobalConsulta(plantAccessMap);
        if (isConsulta) {
          let plantName = 'la planta';
          for (const [plantId] of plantAccessMap) {
            const co = await this.prisma.company.findUnique({ where: { id: plantId }, select: { name: true } });
            if (co?.name) { plantName = co.name; break; }
          }
          const blocked = JSON.stringify({ blocked: true, message: `Esta accion la gestiona ${plantName}. Contactalos directamente.` });
          if (toolTrace) {
            try {
              await toolTrace.end({ status: 'blocked', toolName, blocked: true });
              await toolTrace.patchRun();
            } catch {}
          }
          return blocked;
        }
      }

      // Track search filters
      if (SEARCH_TOOLS.has(toolName) && session?.id) {
        const filterParts: string[] = [];
        if (input.status) filterParts.push(`estado=${input.status}`);
        if (input.grain) filterParts.push(`grano=${input.grain}`);
        if (filterParts.length > 0) {
          this.sessionManager.updateActiveContext(session.id, { lastSearchFilter: filterParts.join(', ') });
        }
      }

      const result = await this.dispatch(toolName, input, user, synUser, session);

      // Strip action buttons for CONSULTA users
      if (plantAccessMap && this.isGlobalConsulta(plantAccessMap) && session?.id) {
        if (['get_freight_detail', 'list_freights'].includes(toolName)) {
          const effects = this.sessionManager.getSideEffects(session.id);
          if (effects?._pendingSelection) delete effects._pendingSelection;
          if (effects?._pendingButtons) delete effects._pendingButtons;
          this.sessionManager.setSideEffects(session.id, effects);
        }
      }

      // Track completed actions
      if (ACTION_TOOLS.has(toolName) && session?.id) {
        this.sessionManager.updateActiveContext(session.id, { lastAction: `${toolName}${input.code ? ` (${input.code})` : ''}` });
      }

      if (toolTrace) {
        try {
          await toolTrace.end({
            status: 'ok',
            toolName,
            resultChars: (result || '').length,
            resultPreview: (result || '').slice(0, 600),
          });
          await toolTrace.patchRun();
        } catch {}
      }
      return result;
    } catch (e) {
      const errCode = classifyAiError(e);
      this.logger.error(`Tool ${toolName} error [code=${errCode}]: ${sanitizeErrorForLog((e as any)?.message)}`);
      if (toolTrace) {
        try {
          await toolTrace.end({ status: 'error', toolName, errorCode: errCode }, sanitizeErrorForLog(String((e as any)?.message || 'tool_error')));
          await toolTrace.patchRun();
        } catch {}
      }
      return sanitizeToolError(e);
    }
  }

  private isGlobalConsulta(plantAccessMap: Map<string, string>): boolean {
    if (plantAccessMap.size === 0) return false;
    for (const level of plantAccessMap.values()) {
      if (level !== 'READONLY') return false;
    }
    return true;
  }

  // ======================== TOOL DISPATCH (mirrors _executeToolInner) ========================

  private async dispatch(
    toolName: string,
    input: any,
    user: any,
    synUser: any,
    session: any,
  ): Promise<string> {
    // This is a direct port of the switch/case from the old ai.service.ts.
    // Each tool delegates to the appropriate NestJS service method.
    // The full handler logic from the 6 tool services is preserved exactly.

    switch (toolName) {
      // ---- Freight Queries ----
      case 'list_freights': {
        const result = await this.freights.findAll(synUser, { status: input.status, dateFrom: input.dateFrom, dateTo: input.dateTo, grain: input.grain, limit: 50, page: 1 } as any);
        const filtered = result.data.sort((a: any, b: any) => (a.destName || '').localeCompare(b.destName || '') || (a.originName || '').localeCompare(b.originName || ''));
        if (filtered.length === 0) return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan con los filtros.' });
        const enriched = filtered.map((f: any) => ({ ...f, statusShort: FREIGHT_STATUS_SHORT[f.status] || f.status }));
        const items = buildFreightSelectionItems(enriched);
        const statusLabel = input.status ? ` (${FREIGHT_STATUS_SHORT[input.status] || input.status})` : '';
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: `${filtered.length} flete${filtered.length !== 1 ? 's' : ''}${statusLabel}.\nSeleccione uno:`, listButtonLabel: 'Ver fletes', sectionTitle: 'FLETES' }, 'freight_selection');
      }

      case 'get_freight_detail': {
        const accessResult = await this.resolveFreightWithAccess(input.code, user);
        if (accessResult.error) return JSON.stringify({ error: accessResult.error });
        const freight = await this.prisma.freight.findUnique({
          where: { id: accessResult.freight.id },
          include: {
            items: true,
            originCompany: { select: { id: true, name: true } },
            destCompany: { select: { id: true, name: true } },
            assignments: { where: { status: { in: ['active', 'accepted'] } }, include: { transportCompany: { select: { id: true, name: true } }, driver: { select: { name: true } }, truck: { select: { plate: true } } } },
          },
        });
        if (!freight) return JSON.stringify({ error: `No se encontro el flete ${input.code}` });
        const assignment = freight.assignments[0];
        const originName = (freight as any).originName || freight.originCompany?.name || 'N/A';
        const destName = (freight as any).destName || freight.destCompany?.name || 'N/A';
        const grain = freight.items[0]?.grain || '';
        const tons = freight.items[0]?.tons || '';
        if (session?.id) {
          this.sessionManager.updateActiveContext(session.id, { lastFreightId: freight.id, lastFreightCode: freight.code, lastFreightSummary: `${grain} ${tons}tn, ${originName} -> ${destName}, ${freight.status}` });
        }
        return JSON.stringify({
          code: freight.code, status: freight.status,
          items: freight.items.map((i: any) => ({ grain: i.grain, tons: i.tons })),
          origin: originName, dest: destName,
          date: freight.loadDate ? new Date(freight.loadDate).toISOString().split('T')[0] : null,
          transporter: assignment?.transportCompany?.name || 'Sin asignar',
          driver: assignment?.driver?.name || null,
          truck: assignment?.truck?.plate || null,
          truckCount: (freight as any).truckCount || 1,
          assignments: freight.assignments.map((a: any) => ({ id: a.id, tripNumber: a.tripNumber || null, transporter: a.transportCompany?.name || null, driver: a.driver?.name || null, truck: a.truck?.plate || null, tripStatus: a.tripStatus || null })),
          link: `${APP_URL}/freight/${freight.id}`,
        });
      }

      case 'summarize_freights': {
        const result = await this.freights.findAll(synUser, { status: input.status, dateFrom: input.dateFrom, dateTo: input.dateTo, grain: input.grain, limit: 100, page: 1 } as any);
        if (result.data.length === 0) return JSON.stringify({ total: 0, message: 'No hay fletes que coincidan.' });
        const freightsList = result.data.map((f: any) => ({
          code: f.code, status: FREIGHT_STATUS_LABELS[f.status] || f.status,
          grain: f.items?.[0]?.grain || 'N/A', tons: f.items?.[0]?.tons || 0,
          origin: (f as any).originName || f.originCompany?.name || 'N/A',
          destination: (f as any).destName || f.destCompany?.name || 'N/A',
          transporter: f.assignments?.[0]?.transportCompany?.name || 'Sin asignar',
          date: f.loadDate ? new Date(f.loadDate).toISOString().split('T')[0] : null,
        }));
        if (input.groupBy) {
          const groups: Record<string, any[]> = {};
          for (const f of freightsList) {
            const gk = f[input.groupBy] || 'Sin dato';
            if (!groups[gk]) groups[gk] = [];
            groups[gk].push(f);
          }
          const summary = Object.entries(groups).map(([group, items]) => ({
            group, count: items.length,
            totalTons: Math.round(items.reduce((s, f) => s + (f.tons || 0), 0) * 10) / 10,
            freights: items,
          }));
          return JSON.stringify({ total: freightsList.length, groupedBy: input.groupBy, groups: summary });
        }
        return JSON.stringify({ total: freightsList.length, freights: freightsList });
      }

      case 'get_dashboard': {
        const companyId = user.activeCompanyId || user.companyId;
        if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
        const memberCompanyIds = (user.memberships || []).map((m: any) => m.companyId);
        const allCompanies = [companyId, ...memberCompanyIds].filter(Boolean);
        const where: any = { OR: [{ originCompanyId: { in: allCompanies } }, { destCompanyId: { in: allCompanies } }, { assignments: { some: { transportCompanyId: { in: allCompanies }, status: { in: ['active', 'accepted'] } } } }] };
        const byStatus = await this.prisma.freight.groupBy({ by: ['status'], where, _count: true });
        const statusSummary = byStatus.map((s: any) => ({ status: FREIGHT_STATUS_LABELS[s.status] || s.status, count: s._count }));
        const totalActive = byStatus.filter((s: any) => !['finished', 'canceled', 'rejected'].includes(s.status)).reduce((sum: number, s: any) => sum + s._count, 0);
        return JSON.stringify({ activeFreights: totalActive, byStatus: statusSummary });
      }

      case 'freight_history': {
        const accessResult = await this.resolveFreightWithAccess(input.code, user);
        if (accessResult.error) return JSON.stringify({ error: accessResult.error });
        const logs = await this.freights.getAuditLog(accessResult.freight.id);
        if (!logs || (logs as any[]).length === 0) return JSON.stringify({ total: 0, message: `No hay registros para ${accessResult.freight.code}.` });
        const events = (logs as any[]).map((log: any) => ({ action: log.action, from: log.fromValue, to: log.toValue, user: log.user?.name || 'Sistema', date: new Date(log.createdAt).toISOString().replace('T', ' ').slice(0, 16) }));
        return JSON.stringify({ total: events.length, code: accessResult.freight.code, events });
      }

      case 'list_documents': {
        const accessResult = await this.resolveFreightWithAccess(input.code, user);
        if (accessResult.error) return JSON.stringify({ error: accessResult.error });
        const freight = await this.prisma.freight.findUnique({ where: { id: accessResult.freight.id }, include: { documents: { orderBy: { createdAt: 'desc' }, select: { id: true, name: true, type: true, step: true, createdAt: true } } } });
        if (!freight || !freight.documents?.length) return JSON.stringify({ total: 0, message: `No hay documentos en ${input.code}.` });
        return JSON.stringify({ total: freight.documents.length, code: input.code, documents: freight.documents.map((d: any) => ({ name: d.name, type: d.type, step: d.step, date: new Date(d.createdAt).toISOString().split('T')[0] })) });
      }

      // ---- Freight Actions (mutations) ----
      case 'prepare_freight':
      case 'confirm_create_freight':
      case 'confirm_action':
      case 'accept_freight':
      case 'reject_freight':
      case 'start_freight':
      case 'confirm_loaded':
      case 'confirm_finished':
      case 'cancel_freight':
      case 'update_freight':
      case 'duplicate_freight':
      case 'authorize_freight':
      case 'approve_pending_change':
      case 'reject_pending_change':
      case 'respond_trip':
      case 'start_trip':
      case 'confirm_trip_loaded':
      case 'confirm_trip_finished':
      case 'create_field':
      case 'create_lot':
      case 'update_field':
      case 'update_lot':
      case 'attach_document':
      case 'delete_document':
      case 'save_ocr_data':
      case 'ocr_analyze':
      case 'reactivate_user':
      case 'prepare_autonomous_freight':
      case 'finish_autonomous_freight':
      case 'register_plant_arrival':
        return await this.executeFreightAction(toolName, input, user, synUser, session);

      // ---- Transport & Assignment ----
      case 'list_trucks':
      case 'create_truck':
      case 'list_transporters':
      case 'assign_transporter':
      case 'assign_truck_to_trip':
      case 'assign_truck_to_freight':
      case 'list_drivers':
      case 'cancel_assignment':
      case 'update_assignment':
      case 'create_driver':
      case 'deactivate_truck':
      case 'update_truck':
      case 'deactivate_driver':
      case 'assign_multi_trucks':
      case 'view_driver_queue':
      case 'reorder_driver_queue':
      case 'assign_external_truck':
      case 'assign_mixed_trucks':
      case 'edit_external_assignment':
        return await this.executeTransportTool(toolName, input, user, synUser, session);

      // ---- Admin & User Management ----
      case 'get_user_profile':
      case 'create_user':
      case 'list_company_users':
      case 'update_user_role':
      case 'deactivate_user':
      case 'switch_company':
      case 'update_profile':
      case 'update_user_admin':
      case 'update_company':
      case 'list_enabled_plants':
      case 'list_enabled_producers':
      case 'grant_producer_access':
      case 'revoke_producer_access':
      case 'list_branches':
      case 'create_branch':
      case 'update_branch':
      case 'delete_branch':
      case 'get_assignment_suggestions':
        return await this.executeAdminTool(toolName, input, user, synUser, session);

      // ---- Location & Maps ----
      case 'generate_location_link':
      case 'generate_tracking_link':
      case 'generate_map_link':
      case 'generate_report_link':
      case 'generate_shared_link':
      case 'generate_daily_map_link':
      case 'generate_batch_report_link':
      case 'share_live_location':
      case 'view_live_locations':
      case 'request_location':
      case 'navigate_app':
      case 'generate_share_link_with_details':
      case 'rename_document':
        return await this.executeLocationTool(toolName, input, user, synUser, session);

      // ---- Search shortcuts ----
      case 'list_fields':
      case 'list_lots':
      case 'search_plants':
      case 'search_fields':
      case 'search_lots':
        return await this.executeSearchTool(toolName, input, user, session);

      // ---- Fleet economics ----
      case 'get_truck_detail': case 'get_truck_documents': case 'get_expiring_documents':
      case 'attach_truck_document':
      case 'register_truck_expense': case 'list_truck_expenses':
      case 'register_truck_income': case 'list_truck_incomes':
      case 'register_truck_movement': case 'list_truck_movements':
      case 'register_trip_data': case 'get_truck_economic_summary':
      case 'get_fleet_summary': case 'get_fleet_alerts':
        return await this.executeFleetTool(toolName, input, user, session);

      default:
        return JSON.stringify({ error: 'Herramienta no reconocida' });
    }
  }

  // ======================== HANDLER GROUPS ========================
  // These are simplified dispatchers. The full business logic from the backup
  // tool services is preserved in the key methods. For brevity, complex tools
  // like prepare_freight delegate to dedicated private methods.

  private async executeFreightAction(toolName: string, input: any, user: any, synUser: any, session: any): Promise<string> {
    switch (toolName) {
      case 'accept_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'accept_freight', { freightId: r.freight.id, code: r.freight.code }, `Aceptar flete ${r.freight.code}`);
      }
      case 'reject_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'reject_freight', { freightId: r.freight.id, code: r.freight.code, reason: input.reason }, `Rechazar flete ${r.freight.code}`);
      }
      case 'start_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'start_freight', { freightId: r.freight.id, code: r.freight.code }, `Iniciar viaje del flete ${r.freight.code}`);
      }
      case 'confirm_loaded': {
        const tons = Number(input.tons);
        if (input.tons == null || isNaN(tons) || tons <= 0) return JSON.stringify({ error: 'Toneladas requeridas y deben ser positivas.' });
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'confirm_loaded', { freightId: r.freight.id, code: r.freight.code, tons }, `Confirmar carga ${r.freight.code} ${tons} tn`);
      }
      case 'confirm_finished': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'confirm_finished', { freightId: r.freight.id, code: r.freight.code }, `Confirmar entrega ${r.freight.code}`);
      }
      case 'cancel_freight': {
        if (!input.code || String(input.code).trim().length < 3) {
          return JSON.stringify({ error: 'Para cancelar necesito el codigo exacto del flete (ej: F26-ABC.1234).' });
        }
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        this.logger.log(`[resolve] tool=cancel_freight user=${user.id || user.sub} requestedCode=${String(input.code).toUpperCase()} resolvedCode=${r.freight.code}`);
        return this.sessionManager.stageAction(session.id, 'cancel_freight', { freightId: r.freight.id, code: r.freight.code, reason: input.reason }, `Cancelar flete ${r.freight.code}`);
      }
      case 'authorize_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'authorize_freight', { freightId: r.freight.id, code: r.freight.code }, `Autorizar flete ${r.freight.code}`);
      }

      case 'confirm_action':
        return await this.executeConfirmAction(user, synUser, session, input);

      case 'confirm_create_freight':
        return await this.executeConfirmCreateFreight(user, synUser, session, input);

      case 'prepare_freight':
        return await this.executePrepareFreight(input, user, session);

      case 'update_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const dto: any = {};
        const changes: string[] = [];
        if (input.loadDate) { dto.loadDate = input.loadDate; changes.push(`Fecha: ${input.loadDate}`); }
        if (input.loadTime) { dto.loadTime = input.loadTime; changes.push(`Hora: ${input.loadTime}`); }
        if (input.notes !== undefined) { dto.notes = input.notes; changes.push(`Notas: ${input.notes}`); }
        if (input.truckCount !== undefined) { dto.truckCount = Number(input.truckCount); changes.push(`Camiones: ${input.truckCount}`); }
        if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron campos a modificar.' });
        return this.sessionManager.stageAction(session.id, 'update_freight', { freightId: r.freight.id, code: r.freight.code, dto }, `Modificar flete ${r.freight.code}\n${changes.join('\n')}`, user);
      }

      case 'duplicate_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const freight = await this.prisma.freight.findUnique({ where: { id: r.freight.id }, include: { items: true, originCompany: { select: { id: true, name: true } }, destCompany: { select: { id: true, name: true } } } });
        if (!freight) return JSON.stringify({ error: `No se encontro ${input.code}` });
        const item = freight.items?.[0];
        if (!item) return JSON.stringify({ error: 'El flete no tiene items.' });
        return this.sessionManager.stageAction(session.id, 'duplicate_freight', {
          originalFreight: { grain: (item as any).grain, tons: (item as any).tons, originLotId: (freight as any).originLotId, destPlantId: (freight as any).destPlantId, destCompanyId: freight.destCompany?.id, truckCount: (freight as any).truckCount || 1 },
          loadDate: input.loadDate, loadTime: input.loadTime, originalCode: freight.code, _sessionCompanyId: user.activeCompanyId || user.companyId,
        }, `Duplicar flete ${freight.code} -> ${input.loadDate}`);
      }

      case 'respond_trip': case 'start_trip': case 'confirm_trip_loaded': case 'confirm_trip_finished': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const assignmentId = input.assignmentId || r.freight.assignments?.[0]?.id;
        if (!assignmentId) return JSON.stringify({ error: 'No hay asignaciones activas.' });
        const actionMap: Record<string, string> = { respond_trip: 'respond_trip', start_trip: 'start_trip', confirm_trip_loaded: 'confirm_trip_loaded', confirm_trip_finished: 'confirm_trip_finished' };
        return this.sessionManager.stageAction(session.id, actionMap[toolName], { freightId: r.freight.id, code: r.freight.code, assignmentId, action: input.action, reason: input.reason, loadedTons: input.loadedTons }, `${toolName} para ${r.freight.code}`);
      }

      case 'approve_pending_change': case 'reject_pending_change': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, toolName, { freightId: r.freight.id, code: r.freight.code, changeId: input.changeId, reason: input.reason }, `${toolName === 'approve_pending_change' ? 'Aprobar' : 'Rechazar'} cambio en ${r.freight.code}`);
      }

      case 'create_field': {
        const producerCompanyId = this.resolveProducerCompanyId(user);
        const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };
        if (input.lat == null || input.lng == null) return JSON.stringify({ error: 'La ubicacion es obligatoria. Use generate_location_link.' });
        return this.sessionManager.stageAction(session.id, 'create_field', { producerSynUser, dto: { name: input.name, address: input.address, lat: input.lat, lng: input.lng } }, `Crear campo "${input.name}"`);
      }

      case 'create_lot': {
        const producerCompanyId = this.resolveProducerCompanyId(user);
        const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };
        if (input.lat == null || input.lng == null) return JSON.stringify({ error: 'La ubicacion es obligatoria. Use generate_location_link.' });
        return this.sessionManager.stageAction(session.id, 'create_lot', { producerSynUser, fieldId: input.fieldId, dto: { name: input.name, hectares: input.hectares, lat: input.lat, lng: input.lng } }, `Crear lote "${input.name}"`);
      }

      case 'update_field': case 'update_lot':
        return JSON.stringify({ error: 'Use la plataforma web para editar campos y lotes.' });

      case 'attach_document': {
        if (!input.code || String(input.code).trim().length < 3) {
          return JSON.stringify({ error: 'Para adjuntar necesito el codigo exacto del flete.' });
        }
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const pendingDoc = this.sessionManager.getSideEffects(session.id)?.pendingDocument || (session.flowState as any)?.pendingDocument;
        if (!pendingDoc?.url) return JSON.stringify({ error: 'No hay archivo pendiente.' });
        this.logger.log(`[resolve] tool=attach_document user=${user.id || user.sub} requestedCode=${String(input.code).toUpperCase()} resolvedCode=${r.freight.code}`);
        return this.sessionManager.stageAction(session.id, 'attach_document', { freightId: r.freight.id, code: r.freight.code, document: pendingDoc, step: input.step }, `Adjuntar "${pendingDoc.name}" a ${r.freight.code}`);
      }

      case 'delete_document': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'delete_document', { freightId: r.freight.id, code: r.freight.code, documentId: input.documentId, docName: 'documento' }, `Eliminar documento de ${r.freight.code}`);
      }

      case 'save_ocr_data':
        return this.sessionManager.stageAction(session.id, 'save_ocr_data', { code: input.code, documentId: input.documentId, ocrData: input.ocrData, docName: 'documento' }, `Guardar datos OCR en ${input.code}`);

      case 'ocr_analyze': {
        const result = await this.ocrService.analyze(input.url, input.docType || 'general');
        return JSON.stringify(result);
      }

      case 'reactivate_user': {
        const companyId = user.activeCompanyId || user.companyId;
        if (!this.isCallerAdminForCompany(user, companyId)) return JSON.stringify({ error: 'Solo admin puede reactivar.' });
        const membership = await this.prisma.userCompany.findFirst({ where: { companyId, active: false, user: { OR: [{ name: { contains: input.userIdentifier, mode: 'insensitive' } }, { email: { equals: input.userIdentifier, mode: 'insensitive' } }] } }, include: { user: { select: { id: true, name: true } } } });
        if (!membership) return JSON.stringify({ error: `No se encontro usuario inactivo "${input.userIdentifier}".` });
        return this.sessionManager.stageAction(session.id, 'reactivate_user', { membershipId: membership.id, targetUserId: membership.user.id, userName: membership.user.name }, `Reactivar "${membership.user.name}"`);
      }

      // ---- Autonomous Driver Tools ----
      case 'prepare_autonomous_freight':
        return await this.executePrepareAutonomousFreight(input, user, session);

      case 'finish_autonomous_freight': {
        let freight: any;
        if (input.code) {
          const r = await this.resolveFreightWithAccess(input.code, user);
          if (r.error) return JSON.stringify({ error: r.error });
          freight = r.freight;
        } else {
          // Auto-detect: find the user's most recent active autonomous freight
          freight = await this.prisma.freight.findFirst({
            where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
            select: { id: true, code: true, status: true, isAutonomous: true, requestedById: true },
            orderBy: { createdAt: 'desc' },
          });
          if (!freight) return JSON.stringify({ error: 'No tenés fletes autónomos activos para finalizar.' });
        }
        if (!freight.isAutonomous) return JSON.stringify({ error: 'Este flete no es autonomo.' });
        const weightKg = input.destinationWeightKg ? Number(input.destinationWeightKg) : undefined;
        return this.sessionManager.stageAction(session.id, 'finish_autonomous_freight', {
          freightId: freight.id, code: freight.code, destinationWeightKg: weightKg, notes: input.notes,
        }, `Finalizar flete autonomo ${freight.code}${weightKg ? ` (${weightKg} kg)` : ''}`);
      }

      case 'register_plant_arrival': {
        let freight: any;
        if (input.code) {
          const r = await this.resolveFreightWithAccess(input.code, user);
          if (r.error) return JSON.stringify({ error: r.error });
          freight = r.freight;
        } else {
          freight = await this.prisma.freight.findFirst({
            where: { requestedById: user.sub || user.id, isAutonomous: true, status: 'loaded' },
            select: { id: true, code: true, status: true, isAutonomous: true, requestedById: true },
            orderBy: { createdAt: 'desc' },
          });
          if (!freight) return JSON.stringify({ error: 'No tenés fletes autónomos activos.' });
        }
        if (!freight.isAutonomous) return JSON.stringify({ error: 'Este flete no es autonomo.' });
        return this.sessionManager.stageAction(session.id, 'register_plant_arrival', {
          freightId: freight.id, code: freight.code,
        }, `Registrar llegada a planta del flete ${freight.code}`);
      }

      default:
        return JSON.stringify({ error: 'Accion no reconocida.' });
    }
  }

  // ---- prepare_freight (simplified — preserves core logic) ----
  private async executePrepareFreight(input: any, user: any, session: any): Promise<string> {
    if (!input.grain) return JSON.stringify({ error: 'Falta el grano. Indicar: Soja, Maiz, Trigo, Girasol, Sorgo, Cebada u Otros.' });
    if (!input.loadDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.loadDate)) return JSON.stringify({ error: 'Falta fecha de carga (loadDate) en formato YYYY-MM-DD.' });
    const todayUY = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS).toISOString().split('T')[0];
    if (input.loadDate < todayUY) return JSON.stringify({ error: `La fecha ${input.loadDate} ya paso.` });
    if (!input.loadTime) input.loadTime = '08:00';
    if (!input.truckCount || isNaN(Number(input.truckCount)) || Number(input.truckCount) < 1) {
      const tons = Number(input.tons);
      if (tons > 0) input.truckCount = Math.ceil(tons / 30);
      else return JSON.stringify({ error: 'Falta cantidad de camiones (truckCount).' });
    }
    const hasDestination = !!(input.branchId || input.destPlantId || input.destName || input.customDestName);
    if (!hasDestination) {
      return JSON.stringify({ error: 'Falta destino. Indique planta destino o destino personalizado.' });
    }
    const ownFleetValidationError = await this.ensureOwnFleetSelectionForPrepare(input, user);
    if (ownFleetValidationError) return JSON.stringify({ error: ownFleetValidationError });
    const destResolutionError = await this.resolvePendingDestination(input, user);
    if (destResolutionError) return JSON.stringify({ error: destResolutionError });

    const effects = this.sessionManager.getSideEffects(session.id);
    const prepareCompanyId = user.activeCompanyId || user.companyId;
    const freightActionId = crypto.randomUUID().slice(0, 8);
    effects.pendingFreight = { ...input, truckCount: Number(input.truckCount), _sessionCompanyId: prepareCompanyId, actionId: freightActionId };
    effects._pendingButtons = [{ id: `ai_confirm_freight:${freightActionId}`, title: 'CONFIRMAR' }, { id: `ai_cancel_freight:${freightActionId}`, title: 'CANCELAR' }];
    effects._ts = effects._ts || Date.now();
    this.sessionManager.setSideEffects(session.id, effects);

    return JSON.stringify({
      status: 'pending_confirmation',
      summary: { grain: input.grain, tons: input.tons, truckCount: Number(input.truckCount), origin: input.originName || input.originLotId || 'Sin definir', dest: input.destName || input.destPlantId || 'Sin definir', date: input.loadDate, time: input.loadTime },
      IMPORTANT: 'El flete NO fue creado todavia. Mostra el resumen y pregunta al usuario si confirma.',
    });
  }

  private async ensureOwnFleetSelectionForPrepare(input: any, user: any): Promise<string | null> {
    if (!input?.useOwnFleet) return null;

    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return null;

    const ownTrucks = await this.prisma.truck.findMany({
      where: { companyId: producerCompanyId, active: true },
      select: { id: true, plate: true },
      orderBy: { plate: 'asc' },
      take: 100,
    });
    if (!ownTrucks.length) {
      return 'Indicó flota propia, pero no hay camiones activos en su empresa.';
    }

    const hasOwnTruckInArray = Array.isArray(input?.trucks) && input.trucks.some((t: any) => t && !t.isExternal && !!t.truckId);
    const hasOwnDriverInArray = Array.isArray(input?.trucks) && input.trucks.some((t: any) => t && !t.isExternal && !!t.driverId);
    const hasOwnTruckSelected = !!(input?.truckId || input?.ownTruckId || hasOwnTruckInArray);
    const hasOwnDriverSelected = !!(input?.driverId || input?.ownDriverId || hasOwnDriverInArray);

    if (ownTrucks.length === 1) {
      if (!hasOwnTruckSelected) input.truckId = ownTrucks[0].id;
      if (!hasOwnDriverSelected) input.driverId = 'self';
      return null;
    }

    if (hasOwnTruckSelected && hasOwnDriverSelected) return null;

    const drivers = await this.prisma.userCompany.findMany({
      where: { companyId: producerCompanyId, active: true, role: 'chofer' },
      select: { userId: true, user: { select: { name: true, phone: true } } },
      orderBy: { createdAt: 'asc' },
      take: 100,
    });

    const truckOptions = ownTrucks.slice(0, 12).map((t: any) => `- ${t.plate || 'SIN PATENTE'}`).join('\n');
    const driverOptions = [
      `1) Yo (${user?.name || 'solicitante'})`,
      ...drivers.slice(0, 12).map((d: any, idx: number) => `${idx + 2}) ${d.user?.name || 'Sin nombre'}${d.user?.phone ? ` (${d.user.phone})` : ''}`),
    ].join('\n');

    return [
      'Para flota propia necesito que indique camión y chofer antes de confirmar.',
      'Camiones disponibles:',
      truckOptions || '- (sin datos)',
      'Choferes disponibles:',
      driverOptions,
      'Responda indicando: patente + chofer.',
    ].join('\n');
  }

  private async resolvePendingDestination(input: any, user: any): Promise<string | null> {
    // Keep explicit custom destinations as-is.
    if (input.customDestName) return null;

    // If branch is explicit, trust it.
    if (input.branchId) return null;

    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return null;

    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      select: { plantCompanyId: true },
      take: 500,
    });
    const plantCompanyIds = accesses.map((a) => a.plantCompanyId);
    if (!plantCompanyIds.length) return null;

    const companies = await this.prisma.company.findMany({
      where: { id: { in: plantCompanyIds }, active: true },
      select: {
        id: true,
        name: true,
        plants: { where: { active: true }, select: { id: true, name: true } },
      },
      take: 100,
    });

    const applyCompanySelection = async (company: any): Promise<string | null> => {
      const branches = company?.plants || [];
      if (branches.length === 1) {
        input.branchId = branches[0].id;
        input.destPlantId = company.id;
        input.destName = company.name;
        return null;
      }
      if (branches.length > 1) {
        // Try infer branch from destName if user wrote it.
        if (input.destName) {
          const branchMatches = fuzzySearch(String(input.destName), branches, (b: any) => b.name, { threshold: 0.45, maxResults: 5, aliases: ENTITY_ALIASES });
          const branchClass = classifyFuzzyResult(branchMatches);
          if ((branchClass === 'exact' || branchClass === 'confident') && branchMatches[0]) {
            input.branchId = branchMatches[0].item.id;
            input.destPlantId = company.id;
            input.destName = company.name;
            return null;
          }
        }
        return `La planta ${company.name} tiene varias sucursales. Indique la sucursal exacta.`;
      }
      // Company without plants: fallback to company-level destination.
      input.destPlantId = company.id;
      input.destName = company.name;
      return null;
    };

    // destPlantId can be either branchId or companyId.
    if (input.destPlantId) {
      const plant = await this.prisma.plant.findFirst({
        where: { id: input.destPlantId, active: true },
        select: { id: true, companyId: true, name: true, company: { select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } } } },
      });
      if (plant) {
        input.branchId = plant.id;
        input.destPlantId = plant.companyId;
        input.destName = plant.company?.name || input.destName;
        return null;
      }

      const company = companies.find((c: any) => c.id === input.destPlantId);
      if (company) return await applyCompanySelection(company);
      return 'No se encontro la planta destino indicada.';
    }

    if (input.destName) {
      const query = String(input.destName).trim();
      // 1) Match company names first.
      const companyMatches = fuzzySearch(query, companies, (c: any) => c.name, { threshold: 0.5, maxResults: 5, aliases: ENTITY_ALIASES });
      const companyClass = classifyFuzzyResult(companyMatches);
      if ((companyClass === 'exact' || companyClass === 'confident') && companyMatches[0]) {
        return await applyCompanySelection(companyMatches[0].item);
      }

      // 2) Match branch names across companies.
      const branchRows = companies.flatMap((c: any) => (c.plants || []).map((b: any) => ({ companyId: c.id, companyName: c.name, branchId: b.id, branchName: b.name })));
      const branchMatches = fuzzySearch(query, branchRows, (b: any) => b.branchName, { threshold: 0.5, maxResults: 5, aliases: ENTITY_ALIASES });
      const branchClass = classifyFuzzyResult(branchMatches);
      if ((branchClass === 'exact' || branchClass === 'confident') && branchMatches[0]) {
        const top = branchMatches[0].item;
        input.branchId = top.branchId;
        input.destPlantId = top.companyId;
        input.destName = top.companyName;
        return null;
      }

      if (companyClass === 'ambiguous' || branchClass === 'ambiguous') {
        return 'Destino ambiguo. Indique la planta o sucursal exacta.';
      }

      return 'No reconozco la planta destino. Indique el nombre exacto de la planta o sucursal habilitada.';
    }

    return null;
  }

  // ---- prepare_autonomous_freight ----
  private async executePrepareAutonomousFreight(input: any, user: any, session: any): Promise<string> {
    // Check for active autonomous freight BEFORE validation — auto-stage finalization
    const activeFreight = await this.prisma.freight.findFirst({
      where: { requestedById: user.sub || user.id, isAutonomous: true, status: { notIn: ['finished', 'canceled'] } },
      select: { id: true, code: true, destName: true, originFreeText: true, items: { select: { grain: true, tons: true }, take: 1 } },
      orderBy: { createdAt: 'desc' },
    });
    if (activeFreight) {
      const grain = activeFreight.items?.[0]?.grain || 'producto';
      const tons = activeFreight.items?.[0]?.tons ? `${activeFreight.items[0].tons} tn` : '';
      const dest = activeFreight.destName || activeFreight.originFreeText || '';
      // Stage finish action with custom buttons
      return this.sessionManager.stageAction(session.id, 'finish_autonomous_freight', {
        freightId: activeFreight.id, code: activeFreight.code,
      }, `Ya tenés un flete activo:\n📋 ${activeFreight.code}\n🌾 ${grain}${tons ? ` · ${tons}` : ''}\n🏭 ${dest}\n\n¿Querés finalizarlo para crear uno nuevo?`,
      undefined, { confirm: 'FINALIZAR VIAJE', cancel: 'CANCELAR VIAJE' });
    }

    if (!input.origin) return JSON.stringify({ error: 'Origen obligatorio. Preguntar al chofer de dónde sale.' });
    if (!input.destination) return JSON.stringify({ error: 'Destino obligatorio.' });
    if (!input.grain) return JSON.stringify({ error: 'Grano obligatorio.' });
    if (!input.weightKg || isNaN(Number(input.weightKg)) || Number(input.weightKg) <= 0) return JSON.stringify({ error: 'Peso obligatorio. Preguntar al chofer cuántos kilos o toneladas cargó.' });

    // Build summary for confirmation
    const origin = input.origin;
    const destination = input.destination;
    const grain = input.grain;
    const weightKg = Number(input.weightKg);
    const weightDisplay = `${weightKg} kg`;

    // Auto-detect truck
    const companyId = user.activeCompanyId || user.companyId;
    let truckInfo = '';
    let truckId = input.truckId || null;
    if (!truckId) {
      const trucks = await this.prisma.truck.findMany({
        where: { companyId, active: true, assignedUserId: user.sub },
        select: { id: true, plate: true },
        take: 2,
      });
      if (trucks.length === 1) {
        truckId = trucks[0].id;
        truckInfo = trucks[0].plate;
      } else if (trucks.length === 0) {
        const anyTruck = await this.prisma.truck.findFirst({
          where: { companyId, active: true },
          select: { id: true, plate: true },
        });
        if (anyTruck) { truckId = anyTruck.id; truckInfo = anyTruck.plate; }
      } else {
        // Multiple trucks — ask user
        const list = trucks.map(t => t.plate).join(', ');
        return JSON.stringify({ error: `Tenes varios camiones: ${list}. ¿Con cual salis?` });
      }
    } else {
      const truck = await this.prisma.truck.findFirst({ where: { id: truckId, active: true }, select: { plate: true } });
      truckInfo = truck?.plate || 'desconocido';
    }

    const summary = `📋 Flete autónomo:\n🚛 Camión: ${truckInfo || 'auto-detectar'}\n📍 Origen: ${origin}\n🏭 Destino: ${destination}\n🌾 Grano: ${grain}\n⚖️ Peso: ${weightDisplay}`;

    return this.sessionManager.stageAction(session.id, 'create_autonomous_freight', {
      origin: input.origin, destination: input.destination, grain: input.grain,
      weightKg, notes: input.notes, truckId,
      fieldId: input.fieldId, originLotId: input.originLotId,
      destPlantId: input.destPlantId, branchId: input.branchId,
    }, summary, user);
  }

  // ---- confirm_create_freight ----
  private async executeConfirmCreateFreight(user: any, synUser: any, session: any, input?: any): Promise<string> {
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH old AS (SELECT "id", "flow_state" FROM "whatsapp_sessions" WHERE "id" = ${session.id} AND "flow_state" ? 'pendingFreight' FOR UPDATE)
      UPDATE "whatsapp_sessions" s SET "flow_state" = s."flow_state" #- '{pendingFreight}' #- '{_pendingButtons}' #- '{pendingDocument}' FROM old WHERE s."id" = old."id" RETURNING old."flow_state" AS "old_state"
    `;
    if (!rows.length) return JSON.stringify({ error: 'No hay un flete pendiente. Usa prepare_freight primero.' });
    const pending = rows[0].old_state?.pendingFreight;
    if (!pending) return JSON.stringify({ error: 'No hay un flete pendiente.' });
    if (input?.actionId && pending.actionId && String(input.actionId) !== String(pending.actionId)) {
      return JSON.stringify({ error: 'La confirmacion no coincide con la accion pendiente.' });
    }
    pending._lastUserText = this.extractLastUserText(rows[0].old_state?.aiMessages);

    const targetCompanyId = pending._sessionCompanyId || user.activeCompanyId;
    const producerCompanyId = targetCompanyId ? this.resolveProducerCompanyIdForCompany(user, targetCompanyId) : this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se encontro empresa productora.' });
    const producerSynUser = { ...synUser, companyId: producerCompanyId, companyType: 'producer', userType: 'producer' };
    const actorUserId = producerSynUser.sub || user.sub || user.id;

    const dto: any = { items: [{ grain: pending.grain, tons: pending.tons }], loadDate: pending.loadDate, loadTime: pending.loadTime, truckCount: pending.truckCount || 1, notes: pending.notes };
    if (pending.useOwnFleet !== undefined) dto.useOwnFleet = !!pending.useOwnFleet;
    if (pending.branchId) dto.destPlantId = pending.branchId;
    else if (pending.destPlantId) dto.destPlantId = pending.destPlantId;
    else if (pending.destName) dto.customDestName = pending.destName;
    await this.applyPendingOriginToCreateDto(dto, pending, producerCompanyId);
    if (pending.truckId) dto.truckId = pending.truckId;
    const normalizedDriverId = this.normalizePendingDriverId(pending.driverId, actorUserId);
    if (normalizedDriverId) dto.driverId = normalizedDriverId;

    const freight = await this.freights.create(dto, producerSynUser);
    const assignmentResult = await this.autoAssignPendingFreightTrucks(
      (freight as any).id,
      pending,
      producerSynUser,
      producerCompanyId,
      actorUserId,
    );
    return JSON.stringify({
      status: 'created',
      code: (freight as any).code,
      link: `${APP_URL}/freight/${(freight as any).id}`,
      assignment: assignmentResult,
    });
  }

  private extractLastUserText(aiMessages: any): string | null {
    if (!Array.isArray(aiMessages)) return null;
    for (let i = aiMessages.length - 1; i >= 0; i--) {
      const msg = aiMessages[i];
      if (msg?.role !== 'user') continue;
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      const text = parts
        .map((p: any) => (typeof p?.text === 'string' ? p.text.trim() : ''))
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }
    return null;
  }

  private normalizePendingDriverId(driverId: any, actorUserId: string | null): string | null {
    if (!driverId) return null;
    if (typeof driverId === 'string' && ['self', 'me', 'yo'].includes(driverId.trim().toLowerCase())) {
      return actorUserId || null;
    }
    return typeof driverId === 'string' ? driverId : null;
  }

  private async applyPendingOriginToCreateDto(dto: any, pending: any, producerCompanyId: string): Promise<void> {
    if (pending?.originLotId) {
      dto.originLotId = pending.originLotId;
      return;
    }

    const latRaw = pending?.customOriginLat ?? pending?.originLat ?? pending?.overrideOriginLat;
    const lngRaw = pending?.customOriginLng ?? pending?.originLng ?? pending?.overrideOriginLng;
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    if (hasCoords) {
      dto.overrideOriginLat = lat;
      dto.overrideOriginLng = lng;
      if (pending?.customOriginName || pending?.originName) {
        dto.customOriginName = pending.customOriginName || pending.originName;
      }
      return;
    }

    const originName = String(pending?.originName || pending?.customOriginName || '').trim();
    if (!originName) return;

    // Resolve to producer lots first (more specific than field).
    const lots = await this.prisma.lot.findMany({
      where: { companyId: producerCompanyId, active: true },
      select: { id: true, name: true },
      take: 300,
    });
    if (lots.length > 0) {
      const lotMatches = fuzzySearch(originName, lots, (l) => l.name, { threshold: 0.45, maxResults: 5, aliases: ENTITY_ALIASES });
      if (lotMatches.length > 0) {
        const lotDecision = classifyFuzzyResult(lotMatches);
        if (lotDecision === 'exact' || lotDecision === 'confident') {
          dto.originLotId = lotMatches[0].item.id;
          return;
        }
      }
    }

    // Fallback to field coordinates / fieldId.
    const fields = await this.prisma.field.findMany({
      where: { companyId: producerCompanyId, active: true },
      select: { id: true, name: true, lat: true, lng: true },
      take: 300,
    });
    if (fields.length > 0) {
      const fieldMatches = fuzzySearch(originName, fields, (f) => f.name, { threshold: 0.45, maxResults: 5, aliases: ENTITY_ALIASES });
      if (fieldMatches.length > 0) {
        const fieldDecision = classifyFuzzyResult(fieldMatches);
        if (fieldDecision === 'exact' || fieldDecision === 'confident') {
          dto.fieldId = fieldMatches[0].item.id;
          return;
        }
      }
    }

    // Last fallback: keep custom origin name (FreightsService will still need map coords/lot/field).
    dto.customOriginName = originName;
  }

  private normalizePlate(value: any): string | null {
    if (!value || typeof value !== 'string') return null;
    const normalized = value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
    return normalized || null;
  }

  private extractExternalPlateFromText(pending: any): string | null {
    const haystack = [
      pending?.notes,
      pending?.rawText,
      pending?.message,
      pending?.summary,
      pending?._lastUserText,
      pending?.originName,
      pending?.destName,
    ].filter(Boolean).join(' ');
    const match = haystack.match(/\b[A-Z]{3}\d{3,4}\b/i);
    return match ? this.normalizePlate(match[0]) : null;
  }

  private buildPendingTextHaystack(pending: any): string {
    return [
      pending?.notes,
      pending?.rawText,
      pending?.message,
      pending?.summary,
      pending?._lastUserText,
      pending?.originName,
      pending?.destName,
    ].filter(Boolean).join(' ').toLowerCase();
  }

  private async autoAssignPendingFreightTrucks(
    freightId: string,
    pending: any,
    actionUser: any,
    producerCompanyId: string,
    actorUserId: string | null,
  ): Promise<any> {
    const desiredTruckCount = Math.max(1, Number(pending?.truckCount || 1));
    const textHaystack = this.buildPendingTextHaystack(pending);
    const mentionsOwnFleet = /\b(mi\s+flota|flota\s+propia|propio|interno)\b/.test(textHaystack);
    const mentionsExternal = /\b(externo|tercero|de\s+afuera)\b/.test(textHaystack);
    const mentionsSelfDriver = /\b(yo\s+manejo|manejo\s+yo|lo\s+manejo|manejo)\b/.test(textHaystack);
    const freightState = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        id: true,
        code: true,
        assignedTruckCount: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { truckId: true, plate: true, isExternal: true },
        },
      },
    });
    const existingCount = Number(freightState?.assignedTruckCount || 0);
    const missingSlots = Math.max(0, desiredTruckCount - existingCount);
    if (!missingSlots) {
      return { requestedTruckCount: desiredTruckCount, alreadyAssigned: existingCount, assignedNow: 0, pendingSlots: 0, warnings: [] };
    }

    const existingTruckIds = new Set((freightState?.assignments || []).map((a: any) => a.truckId).filter(Boolean));
    const existingPlates = new Set((freightState?.assignments || []).map((a: any) => this.normalizePlate(a.plate)).filter(Boolean));
    const candidates: any[] = [];

    const addInternal = (truckId?: string, driverIdRaw?: string, transportCompanyId?: string) => {
      const driverId = this.normalizePendingDriverId(driverIdRaw, actorUserId);
      if (!truckId && !driverId) return;
      candidates.push({
        isExternal: false,
        truckId: truckId || undefined,
        driverId: driverId || undefined,
        transportCompanyId: transportCompanyId || producerCompanyId,
      });
    };
    const addExternal = (plateRaw?: string, externalCompanyName?: string, externalDriverName?: string) => {
      const plate = this.normalizePlate(plateRaw);
      if (!plate) return;
      candidates.push({
        isExternal: true,
        plate,
        externalCompanyName: externalCompanyName || undefined,
        externalDriverName: externalDriverName || undefined,
      });
    };

    addInternal(pending?.truckId, pending?.driverId, pending?.transportCompanyId);
    addInternal(pending?.ownTruckId, pending?.ownDriverId, pending?.ownTransportCompanyId);
    addExternal(pending?.externalPlate, pending?.externalCompanyName, pending?.externalDriverName);
    addExternal(pending?.externalTruckPlate, pending?.externalCompanyName, pending?.externalDriverName);

    if (Array.isArray(pending?.trucks)) {
      for (const t of pending.trucks) {
        if (!t || typeof t !== 'object') continue;
        if (t.isExternal || t.external === true) {
          addExternal(t.plate, t.externalCompanyName, t.externalDriverName);
        } else if (t.truckId || t.driverId || t.transportCompanyId) {
          addInternal(t.truckId, t.driverId, t.transportCompanyId);
        } else if (t.plate && (t.externalCompanyName || t.externalDriverName)) {
          addExternal(t.plate, t.externalCompanyName, t.externalDriverName);
        }
      }
    }

    const inferredExternalPlate = this.extractExternalPlateFromText(pending);
    if (inferredExternalPlate) {
      addExternal(inferredExternalPlate, pending?.externalCompanyName, pending?.externalDriverName);
    }

    // If user said "yo manejo" and there's exactly one truck linked to that driver, infer it.
    let currentDriverId = this.normalizePendingDriverId(pending?.driverId || pending?.ownDriverId, actorUserId);
    if (!currentDriverId && mentionsSelfDriver && actorUserId) currentDriverId = actorUserId;
    if (currentDriverId && !pending?.truckId && !pending?.ownTruckId) {
      const ownCandidates = await this.prisma.truck.findMany({
        where: { companyId: producerCompanyId, active: true, assignedUserId: currentDriverId },
        select: { id: true },
        take: 2,
      });
      if (ownCandidates.length === 1) addInternal(ownCandidates[0].id, currentDriverId, producerCompanyId);
    }

    const hasInternalCandidate = candidates.some((c: any) => !c.isExternal);
    if (mentionsOwnFleet && !hasInternalCandidate) {
      const fallbackOwn = await this.prisma.truck.findFirst({
        where: {
          companyId: producerCompanyId,
          active: true,
          ...(currentDriverId ? { OR: [{ assignedUserId: currentDriverId }, { assignedUserId: null }] } : {}),
        },
        select: { id: true, assignedUserId: true },
        orderBy: { createdAt: 'asc' },
      });
      if (fallbackOwn?.id) {
        addInternal(
          fallbackOwn.id,
          currentDriverId || fallbackOwn.assignedUserId || undefined,
          producerCompanyId,
        );
      }
    }

    const hasExternalCandidate = candidates.some((c: any) => !!c.isExternal);
    if (mentionsExternal && !hasExternalCandidate) {
      const inferredPlate = this.extractExternalPlateFromText(pending);
      if (inferredPlate) addExternal(inferredPlate, pending?.externalCompanyName, pending?.externalDriverName);
    }

    const uniqueCandidates = candidates.filter((c: any) => {
      if (c.isExternal) {
        const plate = this.normalizePlate(c.plate);
        if (!plate) return false;
        if (existingPlates.has(plate)) return false;
        existingPlates.add(plate);
        return true;
      }
      if (c.truckId) {
        if (existingTruckIds.has(c.truckId)) return false;
        existingTruckIds.add(c.truckId);
      }
      return true;
    });

    let assignedNow = 0;
    const warnings: string[] = [];
    for (const candidate of uniqueCandidates) {
      if (assignedNow >= missingSlots) break;
      try {
        await this.freights.assignTruck(freightId, candidate, actionUser);
        assignedNow += 1;
      } catch (e: any) {
        warnings.push(sanitizeConfirmError(e));
      }
    }

    const refreshed = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: { assignedTruckCount: true },
    });
    const totalAssigned = Number(refreshed?.assignedTruckCount || existingCount + assignedNow);
    const pendingSlots = Math.max(0, desiredTruckCount - totalAssigned);
    if (pendingSlots > 0 && warnings.length === 0) {
      warnings.push('No se pudo completar la asignacion de todos los camiones con la informacion disponible.');
    }

    return { requestedTruckCount: desiredTruckCount, alreadyAssigned: existingCount, assignedNow, totalAssigned, pendingSlots, warnings };
  }

  // ---- confirm_action (generic) ----
  private async executeConfirmAction(user: any, synUser: any, session: any, input?: any): Promise<string> {
    const rows = await this.prisma.$queryRaw<any[]>`
      WITH old AS (SELECT "id", "flow_state" FROM "whatsapp_sessions" WHERE "id" = ${session.id} AND "flow_state" ? 'pendingAction' FOR UPDATE)
      UPDATE "whatsapp_sessions" s SET "flow_state" = s."flow_state" #- '{pendingAction}' #- '{_pendingButtons}' #- '{pendingDocument}' FROM old WHERE s."id" = old."id" RETURNING old."flow_state" AS "old_state"
    `;
    if (!rows.length) return JSON.stringify({ error: 'No hay accion pendiente.' });
    const pending = rows[0].old_state?.pendingAction;
    if (!pending) return JSON.stringify({ error: 'No hay accion pendiente.' });
    if (pending.createdAt && Date.now() - pending.createdAt > 5 * 60_000) return JSON.stringify({ error: 'La accion expiro.' });
    if (input?.actionId && pending.actionId && String(input.actionId) !== String(pending.actionId)) {
      return JSON.stringify({ error: 'La confirmacion no coincide con la accion pendiente.' });
    }

    const preExecState = { ...rows[0].old_state };
    delete preExecState.pendingAction;
    delete preExecState._pendingButtons;
    delete preExecState.pendingDocument;
    const { tool, params } = pending;

    try {
      let result: string;
      this.logger.log(`[confirm_action] user=${user.id || user.sub} actionId=${pending.actionId || 'none'} tool=${tool} code=${params?.code || 'n/a'}`);
      switch (tool) {
        case 'accept_freight': await this.freights.respond(params.freightId, { action: 'accepted' } as any, synUser); result = JSON.stringify({ status: 'accepted', code: params.code }); break;
        case 'reject_freight': await this.freights.respond(params.freightId, { action: 'rejected', reason: params.reason } as any, synUser); result = JSON.stringify({ status: 'rejected', code: params.code }); break;
        case 'start_freight': await this.freights.start(params.freightId, synUser); result = JSON.stringify({ status: 'started', code: params.code }); break;
        case 'confirm_loaded': { const t = params.tons != null ? Number(params.tons) : undefined; await this.freights.confirmLoaded(params.freightId, synUser, t); result = JSON.stringify({ status: 'loaded', code: params.code }); break; }
        case 'confirm_finished': await this.freights.confirmFinished(params.freightId, synUser); result = JSON.stringify({ status: 'finished', code: params.code }); break;
        case 'cancel_freight': await this.freights.cancel(params.freightId, { reason: params.reason } as any, synUser); result = JSON.stringify({ status: 'canceled', code: params.code }); break;
        case 'authorize_freight': await this.freights.authorize(params.freightId, synUser); result = JSON.stringify({ status: 'authorized', code: params.code }); break;
        case 'update_freight': { const ur = await this.freights.updateFreight(params.freightId, params.dto, synUser); result = JSON.stringify({ status: 'updated', code: params.code }); break; }
        case 'duplicate_freight': {
          const orig = params.originalFreight;
          const pc = params._sessionCompanyId ? this.resolveProducerCompanyIdForCompany(user, params._sessionCompanyId) : this.resolveProducerCompanyId(user);
          const ps = { ...synUser, companyId: pc, companyType: 'producer', userType: 'producer' };
          const dto: any = { items: [{ grain: orig.grain, tons: orig.tons }], loadDate: params.loadDate, loadTime: params.loadTime, truckCount: orig.truckCount || 1, notes: orig.notes };
          if (orig.destPlantId) dto.destPlantId = orig.destPlantId;
          if (orig.originLotId) dto.originLotId = orig.originLotId;
          const nf = await this.freights.create(dto, ps);
          result = JSON.stringify({ status: 'duplicated', newCode: (nf as any).code }); break;
        }
        case 'create_field': { const f = await this.fieldsService.createField(params.producerSynUser, params.dto); result = JSON.stringify({ status: 'created', field: { id: f.id, name: f.name } }); break; }
        case 'create_lot': { const l = await this.fieldsService.createLot(params.producerSynUser, params.fieldId, params.dto); result = JSON.stringify({ status: 'created', lot: { id: l.id, name: l.name } }); break; }
        case 'create_truck': { const t = await this.trucksService.create(params.dto as any, params.actionSynUser); result = JSON.stringify({ status: 'created', truck: { id: (t as any).id, plate: (t as any).plate } }); break; }
        case 'attach_document': { const doc = await this.freights.addDocument(params.freightId, { name: params.document.name, url: params.document.url, type: params.document.type, step: params.step || null }, synUser); result = JSON.stringify({ status: 'attached', code: params.code }); break; }
        case 'delete_document': { await this.prisma.freightDocument.delete({ where: { id: params.documentId } }); result = JSON.stringify({ status: 'deleted', code: params.code }); break; }
        case 'respond_trip': { await this.freights.respondTrip(params.freightId, params.assignmentId, { action: params.action, reason: params.reason }, synUser); result = JSON.stringify({ status: params.action, code: params.code }); break; }
        case 'start_trip': { await this.freights.startTrip(params.freightId, params.assignmentId, synUser); result = JSON.stringify({ status: 'started', code: params.code }); break; }
        case 'confirm_trip_loaded': { await this.freights.confirmTripLoaded(params.freightId, params.assignmentId, synUser, params.loadedTons ? Number(params.loadedTons) : undefined); result = JSON.stringify({ status: 'loaded', code: params.code }); break; }
        case 'confirm_trip_finished': { await this.freights.confirmTripFinished(params.freightId, params.assignmentId, synUser); result = JSON.stringify({ status: 'finished', code: params.code }); break; }
        case 'cancel_assignment': { await this.freights.cancelAssignment(params.freightId, params.assignmentId, params.reason, synUser); result = JSON.stringify({ status: 'canceled', code: params.code }); break; }
        case 'assign_transporter': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant' };
          const dto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) dto.truckId = params.truckId;
          if (params.driverId) dto.driverId = params.driverId;
          await this.freights.assign(params.freightId, dto, plantSyn);
          result = JSON.stringify({ status: 'done', code: params.code }); break;
        }
        case 'assign_truck_to_freight': {
          const plantSyn = { ...synUser, companyId: params.plantCompanyId, companyType: 'plant', userType: 'plant', sub: synUser.sub || user.sub || user.id };
          const dto: any = { transportCompanyId: params.transporterCompanyId };
          if (params.truckId) dto.truckId = params.truckId;
          if (params.driverId) dto.driverId = params.driverId;
          await this.freights.assignTruck(params.freightId, dto, plantSyn);
          result = JSON.stringify({ status: 'assigned', code: params.code }); break;
        }
        case 'assign_external_truck': {
          const dto: any = {
            isExternal: true,
            plate: params.plate,
            externalCompanyName: params.externalCompanyName,
            externalDriverName: params.externalDriverName,
          };
          await this.freights.assign(params.freightId, dto, synUser);
          result = JSON.stringify({ status: 'assigned', code: params.code }); break;
        }
        case 'assign_multi_trucks':
        case 'assign_mixed_trucks': {
          const trucks = Array.isArray(params.trucks) ? params.trucks : [];
          await this.freights.assignMulti(params.freightId, { trucks }, synUser);
          result = JSON.stringify({ status: 'assigned', code: params.code, trucksAssigned: trucks.length }); break;
        }
        case 'edit_external_assignment': {
          await this.freights.updateAssignment(params.freightId, params.assignmentId, {
            plate: params.plate,
            externalCompanyName: params.externalCompanyName,
            externalDriverName: params.externalDriverName,
          } as any, synUser);
          result = JSON.stringify({ status: 'updated', code: params.code }); break;
        }
        case 'reactivate_user': {
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { active: true } });
          await this.prisma.user.update({ where: { id: params.targetUserId }, data: { active: true } });
          result = JSON.stringify({ status: 'reactivated', userName: params.userName }); break;
        }
        case 'create_user': {
          const randomPwd = crypto.randomBytes(12).toString('base64url').slice(0, 16) + 'A1!';
          const pwdHash = await bcryptAi.hash(randomPwd, 10);
          const newUser = await this.adminService.createUser(params.dto, pwdHash);
          result = JSON.stringify({ status: 'created', user: { name: (newUser as any).name, email: (newUser as any).email } }); break;
        }
        case 'update_user_role': {
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { role: params.newRole } });
          result = JSON.stringify({ status: 'done', user: params.userName, newRole: params.newRole }); break;
        }
        case 'deactivate_user': {
          await this.prisma.userCompany.update({ where: { id: params.membershipId }, data: { active: false } });
          result = JSON.stringify({ status: 'done', user: params.userName }); break;
        }
        case 'register_truck_expense': {
          await this.trucksService.addExpense(params.truckId, synUser, {
            type: params.type,
            amount: params.amount,
            currency: params.currency,
            date: params.date,
            description: params.description,
          });
          result = JSON.stringify({ status: 'created', type: 'expense' }); break;
        }
        case 'register_truck_income': {
          await this.trucksService.addIncome(params.truckId, synUser, {
            concept: params.concept,
            amount: params.amount,
            currency: params.currency,
            date: params.date,
            status: params.status,
          });
          result = JSON.stringify({ status: 'created', type: 'income' }); break;
        }
        case 'register_truck_movement': {
          await this.trucksService.addMovement(params.truckId, synUser, params.body || {});
          result = JSON.stringify({ status: 'created', type: 'movement' }); break;
        }
        case 'register_trip_data': {
          await this.trucksService.updateTripData(params.freightId, params.assignmentId, synUser, params.body || {});
          result = JSON.stringify({ status: 'updated', type: 'trip_data' }); break;
        }
        case 'attach_truck_document': {
          await this.trucksService.addDocument(params.truckId, synUser, params.body || {});
          result = JSON.stringify({ status: 'attached', type: 'truck_document' }); break;
        }
        // ---- Autonomous Driver Actions ----
        case 'create_autonomous_freight': {
          const af = await this.freights.createAutonomousFreight({
            origin: params.origin, destination: params.destination, grain: params.grain,
            weightKg: params.weightKg, notes: params.notes, truckId: params.truckId,
            fieldId: params.fieldId, originLotId: params.originLotId,
            destPlantId: params.destPlantId, branchId: params.branchId,
          }, synUser);
          result = JSON.stringify({ status: 'created', code: (af as any).code, freightId: (af as any).id }); break;
        }
        case 'finish_autonomous_freight': {
          await this.freights.finishAutonomousFreight(params.freightId, synUser, params.destinationWeightKg, params.notes);
          result = JSON.stringify({ status: 'finished', code: params.code }); break;
        }
        case 'register_plant_arrival': {
          await this.freights.registerPlantArrival(params.freightId, synUser);
          result = JSON.stringify({ status: 'arrived', code: params.code }); break;
        }
        case 'save_ocr_data': {
          const freight = await this.prisma.freight.findFirst({ where: { code: params.code?.toUpperCase() }, select: { id: true } });
          if (!freight) { result = JSON.stringify({ error: `Flete ${params.code} no encontrado.` }); break; }
          await this.freights.saveOcrData(freight.id, params.documentId, params.ocrData, synUser);
          result = JSON.stringify({ status: 'saved', code: params.code }); break;
        }
        default: result = JSON.stringify({ error: `Accion no reconocida: ${tool}` });
      }
      // Clear history after terminal actions so next message starts fresh
      const TERMINAL_ACTIONS = new Set(['create_autonomous_freight', 'finish_autonomous_freight', 'cancel_freight', 'confirm_create_freight', 'confirm_finished']);
      if (TERMINAL_ACTIONS.has(tool)) {
        const effects = this.sessionManager.getSideEffects(session.id) || {};
        effects._clearAiMessages = true;
        this.sessionManager.setSideEffects(session.id, effects);
      }
      return result;
    } catch (e) {
      // Avoid restoring stale pending actions/documents after a failed terminal confirmation.
      await this.prisma.whatsAppSession.update({ where: { id: session.id }, data: { flowState: { ...preExecState } } }).catch(() => {});
      return JSON.stringify({ error: sanitizeConfirmError(e) });
    }
  }

  // ---- Transport tools (simplified) ----
  private async executeTransportTool(toolName: string, input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    switch (toolName) {
      case 'list_trucks': {
        const trucks = await this.prisma.truck.findMany({ where: { companyId, active: true }, include: { assignedUser: { select: { name: true } } }, take: 50 });
        if (trucks.length === 0) return JSON.stringify({ total: 0, message: 'No hay camiones registrados.' });
        const items = trucks.map((t: any) => ({ id: `truck:${t.id}`, title: (t.plate || '').toUpperCase().slice(0, 24), description: `${[t.brand, t.model].filter(Boolean).join(' ')}${t.assignedUser?.name ? ' - ' + t.assignedUser.name : ''}`.slice(0, 72) || 'Sin detalle' }));
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: `${trucks.length} camion(es).\nSeleccione uno:`, listButtonLabel: 'Ver camiones', sectionTitle: 'CAMIONES' }, 'truck_selection');
      }
      case 'list_drivers': {
        const drivers = await this.prisma.userCompany.findMany({ where: { companyId, active: true, role: 'chofer' }, include: { user: { select: { id: true, name: true, phone: true } } }, take: 50 });
        if (drivers.length === 0) return JSON.stringify({ total: 0, message: 'No hay choferes.' });
        const items = drivers.map((d: any) => ({ id: `driver:${d.user.id}`, title: (d.user.name || 'Sin nombre').slice(0, 24), description: (d.user.phone || 'Sin telefono').slice(0, 72) }));
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: `${drivers.length} chofer(es):`, listButtonLabel: 'Ver choferes', sectionTitle: 'CHOFERES' }, 'driver_selection');
      }
      case 'list_transporters': {
        const plantCompanyId = this.resolvePlantCompanyId(user);
        if (!plantCompanyId) return JSON.stringify({ error: 'No es planta.' });
        const companies = await this.prisma.company.findMany({ where: { active: true, OR: [{ type: 'transporter' }, { types: { array_contains: ['transporter'] } }] }, select: { id: true, name: true }, take: 50 });
        if (companies.length === 0) return JSON.stringify({ total: 0, message: 'No hay transportistas.' });
        let filtered = companies;
        if (input.query) {
          const results = fuzzySearch(input.query, companies, (c) => c.name, { threshold: 0.45, maxResults: 10 });
          filtered = results.map(r => r.item);
        }
        const items = filtered.map((c: any) => ({ id: `transporter:${c.id}`, title: c.name.slice(0, 24), description: '' }));
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: `${filtered.length} transportista(s):`, listButtonLabel: 'Ver transportistas', sectionTitle: 'TRANSPORTISTAS' }, 'transporter_selection');
      }
      case 'assign_transporter': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const plantCompanyId = this.resolvePlantCompanyId(user) || r.freight.destCompanyId;
        return this.sessionManager.stageAction(session.id, 'assign_transporter', { freightId: r.freight.id, code: r.freight.code, transporterCompanyId: input.transporterCompanyId, plantCompanyId, truckId: input.truckId, driverId: input.driverId }, `Asignar transporte a ${r.freight.code}`, user);
      }
      case 'assign_truck_to_freight': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const plantCompanyId = this.resolvePlantCompanyId(user) || r.freight.destCompanyId;
        return this.sessionManager.stageAction(session.id, 'assign_truck_to_freight', { freightId: r.freight.id, code: r.freight.code, transporterCompanyId: input.transporterCompanyId, plantCompanyId, truckId: input.truckId, driverId: input.driverId }, `Asignar camion a ${r.freight.code}`, user);
      }
      case 'create_truck': {
        const actionSynUser = { ...synUser, companyId };
        return this.sessionManager.stageAction(session.id, 'create_truck', { dto: { plate: input.plate, model: input.model, companyId }, actionSynUser }, `Crear camion ${input.plate}`);
      }
      case 'create_driver': {
        if (!this.isCallerAdminForCompany(user, companyId)) return JSON.stringify({ error: 'Solo admin puede crear choferes.' });
        return this.sessionManager.stageAction(session.id, 'create_driver', { name: input.name, phone: input.phone, companyId }, `Crear chofer "${input.name}"`);
      }
      case 'deactivate_truck':
        return this.sessionManager.stageAction(session.id, 'deactivate_truck', { truckId: input.truckId, plate: input.truckId }, `Desactivar camion`);
      case 'deactivate_driver':
        return this.sessionManager.stageAction(session.id, 'deactivate_driver', { driverId: input.driverId }, `Desactivar chofer`);
      case 'assign_external_truck': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return this.sessionManager.stageAction(session.id, 'assign_external_truck', { freightId: r.freight.id, code: r.freight.code, plate: input.plate, externalCompanyName: input.externalCompanyName, externalDriverName: input.externalDriverName }, `Asignar externo ${input.plate} a ${r.freight.code}`, user);
      }
      case 'assign_multi_trucks':
      case 'assign_mixed_trucks': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const trucks = Array.isArray(input.trucks) ? input.trucks : [];
        if (trucks.length === 0) return JSON.stringify({ error: 'Debe indicar al menos un camion.' });
        return this.sessionManager.stageAction(session.id, toolName, { freightId: r.freight.id, code: r.freight.code, trucks }, `Asignar ${trucks.length} camion(es) a ${r.freight.code}`, user);
      }
      case 'edit_external_assignment': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const assignmentId = input.assignmentId || r.freight.assignments?.find((a: any) => !!a.id)?.id;
        if (!assignmentId) return JSON.stringify({ error: 'No hay asignacion externa para editar.' });
        return this.sessionManager.stageAction(
          session.id,
          'edit_external_assignment',
          {
            freightId: r.freight.id,
            code: r.freight.code,
            assignmentId,
            plate: input.plate,
            externalCompanyName: input.externalCompanyName,
            externalDriverName: input.externalDriverName,
          },
          `Editar asignacion externa de ${r.freight.code}`,
          user,
        );
      }
      default:
        return JSON.stringify({ error: `Herramienta de transporte no implementada: ${toolName}` });
    }
  }

  // ---- Admin tools (simplified) ----
  private async executeAdminTool(toolName: string, input: any, user: any, synUser: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    switch (toolName) {
      case 'get_user_profile':
        return JSON.stringify({ name: user.name, email: user.email, phone: user.phone, role: user.role, company: user.company?.name || 'N/A', companyType: this.resolveCompanyType(user) });
      case 'list_company_users': {
        const members = await this.prisma.userCompany.findMany({ where: { companyId, active: true }, include: { user: { select: { id: true, name: true, email: true, phone: true } } }, take: 50 });
        const items = members.map((m: any) => ({ id: `user:${m.user.id}`, title: (m.user.name || 'Sin nombre').slice(0, 24), description: `${m.role} | ${m.user.email || 'sin email'}`.slice(0, 72) }));
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: `${members.length} usuario(s):`, listButtonLabel: 'Ver usuarios', sectionTitle: 'USUARIOS' }, 'user_selection');
      }
      case 'switch_company': {
        if (!input.companyId) {
          const memberships = (user.memberships || []).filter((m: any) => m.active);
          const items = memberships.map((m: any) => ({ id: `company:${m.companyId}`, title: (m.company?.name || 'Sin nombre').slice(0, 24), description: (m.role || '').slice(0, 72) }));
          return this.sessionManager.storePendingSelection(session.id, items, { headerText: 'Empresas disponibles:', listButtonLabel: 'Ver empresas', sectionTitle: 'EMPRESAS' }, 'company_selection');
        }
        const effects = this.sessionManager.getSideEffects(session.id);
        effects._clearAiMessages = true;
        effects._ts = effects._ts || Date.now();
        this.sessionManager.setSideEffects(session.id, effects);
        await this.prisma.whatsAppSession.update({ where: { id: session.id }, data: { flowState: { selectedCompanyId: input.companyId } } });
        const company = await this.prisma.company.findUnique({ where: { id: input.companyId }, select: { name: true } });
        return JSON.stringify({ status: 'switched', company: company?.name || input.companyId });
      }
      case 'create_user': {
        if (!this.isCallerAdminForCompany(user, companyId)) return JSON.stringify({ error: 'Solo admin puede crear usuarios.' });
        return this.sessionManager.stageAction(session.id, 'create_user', { dto: { name: input.name, email: input.email, phone: input.phone, role: input.role || 'operario', companyId }, roleLabel: input.role || 'operario' }, `Crear usuario "${input.name}"`);
      }
      case 'update_user_role': {
        if (!this.isCallerAdminForCompany(user, companyId)) return JSON.stringify({ error: 'Solo admin.' });
        const membership = await this.prisma.userCompany.findFirst({ where: { companyId, active: true, user: { OR: [{ name: { contains: input.userIdentifier, mode: 'insensitive' } }, { email: { equals: input.userIdentifier, mode: 'insensitive' } }] } }, include: { user: { select: { id: true, name: true } } } });
        if (!membership) return JSON.stringify({ error: `No se encontro "${input.userIdentifier}".` });
        return this.sessionManager.stageAction(session.id, 'update_user_role', { membershipId: membership.id, targetUserId: membership.user.id, userName: membership.user.name, newRole: input.newRole, companyId }, `Cambiar rol de "${membership.user.name}" a ${input.newRole}`);
      }
      case 'deactivate_user': {
        if (!this.isCallerAdminForCompany(user, companyId)) return JSON.stringify({ error: 'Solo admin.' });
        const membership = await this.prisma.userCompany.findFirst({ where: { companyId, active: true, user: { OR: [{ name: { contains: input.userIdentifier, mode: 'insensitive' } }, { email: { equals: input.userIdentifier, mode: 'insensitive' } }] } }, include: { user: { select: { id: true, name: true } } } });
        if (!membership) return JSON.stringify({ error: `No se encontro "${input.userIdentifier}".` });
        return this.sessionManager.stageAction(session.id, 'deactivate_user', { membershipId: membership.id, targetUserId: membership.user.id, userName: membership.user.name, companyId }, `Desactivar "${membership.user.name}"`);
      }
      case 'update_profile':
        return this.sessionManager.stageAction(session.id, 'update_profile', { userId: user.id || user.sub, name: input.name }, `Actualizar perfil`);
      case 'list_enabled_plants': {
        const producerCoId = this.resolveProducerCompanyId(user);
        if (!producerCoId) return JSON.stringify({ error: 'No es productor.' });
        const accesses = await this.prisma.plantProducerAccess.findMany({ where: { producerCompanyId: producerCoId, active: true }, include: { plantCompany: { select: { name: true } } }, take: 50 });
        return JSON.stringify({ plants: accesses.map(a => ({ name: a.plantCompany?.name })) });
      }
      case 'list_enabled_producers': {
        const plantCoId = this.resolvePlantCompanyId(user);
        if (!plantCoId) return JSON.stringify({ error: 'No es planta.' });
        const accesses = await this.prisma.plantProducerAccess.findMany({ where: { plantCompanyId: plantCoId, active: true }, include: { producerCompany: { select: { name: true } } }, take: 50 });
        return JSON.stringify({ producers: accesses.map(a => ({ name: a.producerCompany?.name })) });
      }
      case 'list_branches': {
        const branches = await this.prisma.plant.findMany({ where: { companyId, active: true }, select: { id: true, name: true, address: true } });
        return JSON.stringify({ branches });
      }
      default:
        return JSON.stringify({ error: `Herramienta admin no implementada: ${toolName}` });
    }
  }

  // ---- Location tools ----
  private async executeLocationTool(toolName: string, input: any, user: any, synUser: any, session: any): Promise<string> {
    switch (toolName) {
      case 'generate_location_link': {
        const secret = this.config.get<string>('JWT_SECRET') || process.env.JWT_SECRET || 'tolvink-default-secret';
        const token = createSignedToken({ sessionId: session.id, purpose: input.purpose }, secret, 60);
        return JSON.stringify({ url: `${APP_URL}/set-location?token=${token}&purpose=${input.purpose}`, message: 'Abri este link para marcar la ubicacion en el mapa.' });
      }
      case 'generate_tracking_link': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return JSON.stringify({ url: `${APP_URL}/freight/${r.freight.id}` });
      }
      case 'generate_map_link': {
        const p = new URLSearchParams();
        p.set('lat', String(input.lat)); p.set('lng', String(input.lng)); p.set('n', (input.name || '').slice(0, 60));
        if (input.destLat != null) { p.set('dlat', String(input.destLat)); p.set('dlng', String(input.destLng)); p.set('dn', (input.destName || '').slice(0, 60)); }
        return JSON.stringify({ url: `${APP_URL}/ver-mapa?${p.toString()}` });
      }
      case 'generate_report_link': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        return JSON.stringify({ url: `${APP_URL}/freight/${r.freight.id}/report` });
      }
      case 'generate_daily_map_link':
        return JSON.stringify({ url: `${APP_URL}/locations` });
      case 'generate_batch_report_link': {
        const p = new URLSearchParams();
        if (input.status) p.set('status', input.status);
        if (input.dateFrom) p.set('from', input.dateFrom);
        if (input.dateTo) p.set('to', input.dateTo);
        return JSON.stringify({ url: `${APP_URL}/reports?${p.toString()}` });
      }
      case 'navigate_app': {
        const effects = this.sessionManager.getSideEffects(session.id);
        effects._navigate = { screen: input.screen, freightId: input.freightId };
        effects._ts = effects._ts || Date.now();
        this.sessionManager.setSideEffects(session.id, effects);
        return JSON.stringify({ navigated: true, screen: input.screen });
      }
      case 'rename_document': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        await this.prisma.freightDocument.update({ where: { id: input.documentId }, data: { name: input.newName.trim() } });
        return JSON.stringify({ status: 'renamed', newName: input.newName.trim() });
      }
      case 'generate_share_link_with_details':
      case 'generate_shared_link': {
        const r = await this.resolveFreightWithAccess(input.code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const baseUrl = process.env.FRONTEND_URL || 'https://tolvink.com';
        try {
          const link = await (this.freights as any).createSharedLink(r.freight.id, user);
          return JSON.stringify({ url: `${baseUrl}/shared/${link.token}`, expiresAt: link.expiresAt, code: r.freight.code });
        } catch (e: any) {
          return JSON.stringify({ error: e.message || 'Error al generar link.' });
        }
      }
      default:
        return JSON.stringify({ url: `${APP_URL}` });
    }
  }

  // ---- Search tools ----
  private async executeSearchTool(toolName: string, input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    switch (toolName) {
      case 'list_fields': {
        const fields = await this.fieldsService.getFields(user);
        if (!fields || fields.length === 0) return JSON.stringify({ total: 0, message: 'No hay campos.' });
        return JSON.stringify({
          total: fields.length,
          fields: fields.map((f: any) => ({
            id: f.id,
            name: f.name,
            address: f.address || null,
            lotCount: Array.isArray(f.lots) ? f.lots.length : 0,
          })),
        });
      }
      case 'list_lots': {
        if (input.fieldId) {
          const lots = await this.fieldsService.getLots(user, input.fieldId);
          if (!lots || lots.length === 0) return JSON.stringify({ total: 0, message: 'No hay lotes.' });
          return JSON.stringify({ total: lots.length, lots });
        }
        const fields = await this.fieldsService.getFields(user);
        const lots = (fields || []).flatMap((f: any) =>
          (Array.isArray(f.lots) ? f.lots : []).map((l: any) => ({
            id: l.id,
            name: l.name,
            hectares: l.hectares ?? null,
            fieldId: f.id,
            fieldName: f.name,
          })),
        );
        if (lots.length === 0) return JSON.stringify({ total: 0, message: 'No hay lotes.' });
        return JSON.stringify({ total: lots.length, lots });
      }
      case 'search_plants': {
        if (!producerCompanyId) return JSON.stringify({ error: 'No es productor.' });
        const accesses = await this.prisma.plantProducerAccess.findMany({ where: { producerCompanyId, active: true }, select: { plantCompanyId: true }, take: 500 });
        const plantCompanyIds = accesses.map(ar => ar.plantCompanyId);
        if (plantCompanyIds.length === 0) return JSON.stringify({ plants: [], message: 'No tiene plantas habilitadas' });
        const companies = await this.prisma.company.findMany({ where: { id: { in: plantCompanyIds }, active: true }, select: { id: true, name: true, plants: { where: { active: true }, select: { id: true, name: true } } }, take: 50 });
        let filtered = companies;
        if (input.query) {
          const results = fuzzySearch(input.query, companies, (c) => c.name, { threshold: 0.55, maxResults: 10, aliases: ENTITY_ALIASES });
          filtered = results.map(r => r.item) as any;
        }
        if (filtered.length <= 2) {
          return JSON.stringify({ plants: filtered.map((c: any) => ({ companyId: c.id, companyName: c.name, branches: (c.plants || []).map((b: any) => ({ id: b.id, name: b.name })) })) });
        }
        const items = filtered.map((c: any) => ({ id: `plant:${c.id}`, title: c.name.slice(0, 24), description: `${c.plants?.length || 0} sucursal(es)`.slice(0, 72) }));
        return this.sessionManager.storePendingSelection(session.id, items, { headerText: 'Plantas disponibles:\nSeleccione una:', listButtonLabel: 'Ver plantas', sectionTitle: 'PLANTAS' }, 'plant_info');
      }
      case 'search_fields': {
        if (!producerCompanyId) return JSON.stringify({ error: 'No es productor.' });
        const fields = await this.prisma.field.findMany({ where: { companyId: producerCompanyId, active: true }, select: { id: true, name: true, address: true }, take: 200 });
        if (fields.length === 0) return JSON.stringify({ results: [], message: 'No hay campos.' });
        const results = fuzzySearch(input.query, fields, (f) => f.name, { threshold: 0.4, maxResults: 10 });
        return JSON.stringify({ results: results.map(r => ({ ...r.item, score: r.score })) });
      }
      case 'search_lots': {
        if (!producerCompanyId) return JSON.stringify({ error: 'No es productor.' });
        const where: any = { companyId: producerCompanyId, active: true };
        if (input.fieldId) where.fieldId = input.fieldId;
        const lots = await this.prisma.lot.findMany({ where, select: { id: true, name: true, field: { select: { name: true } } }, take: 500 });
        if (lots.length === 0) return JSON.stringify({ results: [], message: 'No hay lotes.' });
        const results = fuzzySearch(input.query, lots, (l) => l.name, { threshold: 0.4, maxResults: 10 });
        return JSON.stringify({ results: results.map(r => ({ ...r.item, score: r.score })) });
      }
      default:
        return JSON.stringify({ error: 'Busqueda no reconocida.' });
    }
  }

  // ---- Fleet economics tools ----
  private async executeFleetTool(toolName: string, input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    const resolveTruck = async (plate?: string, truckId?: string) => {
      if (truckId) return truckId;
      if (!plate) return null;
      const norm = plate.replace(/[\s\-\.]/g, '').toUpperCase();
      const trucks = await this.prisma.truck.findMany({
        where: { OR: [{ companyId }, { ownerCompanyId: companyId }], active: true },
        select: { id: true, plate: true },
      });
      return (trucks.find(t => t.plate.replace(/[\s\-]/g, '').toUpperCase() === norm) || trucks.find(t => t.plate.replace(/[\s\-]/g, '').toUpperCase().includes(norm)))?.id || null;
    };

    switch (toolName) {
      case 'get_truck_detail': {
        const tid = await resolveTruck(input.plate, input.truckId);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate || input.truckId}" no encontrado` });
        const detail = await this.trucksService.getDetail(tid, user);
        return JSON.stringify(detail);
      }
      case 'get_truck_documents': {
        const tid = await resolveTruck(input.plate, input.truckId);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate || input.truckId}" no encontrado` });
        const detail: any = await this.trucksService.getDetail(tid, user);
        let docs = Array.isArray(detail?.documents) ? detail.documents : [];
        const filter = String(input.filter || 'all');
        if (filter === 'expired') docs = docs.filter((d: any) => d.expiryStatus === 'expired');
        else if (filter === 'expiring') docs = docs.filter((d: any) => d.expiryStatus === 'expiring_soon');
        else if (filter === 'valid') docs = docs.filter((d: any) => d.expiryStatus === 'valid');
        return JSON.stringify({ total: docs.length, documents: docs });
      }
      case 'get_expiring_documents': {
        const days = Number(input.days || 30);
        const docs = await this.trucksService.getExpiringDocuments(user, Number.isFinite(days) && days > 0 ? days : 30);
        return JSON.stringify({ total: docs.length, documents: docs });
      }
      case 'attach_truck_document': {
        const tid = await resolveTruck(input.plate, input.truckId);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate || input.truckId}" no encontrado` });
        const pendingDoc = this.sessionManager.getSideEffects(session.id)?.pendingDocument || (session.flowState as any)?.pendingDocument;
        if (!pendingDoc?.url) return JSON.stringify({ error: 'No hay archivo pendiente.' });
        const body = {
          type: input.docType || 'OTHER',
          name: pendingDoc.name || 'Documento',
          fileUrl: pendingDoc.url,
          fileName: pendingDoc.name || 'documento',
          ...(input.linkTo === 'expense' ? { expenseId: input.linkId } : {}),
          ...(input.linkTo === 'income' ? { incomeId: input.linkId } : {}),
          ...(input.linkTo === 'movement' ? { movementId: input.linkId } : {}),
        };
        return this.sessionManager.stageAction(session.id, 'attach_truck_document', { truckId: tid, body }, `Adjuntar documento a camion ${input.plate || input.truckId}`);
      }
      case 'register_truck_expense': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        return this.sessionManager.stageAction(session.id, 'register_truck_expense', { truckId: tid, companyId, type: input.type, amount: input.amount, currency: input.currency || 'UYU', date: input.date || new Date().toISOString().split('T')[0], description: input.description, createdById: user.sub || user.id }, `Registrar gasto ${input.type} $${input.amount}`);
      }
      case 'register_truck_income': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        return this.sessionManager.stageAction(session.id, 'register_truck_income', { truckId: tid, companyId, concept: input.concept, amount: input.amount, currency: input.currency || 'UYU', date: input.date || new Date().toISOString().split('T')[0], status: input.status || 'PENDING', createdById: user.sub || user.id }, `Registrar ingreso "${input.concept}" $${input.amount}`);
      }
      case 'list_truck_expenses': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        const where: any = { truckId: tid, companyId };
        if (input.from) where.date = { ...(where.date || {}), gte: new Date(input.from) };
        if (input.to) where.date = { ...(where.date || {}), lte: new Date(input.to) };
        if (input.type) where.type = input.type;
        const expenses = await this.prisma.truckExpense.findMany({ where, orderBy: { date: 'desc' }, take: 50 });
        const total = expenses.reduce((s: number, e: any) => s + Number(e.amount || 0), 0);
        return JSON.stringify({ total: Math.round(total), count: expenses.length, expenses: expenses.map((e: any) => ({ type: e.type, amount: Number(e.amount), date: e.date?.toISOString().split('T')[0], description: e.description })) });
      }
      case 'list_truck_incomes': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        const incomes = await this.trucksService.listIncomes(tid, user, input.from, input.to, input.status);
        const total = incomes.reduce((s: number, i: any) => s + Number(i.amount || 0), 0);
        return JSON.stringify({ total: Math.round(total), count: incomes.length, incomes });
      }
      case 'register_truck_movement': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        const body: any = {
          type: input.type,
          description: input.description,
          originName: input.originName,
          destName: input.destName,
          kmDriven: input.kmDriven,
          fuelLiters: input.fuelLiters,
          fuelCost: input.fuelCost,
          tollCost: input.tollCost,
        };
        return this.sessionManager.stageAction(session.id, 'register_truck_movement', { truckId: tid, body }, `Registrar movimiento ${input.type || ''}`.trim());
      }
      case 'list_truck_movements': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        const movements = await this.trucksService.listMovements(tid, user, input.from, input.to, input.type);
        return JSON.stringify({ count: movements.length, movements });
      }
      case 'register_trip_data': {
        const code = input.freightCode || input.code;
        const r = await this.resolveFreightWithAccess(code, user);
        if (r.error) return JSON.stringify({ error: r.error });
        const assignmentId = r.freight.assignments?.[0]?.id;
        if (!assignmentId) return JSON.stringify({ error: 'No hay asignacion activa para registrar datos de viaje.' });
        const body: any = {
          kmLoaded: input.kmLoaded,
          kmEmpty: input.kmEmpty,
          kmTotal: input.kmTotal,
          fuelLiters: input.fuelLiters,
          fuelCostPerLiter: input.fuelCostPerLiter,
          tollCost: input.tollCost,
          odometerStart: input.odometerStart,
          odometerEnd: input.odometerEnd,
          loadingMinutes: input.loadingMinutes,
          unloadingMinutes: input.unloadingMinutes,
        };
        return this.sessionManager.stageAction(session.id, 'register_trip_data', { freightId: r.freight.id, assignmentId, body }, `Registrar datos de viaje ${r.freight.code}`);
      }
      case 'get_truck_economic_summary': {
        const tid = await resolveTruck(input.plate);
        if (!tid) return JSON.stringify({ error: `Camion "${input.plate}" no encontrado` });
        const summary = await this.trucksService.getEconomicSummary(tid, user, input.from, input.to);
        return JSON.stringify(summary);
      }
      case 'get_fleet_alerts': {
        const alerts = await this.trucksService.getFleetAlerts(user);
        return JSON.stringify(alerts);
      }
      case 'get_fleet_summary': {
        const summary = await this.trucksService.getFleetSummary(user);
        return JSON.stringify(summary);
      }
      default:
        return JSON.stringify({ error: `Fleet tool no implementada: ${toolName}` });
    }
  }
}
