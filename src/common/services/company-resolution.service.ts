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

  /** Shared: fetch memberships with company type once per request */
  private async getMemberships(userId: string): Promise<any[]> {
    const cache = this.getCache();
    const key = `memberships:${userId}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId, active: true },
      include: { company: { select: { id: true, type: true } } },
    });
    cache?.set(key, memberships);
    return memberships;
  }

  async resolveAllCompanyIds(user: { sub: string; companyId?: string }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);

    const [memberships, dbUser] = await Promise.all([
      this.getMemberships(user.sub),
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

    const memberships = await this.getMemberships(user.sub);
    const pm = memberships.find((m: any) => m.company?.type === 'producer');
    const result = pm?.companyId || (user.companyType === 'producer' && user.companyId ? user.companyId : user.companyId || '');

    cache?.set(key, result);
    return result;
  }

  async resolvePlantCompanyId(user: { sub: string; companyId?: string }): Promise<string> {
    const cache = this.getCache();
    const key = `plantId:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await this.getMemberships(user.sub);
    const pm = memberships.find((m: any) => m.company?.type === 'plant');
    const result = pm?.companyId || user.companyId || '';

    cache?.set(key, result);
    return result;
  }

  async hasCompanyType(user: { sub: string; companyType?: string }, type: string): Promise<boolean> {
    const cache = this.getCache();
    const key = `hasType:${user.sub}:${type}`;
    if (cache?.has(key)) return cache.get(key);

    if (user.companyType === type) { cache?.set(key, true); return true; }
    const memberships = await this.getMemberships(user.sub);
    const result = memberships.some((m: any) => m.company?.type === type);
    cache?.set(key, result);
    return result;
  }

  async resolveCompanyType(user: { sub: string; companyType?: string }): Promise<string> {
    const cache = this.getCache();
    const key = `companyType:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    if (user.companyType) { cache?.set(key, user.companyType); return user.companyType; }
    const memberships = await this.getMemberships(user.sub);
    const result = memberships.length > 0 ? memberships[0].company?.type || 'unknown' : 'unknown';
    cache?.set(key, result);
    return result;
  }

  async resolveAllProducerCompanyIds(user: { sub: string; companyId?: string; role?: string }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allProducerIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await this.getMemberships(user.sub);
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
