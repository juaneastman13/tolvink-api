import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  resolveCompanyTypes, resolveActiveRole, isProducerMembership, hasType,
} from '../ai.utils';
import { buildSyntheticUser } from '../../common/build-synthetic-user';

/**
 * Shared resolution/access-control helpers used across AI tool handlers.
 * Extracted from ai.service.ts to enable tool handler decomposition.
 */
@Injectable()
export class AiContextService {
  private readonly logger = new Logger(AiContextService.name);

  constructor(private prisma: PrismaService) {}

  // ======================== FREIGHT RESOLUTION ========================

  /** Resolve freight by exact code or fuzzy pattern, with access control. */
  async resolveFreightWithAccess(code: string, user: any): Promise<{ freight?: any; error?: string }> {
    if (!code || typeof code !== 'string') {
      return { error: 'Código de flete requerido.' };
    }

    const userCompanyId = user.activeCompanyId || user.companyId;
    const memberCompanyIds = (user.memberships || []).filter((m: any) => m.active).map((m: any) => m.companyId);
    const allUserCompanies = [userCompanyId, ...memberCompanyIds].filter(Boolean);

    let freight: any = await this.findFreightByCode(code.toUpperCase());

    if (!freight) {
      const sanitized = code.replace(/[^a-zA-Z0-9.\-]/g, '').toUpperCase();
      if (sanitized.length >= 3) {
        const candidates = await this.findFreightsByCodePattern(sanitized, allUserCompanies, user.id);
        if (candidates.length === 1) {
          freight = candidates[0];
        } else if (candidates.length > 1) {
          const codes = candidates.map((c: any) => c.code).join(', ');
          return { error: `Se encontraron varios fletes que coinciden con "${code}": ${codes}. Indique el código completo.` };
        }
      }
    }

    const ACCESS_DENIED = `No se encontró el flete ${code} o no tiene acceso.`;
    if (!freight) return { error: ACCESS_DENIED };

    const freightCompanies = [
      freight.originCompanyId, freight.destCompanyId,
      ...(freight.assignments || []).map((a: any) => a.transportCompanyId),
    ].filter(Boolean);
    const isDriver = (freight.assignments || []).some((a: any) => a.driverId === user.id);
    const isCompanyUser = allUserCompanies.some((c: string) => freightCompanies.includes(c));
    if (!isDriver && !isCompanyUser) {
      return { error: ACCESS_DENIED };
    }
    if (isDriver && !isCompanyUser) {
      freight.assignments = (freight.assignments || []).filter((a: any) => a.driverId === user.id);
    }
    return { freight };
  }

  /** Find freight by exact code. */
  async findFreightByCode(code: string) {
    return this.prisma.freight.findFirst({
      where: { code },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
    });
  }

  /** Find freights by partial code pattern — scoped to user's companies + driver assignments. */
  async findFreightsByCodePattern(pattern: string, userCompanyIds: string[], userId: string) {
    return this.prisma.freight.findMany({
      where: {
        code: { contains: pattern, mode: 'insensitive' },
        OR: [
          { originCompanyId: { in: userCompanyIds } },
          { destCompanyId: { in: userCompanyIds } },
          { assignments: { some: { transportCompanyId: { in: userCompanyIds } } } },
          { assignments: { some: { driverId: userId } } },
        ],
      },
      select: {
        id: true, code: true, status: true, truckCount: true, assignedTruckCount: true,
        isMultiTruck: true, destCompanyId: true, originCompanyId: true, useOwnFleet: true,
        assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { id: true, tripNumber: true, transportCompanyId: true, driverId: true, tripStatus: true, tons: true, truck: { select: { plate: true } }, driver: { select: { name: true } } } },
      },
      take: 5,
    });
  }

  /** Resolve specific assignment in a freight, or show interactive selection if multiple. */
  async resolveAssignment(code: string, assignmentId: string | undefined, user: any, session?: any): Promise<{ freight?: any; assignment?: any; error?: string }> {
    const accessResult = await this.resolveFreightWithAccess(code, user);
    if (accessResult.error) return { error: accessResult.error };
    const freight = accessResult.freight;

    if (!freight.isMultiTruck) {
      return { error: 'Para fletes single-truck, usar el endpoint correspondiente.' };
    }

    const activeAssignments = (freight.assignments || []).filter(
      (a: any) => ['active', 'accepted'].includes(a.tripStatus || a.status),
    );

    if (assignmentId) {
      const assignment = activeAssignments.find((a: any) => a.id === assignmentId);
      if (!assignment) return { error: 'Asignación no encontrada o no activa.' };
      return { freight, assignment };
    }

    if (activeAssignments.length === 0) return { error: 'No hay asignaciones activas.' };
    if (activeAssignments.length === 1) return { freight, assignment: activeAssignments[0] };

    return { error: `Hay ${activeAssignments.length} viajes activos. Indicá cuál (usá assignmentId).` };
  }

  // ======================== COMPANY / ROLE RESOLUTION ========================

  /** Resolve company type for the active company. */
  resolveCompanyType(user: any): string {
    const activeCoId = user.activeCompanyId || user.companyId;

    if (activeCoId && user.memberships?.length > 0) {
      const activeMem = user.memberships.find((m: any) => m.companyId === activeCoId);
      if (activeMem?.company) {
        const types = resolveCompanyTypes(activeMem.company);
        if (types.length > 0) return types.join(', ');
      }
    }

    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    if (userTypes.length > 0) return userTypes.join(', ');

    if (user.company) {
      const types = resolveCompanyTypes(user.company);
      if (types.length > 0) return types.join(', ');
    }

    if (user.memberships?.length > 0) {
      for (const m of user.memberships) {
        const types = resolveCompanyTypes(m.company);
        if (types.length > 0) return types.join(', ');
      }
    }
    return 'unknown';
  }

  /** Resolve producer company for a specific target companyId. */
  resolveProducerCompanyIdForCompany(user: any, targetCompanyId: string): string | null {
    if (user.memberships?.length > 0) {
      const targetMem = user.memberships.find((m: any) => m.companyId === targetCompanyId && isProducerMembership(m));
      if (targetMem) return targetMem.companyId;
    }
    return this.resolveProducerCompanyId(user);
  }

  /** Resolve producer company ID (active company priority). */
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
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('producer') && companyByType.producer) return companyByType.producer;
    if (resolveCompanyTypes(user.company).includes('producer')) return user.companyId;
    return null;
  }

  /** Resolve plant company ID (active company priority). */
  resolvePlantCompanyId(user: any): string | null {
    const isPlant = (m: any) =>
      m.company?.type === 'plant' ||
      (Array.isArray(m.company?.types) && m.company.types.includes('plant'));

    if (user.memberships?.length > 0) {
      const activeId = user.activeCompanyId;
      if (activeId) {
        const activeMem = user.memberships.find((m: any) => m.companyId === activeId && isPlant(m));
        if (activeMem) return activeMem.companyId;
      }
      const pm = user.memberships.find(isPlant);
      if (pm) return pm.companyId;
    }
    const userTypes = Array.isArray(user.userTypes) ? user.userTypes : [];
    const companyByType = (user.companyByType as any) || {};
    if (userTypes.includes('plant') && companyByType.plant) return companyByType.plant;
    if (resolveCompanyTypes(user.company).includes('plant')) return user.companyId;
    return null;
  }

  /** Check if caller is admin/gerente — scoped to specific company. */
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

  /** Check if caller has access to the given company (any role). */
  canAccessCompany(user: any, synUser: any, companyId: string): boolean {
    const ids = [synUser.companyId, ...(user.memberships || []).filter((m: any) => m.active !== false).map((m: any) => m.companyId)].filter(Boolean);
    return ids.includes(companyId);
  }

  /** Build a synthetic user object from a full DB user. */
  buildSyntheticUser(dbUser: any): any {
    return buildSyntheticUser(dbUser);
  }
}
