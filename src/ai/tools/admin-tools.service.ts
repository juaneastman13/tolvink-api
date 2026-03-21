// =====================================================================
// TOLVINK — Admin Tools Service
// Handles user, company, branch, and access management AI tool calls.
// Extracted from ai.service.ts for modularity.
// =====================================================================

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { AdminService } from '../../admin/admin.controller';
import { AssignmentSuggestionsService } from '../../freights/assignment-suggestions.service';
import { SessionManagerService } from '../session/session-manager.service';
import { AiContextService } from './ai-context.service';
import {
  resolveCompanyTypes as _resolveCompanyTypes,
  resolveActiveRole as _resolveActiveRole,
  hasType as _hasType,
} from '../ai.utils';

@Injectable()
export class AdminToolsService {
  private readonly logger = new Logger(AdminToolsService.name);

  constructor(
    private config: ConfigService,
    private prisma: PrismaService,
    private adminService: AdminService,
    private assignmentSuggestions: AssignmentSuggestionsService,
    private sessionManager: SessionManagerService,
    private aiContext: AiContextService,
  ) {}

  // ======================== HELPER DELEGATES ============================

  private resolveCompanyType(user: any): string {
    return this.aiContext.resolveCompanyType(user);
  }

  private resolveProducerCompanyId(user: any): string | null {
    return this.aiContext.resolveProducerCompanyId(user);
  }

  private resolvePlantCompanyId(user: any): string | null {
    return this.aiContext.resolvePlantCompanyId(user);
  }

  private isCallerAdminForCompany(user: any, companyId?: string): boolean {
    return this.aiContext.isCallerAdminForCompany(user, companyId);
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

  // ======================== USER PROFILE ================================

  toolGetUserProfile(user: any): string {
    const { isChofer, isAdmin, userRole } = _resolveActiveRole(user);
    const activeCoId = user.activeCompanyId || user.companyId;
    const activeMem = (user.memberships || []).find((m: any) => m.companyId === activeCoId && m.active !== false);
    return JSON.stringify({
      name: user.name,
      email: user.email,
      phone: user.phone,
      role: userRole,
      isAdmin,
      isChofer,
      company: activeMem?.company?.name || user.company?.name || null,
      companyType: this.resolveCompanyType(user),
      totalCompanies: (user.memberships || []).filter((m: any) => m.active !== false).length,
    });
  }

  // ======================== CREATE USER =================================

  async toolCreateUser(input: any, user: any, session: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    const companyType = this.resolveCompanyType(user);
    const targetCompanyId = producerCompanyId || user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, targetCompanyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden crear usuarios.' });
    }
    const primaryType = companyType.split(',')[0]?.trim() || 'producer';

    // Map Spanish role names to Prisma UserRole enum (admin | operator | platform_admin)
    const inputRole = input.role || 'operario';
    const validRoles = ['admin', 'gerente', 'operario', 'chofer'];
    if (!validRoles.includes(inputRole)) {
      return JSON.stringify({ error: `Rol inválido: ${inputRole}. Valores válidos: ${validRoles.join(', ')}` });
    }
    const roleToEnum: Record<string, string> = {
      admin: 'admin', gerente: 'admin',
      operario: 'operator', chofer: 'operator',
    };
    const prismaRole = roleToEnum[inputRole] || 'operator';

    // P2-11: Check for duplicate email before staging
    const existing = await this.prisma.user.findFirst({
      where: { email: input.email?.toLowerCase().trim() },
      select: { id: true, name: true },
    });
    if (existing) {
      return JSON.stringify({ error: `Ya existe un usuario con email ${input.email} (${existing.name}). No se puede crear duplicado.` });
    }

    // Password generated at confirm time — never stored in session flowState

    const dto: any = {
      name: input.name,
      email: input.email,
      password: 'placeholder', // required by DTO — actual hash passed separately
      phone: input.phone || null,
      role: prismaRole,
      companyId: targetCompanyId,
      userTypes: [primaryType],
      companyByType: { [primaryType]: targetCompanyId },
      roleByType: { [primaryType]: inputRole },
    };

    const summary = `Crear usuario "${input.name}" (${input.email}) con rol ${inputRole}`;
    return this.stageAction(session, 'create_user', { dto, roleLabel: inputRole }, summary, user);
  }

  // ======================== LIST COMPANY USERS ===========================

  async toolListCompanyUsers(user: any, session: any): Promise<string> {
    // Scope to active company only — don't leak PII from other companies
    const companyIds: string[] = [];
    if (user.activeCompanyId) companyIds.push(user.activeCompanyId);
    else if (user.companyId) companyIds.push(user.companyId);

    if (companyIds.length === 0) {
      return JSON.stringify({ error: 'No se encontró su empresa.', users: [] });
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        user: { select: { id: true, name: true, email: true, phone: true, active: true } },
        company: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const ROLE_LABEL: Record<string, string> = { admin: 'Admin', operator: 'Operador', chofer: 'Chofer' };
    const activeUsers = memberships.filter(m => m.user.active);

    if (activeUsers.length === 0) {
      return JSON.stringify({ total: 0, message: 'No hay usuarios activos.' });
    }

    const items = activeUsers.map(m => ({
      id: `user:${m.user.id}`,
      title: (m.user.name || 'Sin nombre').slice(0, 24),
      description: `${ROLE_LABEL[m.role] || m.role} · ${m.company.name}`.slice(0, 72),
    }));

    const usersData = activeUsers.map(m => ({
      id: m.user.id, name: m.user.name,
      role: m.role, company: m.company.name,
    }));

    return this.storePendingSelection(session, items, {
      headerText: '👤 Usuarios de la empresa.\nSeleccione uno:',
      listButtonLabel: 'Ver usuarios',
      sectionTitle: 'USUARIOS',
    }, 'user_info', { users: usersData });
  }

  // ======================== UPDATE USER ROLE =============================

  async toolUpdateUserRole(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    }
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden cambiar roles.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede cambiar su propio rol.' });
    }

    return this.stageAction(session, 'update_user_role', {
      membershipId: membership.id,
      companyId: membership.companyId,
      targetUserId: membership.user.id,
      userName: membership.user.name,
      newRole: input.newRole,
    }, `Cambiar rol de "${membership.user.name}" a ${input.newRole}`, user);
  }

  // ======================== DEACTIVATE USER ==============================

  async toolDeactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    }
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden desactivar usuarios.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: true,
        user: {
          active: true,
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario activo "${searchTerm}" en su empresa.` });
    }

    if (membership.user.id === user.id) {
      return JSON.stringify({ error: 'No puede desactivarse a sí mismo.' });
    }

    return this.stageAction(session, 'deactivate_user', {
      membershipId: membership.id,
      companyId,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Desactivar usuario "${membership.user.name}" de su empresa`, user);
  }

  // ======================== REACTIVATE USER ==============================

  async toolReactivateUser(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo usuarios admin/gerente de esta empresa pueden reactivar usuarios.' });
    }

    const searchTerm = input.userIdentifier.trim();
    const membership = await this.prisma.userCompany.findFirst({
      where: {
        companyId,
        active: false,
        user: {
          OR: [
            { name: { contains: searchTerm, mode: 'insensitive' } },
            { email: { equals: searchTerm, mode: 'insensitive' } },
          ],
        },
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    if (!membership) {
      return JSON.stringify({ error: `No se encontró un usuario inactivo "${searchTerm}" en su empresa.` });
    }

    return this.stageAction(session, 'reactivate_user', {
      membershipId: membership.id,
      targetUserId: membership.user.id,
      userName: membership.user.name,
    }, `Reactivar usuario "${membership.user.name}" en su empresa`, user);
  }

  // ======================== UPDATE PROFILE ===============================

  async toolUpdateProfile(input: any, user: any, session: any): Promise<string> {
    // Block email/phone changes via WhatsApp for security — require web
    if (input.email || input.phone) {
      return JSON.stringify({ error: 'El email y teléfono solo se pueden cambiar desde la plataforma web por seguridad.' });
    }
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios. Indique el nombre que desea actualizar.' });
    return this.stageAction(session, 'update_profile', {
      userId: user.id, name: input.name,
    }, `Editar perfil: ${changes.join(', ')}`, user);
  }

  // ======================== UPDATE USER ADMIN ============================

  async toolUpdateUserAdmin(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar usuarios.' });
    }
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, name: true, email: true } });
    if (!target) return JSON.stringify({ error: 'Usuario no encontrado.' });
    // Verify target belongs to caller's company
    const targetMem = await this.prisma.userCompany.findFirst({ where: { userId: input.userId, companyId } });
    if (!targetMem) return JSON.stringify({ error: 'El usuario no pertenece a su empresa.' });
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.email) changes.push(`email: ${input.email}`);
    if (input.phone) changes.push(`teléfono: ${input.phone}`);
    if (input.role) changes.push(`rol: ${input.role}`);
    if (input.active !== undefined) changes.push(input.active ? 'reactivar' : 'desactivar');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_user_admin', {
      companyId, userId: input.userId, userName: target.name, name: input.name, email: input.email, phone: input.phone, role: input.role, active: input.active,
    }, `Editar usuario "${target.name}": ${changes.join(', ')}`, user);
  }

  // ======================== SWITCH COMPANY ===============================

  async toolSwitchCompany(input: any, user: any, session: any): Promise<string> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    if (memberships.length <= 1) {
      return JSON.stringify({ error: 'Solo pertenece a una empresa. No es posible cambiar.' });
    }

    const TYPE_LABELS: Record<string, string> = {
      producer: 'Productor', plant: 'Planta', transporter: 'Transportista',
    };

    // If no companyId, send interactive selection to user
    if (!input.companyId) {
      const activeCompanyId = user.activeCompanyId || user.companyId;
      const companies = memberships.map((m: any) => ({
        id: m.companyId,
        name: m.company?.name || 'Empresa',
        type: _resolveCompanyTypes(m.company).map(t => TYPE_LABELS[t] || t).join(', ') || 'Desconocido',
        active: m.companyId === activeCompanyId,
      }));

      // Use storePendingSelection (side-effects pattern, merged by chat())
      return this.storePendingSelection(
        session,
        companies.map(c => ({
          id: `selco:${c.id}`,
          title: c.name,
          description: `${c.type}${c.active ? ' (actual)' : ''}`,
        })),
        {
          headerText: 'Seleccione la empresa con la que desea operar:',
          listButtonLabel: 'Ver empresas',
          sectionTitle: 'Sus empresas',
        },
        'company_selection',
        { companies },
      );
    }

    // Validate membership — re-fetch from DB to prevent stale check
    const freshMembership = await this.prisma.userCompany.findFirst({
      where: { userId: user.id, companyId: input.companyId, active: true },
      include: { company: { select: { name: true, type: true } } },
    });
    if (!freshMembership) {
      return JSON.stringify({ error: 'No pertenece a esa empresa.' });
    }

    // NOTE: Do NOT update activeCompanyId in DB — WhatsApp company selection is
    // session-scoped to avoid desyncing the web app. The selected company is stored
    // in flowState.selectedCompanyId and read by freight creation tools.
    const oldCompanyId = user.activeCompanyId || user.companyId;

    // Audit log (fire-and-forget)
    this.prisma.auditLog.create({
      data: {
        entityType: 'user', entityId: user.id,
        action: 'whatsapp_company_selected',
        fromValue: oldCompanyId || undefined,
        toValue: input.companyId, userId: user.id,
        metadata: { source: 'whatsapp_ai', sessionScoped: true },
      },
    }).catch((err: any) => this.logger.warn(`Audit log failed: ${err.message}`));

    // Use side-effects (merged by chat()) — _clearAiMessages flag tells chat() to use [] instead of trimmedMessages
    const effects = this.sessionManager.getSideEffects(session.id);
    effects._clearAiMessages = true;
    effects.companyConfirmed = true;
    effects.selectedCompanyId = input.companyId;
    effects.pendingAction = undefined;
    effects.pendingFreight = undefined;
    effects.activeContext = undefined;
    effects._pendingSelection = undefined;
    effects._ts = effects._ts || Date.now();
    this.sessionManager.setSideEffects(session.id, effects);

    const companyName = (freshMembership as any).company?.name || 'Empresa';
    const freshTypes = _resolveCompanyTypes((freshMembership as any).company);
    const companyType = freshTypes.map(t => TYPE_LABELS[t] || t).join(', ') || '';

    return JSON.stringify({
      status: 'switched',
      companyName,
      companyType,
      message: `Empresa activa cambiada a "${companyName}" (${companyType}). Todas las operaciones se realizarán con esta empresa.`,
    });
  }

  // ======================== UPDATE COMPANY ===============================

  async toolUpdateCompany(input: any, user: any, session: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!this.isCallerAdminForCompany(user, companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar la empresa.' });
    }
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.address) changes.push(`dirección: ${input.address}`);
    if (input.phone) changes.push(`teléfono: ${input.phone}`);
    if (input.email) changes.push(`email: ${input.email}`);
    if (input.lat != null || input.lng != null) changes.push('ubicación');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_company', {
      companyId, name: input.name, address: input.address, phone: input.phone, email: input.email, lat: input.lat, lng: input.lng,
    }, `Editar empresa: ${changes.join(', ')}`, user);
  }

  // ======================== ENABLED PLANTS ===============================

  async toolListEnabledPlants(user: any): Promise<string> {
    const producerCompanyId = this.resolveProducerCompanyId(user);
    if (!producerCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa productora.' });
    // LEGACY: PlantProducerAccess — to be migrated to CompanyAccess
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId, active: true },
      include: { plantCompany: { select: { id: true, name: true, address: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (accesses.length === 0) return JSON.stringify({ total: 0, message: 'No hay plantas habilitadas.' });
    const plants = accesses.map((a: any) => ({
      id: a.plantCompany?.id, name: a.plantCompany?.name, address: a.plantCompany?.address,
    }));
    return JSON.stringify({ total: plants.length, plants });
  }

  // ======================== ENABLED PRODUCERS ============================

  async toolListEnabledProducers(user: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!_hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden ver productores habilitados.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    if (!plantCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa planta.' });
    const accesses = await this.prisma.plantProducerAccess.findMany({
      where: { plantCompanyId, active: true },
      include: {
        producerCompany: { select: { id: true, name: true, email: true } },
        producerUser: { select: { id: true, name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    if (accesses.length === 0) return JSON.stringify({ total: 0, message: 'No hay productores habilitados.' });
    const producers = accesses.map((a: any) => ({
      accessId: a.id,
      companyName: a.producerCompany?.name, companyId: a.producerCompany?.id,
      userName: a.producerUser?.name, userPhone: a.producerUser?.phone,
    }));
    return JSON.stringify({ total: producers.length, producers });
  }

  // ======================== GRANT PRODUCER ACCESS ========================

  async toolGrantProducerAccess(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!_hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden habilitar productores.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    if (!plantCompanyId) return JSON.stringify({ error: 'No se pudo determinar su empresa planta.' });
    const producerCo = await this.prisma.company.findFirst({
      where: { id: input.producerCompanyId, active: true },
      select: { id: true, name: true, type: true, types: true },
    });
    if (!producerCo) return JSON.stringify({ error: 'Empresa productora no encontrada.' });
    const coTypes = Array.isArray(producerCo.types) && (producerCo.types as string[]).length > 0
      ? (producerCo.types as string[]) : [producerCo.type];
    if (!coTypes.includes('producer') && !coTypes.includes('transporter')) return JSON.stringify({ error: 'La empresa debe ser de tipo productor o transportista.' });
    return this.stageAction(session, 'grant_producer_access', {
      plantCompanyId, producerCompanyId: input.producerCompanyId, producerUserId: input.producerUserId,
      producerName: producerCo.name,
    }, `Habilitar productor "${producerCo.name}" en la planta`, user);
  }

  // ======================== REVOKE PRODUCER ACCESS =======================

  async toolRevokeProducerAccess(input: any, user: any, session: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!_hasType(companyType, 'plant')) return JSON.stringify({ error: 'Solo plantas pueden revocar accesos.' });
    const plantCompanyId = this.resolvePlantCompanyId(user);
    const access = await this.prisma.plantProducerAccess.findFirst({
      where: { id: input.accessId, active: true, ...(plantCompanyId ? { plantCompanyId } : {}) },
      include: { producerCompany: { select: { name: true } } },
    });
    if (!access) return JSON.stringify({ error: 'Acceso no encontrado.' });
    return this.stageAction(session, 'revoke_producer_access', {
      accessId: input.accessId, producerName: (access as any).producerCompany?.name,
    }, `Revocar acceso del productor "${(access as any).producerCompany?.name}"`, user);
  }

  // ======================== BRANCHES ====================================

  async toolListBranches(user: any): Promise<string> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) return JSON.stringify({ error: 'No se pudo determinar su empresa.' });
    const branches = await this.prisma.branch.findMany({
      where: { companyId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, address: true, reference: true },
    });
    if (branches.length === 0) return JSON.stringify({ total: 0, message: 'No hay sucursales registradas.' });
    return JSON.stringify({ total: branches.length, branches });
  }

  async toolCreateBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden crear sucursales.' });
    }
    if (!input.name?.trim()) return JSON.stringify({ error: 'El nombre de la sucursal es obligatorio.' });
    const companyId = user.activeCompanyId || user.companyId;
    return this.stageAction(session, 'create_branch', {
      companyId, name: input.name.trim(), address: input.address, reference: input.reference, lat: input.lat, lng: input.lng,
    }, `Crear sucursal "${input.name.trim()}"`, user);
  }

  async toolUpdateBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden editar sucursales.' });
    }
    const companyId = user.activeCompanyId || user.companyId;
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, active: true },
      select: { id: true, name: true },
    });
    if (!branch) return JSON.stringify({ error: 'Sucursal no encontrada.' });
    const changes: string[] = [];
    if (input.name) changes.push(`nombre: ${input.name}`);
    if (input.address) changes.push(`dirección: ${input.address}`);
    if (input.reference) changes.push(`referencia: ${input.reference}`);
    if (input.lat != null || input.lng != null) changes.push('ubicación');
    if (changes.length === 0) return JSON.stringify({ error: 'No se indicaron cambios.' });
    return this.stageAction(session, 'update_branch', {
      branchId: branch.id, name: input.name, address: input.address, reference: input.reference, lat: input.lat, lng: input.lng,
    }, `Editar sucursal "${branch.name}": ${changes.join(', ')}`, user);
  }

  async toolDeleteBranch(input: any, user: any, session: any): Promise<string> {
    if (!this.isCallerAdminForCompany(user, user.activeCompanyId || user.companyId)) {
      return JSON.stringify({ error: 'Solo admin/gerente pueden eliminar sucursales.' });
    }
    const companyId = user.activeCompanyId || user.companyId;
    const branch = await this.prisma.branch.findFirst({
      where: { id: input.branchId, companyId, active: true },
      select: { id: true, name: true },
    });
    if (!branch) return JSON.stringify({ error: 'Sucursal no encontrada.' });
    return this.stageAction(session, 'delete_branch', { branchId: branch.id, branchName: branch.name },
      `Desactivar sucursal "${branch.name}"`, user);
  }

  // ======================== ASSIGNMENT SUGGESTIONS =======================

  async toolGetAssignmentSuggestions(input: any, user: any): Promise<string> {
    const companyType = this.resolveCompanyType(user);
    if (!companyType.includes('plant')) {
      return JSON.stringify({ error: 'Solo usuarios de tipo planta pueden obtener sugerencias de asignación.' });
    }

    if (!input.freightId) {
      return JSON.stringify({ error: 'Se requiere el freightId del flete.' });
    }

    try {
      const result = await this.assignmentSuggestions.getSuggestions(input.freightId, user.sub || user.id);

      if (result.suggestions.length === 0) {
        return JSON.stringify({ message: 'No encontré opciones de transporte disponibles para este flete.' });
      }

      const lines = [`🏆 Sugerencias para flete ${result.freightCode}:\n`];
      result.suggestions.forEach((s, i) => {
        const label = s.type === 'own_fleet' ? `Flota propia (${s.plate || 'sin patente'})` : s.companyName;
        lines.push(`${i + 1}. ${label} (${s.score} pts) — ${s.reasons.slice(0, 3).join(' · ')}`);
        if (s.plate && s.type !== 'own_fleet') lines.push(`   Camión: ${s.plate}${s.driverName ? ` · ${s.driverName}` : ''}`);
      });
      lines.push(`\n¿Querés que asigne a alguno? Decime el número o el nombre.`);

      return JSON.stringify({
        message: lines.join('\n'),
        suggestions: result.suggestions.map(s => ({
          companyId: s.companyId,
          companyName: s.companyName,
          truckId: s.truckId,
          plate: s.plate,
          score: s.score,
          type: s.type,
        })),
        freightId: result.freightId,
      });
    } catch (e) {
      return JSON.stringify({ error: e.message || 'Error al obtener sugerencias.' });
    }
  }
}
