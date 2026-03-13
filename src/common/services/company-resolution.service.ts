// =====================================================================
// TOLVINK — Shared Company Resolution Service
// With per-request caching via AsyncLocalStorage
// =====================================================================

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { requestCache } from '../request-cache';
import { getCompanyTypes, companyHasType } from '../company-type-helpers';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class CompanyResolutionService {
  constructor(private prisma: PrismaService) {}

  private getCache(): Map<string, any> | undefined {
    return requestCache.getStore();
  }

  // Company type helpers now imported from '../company-type-helpers'

  /** Shared: fetch memberships with company type once per request.
   *  Deduplicates concurrent calls within the same request (e.g. parallel catalog sub-calls). */
  private async getMemberships(userId: string): Promise<any[]> {
    const cache = this.getCache();
    const key = `memberships:${userId}`;
    if (cache?.has(key)) return cache.get(key);

    // Store the promise so parallel callers within the same request await the same query
    const promiseKey = `_p:${key}`;
    if (cache?.has(promiseKey)) return cache.get(promiseKey);

    const promise = (this.prisma as any).userCompany.findMany({
      where: { userId, active: true },
      include: { company: { select: { id: true, type: true, types: true } } },
    }).then((memberships: any[]) => {
      cache?.set(key, memberships);
      cache?.delete(promiseKey);
      return memberships;
    });
    cache?.set(promiseKey, promise);
    return promise;
  }

  async resolveAllCompanyIds(user: { sub: string; companyId?: string; companyByType?: any }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);

    // Fast path: if companyByType is already available (e.g. from WhatsApp synthetic user or enriched JWT),
    // extract IDs and only query memberships (skip the user DB query)
    const jwtCbt = (user as any).companyByType;
    if (jwtCbt && typeof jwtCbt === 'object' && Object.keys(jwtCbt).length > 0) {
      // Validate JWT company IDs against current memberships to filter stale entries
      const memberships = await this.getMemberships(user.sub);
      const memberCompanyIds = new Set(memberships.map(m => m.companyId));
      Object.values(jwtCbt).forEach((v: any) => { if (v && typeof v === 'string' && UUID_RE.test(v) && memberCompanyIds.has(v)) ids.add(v); });
      for (const m of memberships) ids.add(m.companyId);
      const result = Array.from(ids);
      cache?.set(key, result);
      return result;
    }

    // Full path: query both memberships and user record
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
    Object.values(cbt).forEach((v: any) => { if (v && typeof v === 'string' && UUID_RE.test(v)) ids.add(v); });

    const result = Array.from(ids);
    cache?.set(key, result);
    return result;
  }

  async resolveProducerCompanyId(user: { sub: string; companyId?: string; companyType?: string; activeCompanyId?: string }): Promise<string | null> {
    const activeId = (user as any).activeCompanyId || user.companyId;
    const cache = this.getCache();
    const key = `producerId:${user.sub}:${activeId || ''}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await this.getMemberships(user.sub);
    const isProducer = (m: any) => companyHasType(m.company, 'producer');

    // Prioritize activeCompanyId / companyId if it's a producer
    if (activeId) {
      const activeMem = memberships.find((m: any) => m.companyId === activeId && isProducer(m));
      if (activeMem) { cache?.set(key, activeMem.companyId); return activeMem.companyId; }
    }
    // Fallback: first producer membership
    const pm = memberships.find(isProducer);
    const result = pm?.companyId || null;

    cache?.set(key, result);
    return result;
  }

  async resolvePlantCompanyId(user: { sub: string; companyId?: string; activeCompanyId?: string }): Promise<string | null> {
    const activeId = (user as any).activeCompanyId || user.companyId;
    const cache = this.getCache();
    const key = `plantId:${user.sub}:${activeId || ''}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await this.getMemberships(user.sub);
    const isPlant = (m: any) => companyHasType(m.company, 'plant');

    // Prioritize activeCompanyId / companyId if it's a plant
    if (activeId) {
      const activeMem = memberships.find((m: any) => m.companyId === activeId && isPlant(m));
      if (activeMem) { cache?.set(key, activeMem.companyId); return activeMem.companyId; }
    }
    // Fallback: first plant membership
    const pm = memberships.find(isPlant);
    const result = pm?.companyId || null;

    cache?.set(key, result);
    return result;
  }

  async hasCompanyType(user: { sub: string; companyType?: string }, type: string): Promise<boolean> {
    const cache = this.getCache();
    const key = `hasType:${user.sub}:${type}`;
    if (cache?.has(key)) return cache.get(key);

    if (user.companyType === type) { cache?.set(key, true); return true; }
    const memberships = await this.getMemberships(user.sub);
    // Check both company.type and company.types[] array for multi-type support
    const result = memberships.some((m: any) => companyHasType(m.company, type));
    cache?.set(key, result);
    return result;
  }

  async resolveCompanyType(user: { sub: string; companyType?: string }): Promise<string> {
    const cache = this.getCache();
    const key = `companyType:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    // Always verify against DB — JWT companyType may be stale
    const memberships = await this.getMemberships(user.sub);
    // Prefer types[] array if available, fallback to type field
    if (memberships.length > 0) {
      const types = getCompanyTypes(memberships[0].company);
      const result = types[0] || memberships[0].company?.type || 'unknown';
      cache?.set(key, result);
      return result;
    }
    cache?.set(key, 'unknown');
    return 'unknown';
  }

  async resolveAllProducerCompanyIds(user: { sub: string; companyId?: string; role?: string }): Promise<string[]> {
    const cache = this.getCache();
    const key = `allProducerIds:${user.sub}`;
    if (cache?.has(key)) return cache.get(key);

    const memberships = await this.getMemberships(user.sub);
    const ids = new Set<string>();
    const isAdmin = user.role === 'admin' || user.role === 'platform_admin' || user.role === 'gerente';

    for (const m of memberships) {
      // Check both type and types[] for multi-type support
      const isProducer = companyHasType(m.company, 'producer');
      if (isProducer || isAdmin) ids.add(m.companyId);
    }
    if (ids.size === 0 && user.companyId) ids.add(user.companyId);

    const result = Array.from(ids);
    cache?.set(key, result);
    return result;
  }
}
