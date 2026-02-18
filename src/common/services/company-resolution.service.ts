// =====================================================================
// TOLVINK — Shared Company Resolution Service
// Single source of truth for resolving user → company relationships
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class CompanyResolutionService {
  constructor(private prisma: PrismaService) {}

  /**
   * All company IDs a user belongs to (from UserCompany memberships).
   * Falls back to legacy companyByType JSON if no memberships found.
   */
  async resolveAllCompanyIds(user: { sub: string; companyId?: string }): Promise<string[]> {
    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);

    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      select: { companyId: true },
    });
    for (const m of memberships) ids.add(m.companyId);

    // Fallback: legacy companyByType JSON (transition period)
    if (ids.size <= 1) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { companyId: true, companyByType: true },
      });
      if (dbUser?.companyId) ids.add(dbUser.companyId);
      const cbt = (dbUser?.companyByType as any) || {};
      Object.values(cbt).forEach((v: any) => { if (v) ids.add(v); });
    }

    return Array.from(ids);
  }

  /**
   * Resolve producer company ID for the user.
   * Checks memberships for a company of type 'producer'.
   */
  async resolveProducerCompanyId(user: { sub: string; companyId?: string; companyType?: string }): Promise<string> {
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });
    const producerMembership = memberships.find((m: any) => m.company?.type === 'producer');
    if (producerMembership) return producerMembership.companyId;
    if (user.companyType === 'producer' && user.companyId) return user.companyId;
    return user.companyId || '';
  }

  /**
   * Resolve plant company ID for the user.
   * Checks memberships for a company of type 'plant'.
   */
  async resolvePlantCompanyId(user: { sub: string; companyId?: string }): Promise<string> {
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });
    const plantMembership = memberships.find((m: any) => m.company?.type === 'plant');
    if (plantMembership) return plantMembership.companyId;
    return user.companyId || '';
  }

  /**
   * Check if user has a specific company type (from JWT or memberships).
   */
  async hasCompanyType(user: { sub: string; companyType?: string }, type: string): Promise<boolean> {
    if (user.companyType === type) return true;
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { type: true } } },
    });
    return memberships.some((m: any) => m.company?.type === type);
  }

  /**
   * Resolve the effective company type for a user (from JWT or first membership).
   */
  async resolveCompanyType(user: { sub: string; companyType?: string }): Promise<string> {
    if (user.companyType) return user.companyType;
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { type: true } } },
    });
    if (memberships.length > 0) return memberships[0].company?.type || 'unknown';
    return 'unknown';
  }

  /**
   * Resolve all producer company IDs (for fields service).
   * Includes admin fallback logic.
   */
  async resolveAllProducerCompanyIds(user: { sub: string; companyId?: string; role?: string }): Promise<string[]> {
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });

    const ids = new Set<string>();
    const isAdmin = user.role === 'admin' || user.role === 'platform_admin' || user.role === 'gerente';

    for (const m of memberships) {
      if (m.company?.type === 'producer' || isAdmin) {
        ids.add(m.companyId);
      }
    }

    // Fallback: primary companyId if no memberships
    if (ids.size === 0 && user.companyId) {
      ids.add(user.companyId);
    }

    return Array.from(ids);
  }
}
