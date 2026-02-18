// =====================================================================
// TOLVINK — Shared Company Resolution Service
// With per-request caching via AsyncLocalStorage
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { requestCache } from '../request-cache';

@Injectable()
export class CompanyResolutionService {
  constructor(private prisma: PrismaService) {}

  private getCache(): Map<string, any> | undefined {
    return requestCache.getStore();
  }

  async resolveAllCompanyIds(user: { sub: string; companyId?: string }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);

    // Parallel: memberships + user data in single round-trip
    const [memberships, dbUser] = await Promise.all([
      (this.prisma as any).userCompany.findMany({
        where: { userId: user.sub, active: true },
        select: { companyId: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { companyId: true, companyByType: true },
      }),
    ]);
    for (const m of memberships) ids.add(m.companyId);
    if (dbUser?.companyId) ids.add(dbUser.companyId);
    const cbt = (dbUser?.companyByType as any) || {};
    Object.values(cbt).forEach((v: any) => { if (v) ids.add(v); });

    const result = Array.from(ids);
    cache?.set(key, result);
    return result;
  }

  async resolveProducerCompanyId(user: { sub: string; companyId?: string; companyType?: string }): Promise<string> {
    const cache = this.getCache();
    const key = `producerId:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });
    const pm = memberships.find((m: any) => m.company?.type === 'producer');
    const result = pm?.companyId || (user.companyType === 'producer' && user.companyId ? user.companyId : user.companyId || '');

    cache?.set(key, result);
    return result;
  }

  async resolvePlantCompanyId(user: { sub: string; companyId?: string }): Promise<string> {
    const cache = this.getCache();
    const key = `plantId:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });
    const pm = memberships.find((m: any) => m.company?.type === 'plant');
    const result = pm?.companyId || user.companyId || '';

    cache?.set(key, result);
    return result;
  }

  async hasCompanyType(user: { sub: string; companyType?: string }, type: string): Promise<boolean> {
    if (user.companyType === type) return true;
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { type: true } } },
    });
    return memberships.some((m: any) => m.company?.type === type);
  }

  async resolveCompanyType(user: { sub: string; companyType?: string }): Promise<string> {
    if (user.companyType) return user.companyType;
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { type: true } } },
    });
    if (memberships.length > 0) return memberships[0].company?.type || 'unknown';
    return 'unknown';
  }

  async resolveAllProducerCompanyIds(user: { sub: string; companyId?: string; role?: string }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allProducerIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: user.sub, active: true },
      include: { company: { select: { id: true, type: true } } },
    });

    const ids = new Set<string>();
    const isAdmin = user.role === 'admin' || user.role === 'platform_admin' || user.role === 'gerente';

    for (const m of memberships) {
      if (m.company?.type === 'producer' || isAdmin) ids.add(m.companyId);
    }

    if (ids.size === 0 && user.companyId) ids.add(user.companyId);

    const result = Array.from(ids);
    cache?.set(key, result);
    return result;
  }
}
