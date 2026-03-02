import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { CompanyResolutionService } from './common/services/company-resolution.service';
import { PrismaService } from './database/prisma.service';

const MAX_CATALOG = 500;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: any; ts: number }>();

// Periodic cleanup: evict stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts > CACHE_TTL) cache.delete(key);
  }
}, CACHE_TTL);

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

/** Invalidate all transport-related cache entries (called after access changes) */
export function clearTransportCache() {
  for (const key of cache.keys()) {
    if (key.startsWith('transport:')) cache.delete(key);
  }
}

@ApiTags('Catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  /** Check if user's ACTIVE company is a producer type (uses JWT companyType/companyTypes) */
  private isActiveProducer(user: any): boolean {
    const types: string[] = user.companyTypes || (user.companyType ? [user.companyType] : []);
    return types.includes('producer');
  }

  @Get('plants')
  @ApiOperation({ summary: 'Listar plantas/empresas planta accesibles' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async plants(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `plants:${user.sub}:${user.companyId}:${s}:${t}`;

    return cached(key, async () => {
      const isProducer = this.isActiveProducer(user);

      if (isProducer) {
        // Resolve all producer company IDs for this user (multi-company support)
        const producerCompanyIds = await this.companyRes.resolveAllProducerCompanyIds(user);
        if (producerCompanyIds.length === 0) return [];

        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: {
            producerCompanyId: { in: producerCompanyIds },
            active: true,
            OR: [{ producerUserId: null }, { producerUserId: user.sub }],
          },
          select: { plantCompanyId: true },
        });

        const companyIds = [...new Set(accessRecords.map(r => r.plantCompanyId))];
        if (companyIds.length === 0) return [];

        const companies = await this.prisma.company.findMany({
          where: { id: { in: companyIds }, active: true },
          select: { id: true, name: true, address: true, lat: true, lng: true },
          take: t,
          skip: s,
        });

        return companies.map(c => ({
          id: c.id,
          name: c.name,
          address: c.address,
          lat: c.lat,
          lng: c.lng,
          companyId: c.id,
        }));
      }

      // Non-producer (plant/other): return plant-type companies as destinations
      // (matching the Company-based format producers see)
      const allCos = await this.prisma.company.findMany({
        where: { active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, type: true, types: true },
        orderBy: { name: 'asc' },
      });
      const plantCos = allCos.filter(c => {
        const cTypes = Array.isArray(c.types) && (c.types as string[]).length > 0
          ? (c.types as string[]) : [c.type];
        return cTypes.includes('plant');
      });
      return plantCos.slice(s, s + t).map(c => ({
        id: c.id,
        name: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        companyId: c.id,
      }));
    });
  }

  @Get('branches')
  @ApiOperation({ summary: 'Listar sucursales accesibles' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async branches(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `branches:${user.sub}:${user.companyId}:${s}:${t}`;

    return cached(key, async () => {
      const isProducer = this.isActiveProducer(user);

      if (isProducer) {
        const producerCompanyIds = await this.companyRes.resolveAllProducerCompanyIds(user);
        if (producerCompanyIds.length === 0) return [];

        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: {
            producerCompanyId: { in: producerCompanyIds },
            active: true,
            OR: [{ producerUserId: null }, { producerUserId: user.sub }],
          },
          select: { plantCompanyId: true, allowedBranchIds: true },
        });

        const allowedBranchIds: string[] = [];
        const fullAccessCompanyIds: string[] = [];

        for (const record of accessRecords) {
          const ids = (record.allowedBranchIds as string[]) || [];
          if (ids.length > 0) {
            allowedBranchIds.push(...ids);
          } else {
            fullAccessCompanyIds.push(record.plantCompanyId);
          }
        }

        if (allowedBranchIds.length === 0 && fullAccessCompanyIds.length === 0) {
          return [];
        }

        const where: any = { active: true, OR: [] as any[] };
        if (allowedBranchIds.length > 0) {
          where.OR.push({ id: { in: [...new Set(allowedBranchIds)] } });
        }
        if (fullAccessCompanyIds.length > 0) {
          where.OR.push({ companyId: { in: fullAccessCompanyIds } });
        }

        return this.prisma.branch.findMany({
          where,
          select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
          orderBy: { name: 'asc' },
          take: t,
          skip: s,
        });
      }

      // Plant users: own branches via membership
      const activePlantTypes: string[] = user.companyTypes || (user.companyType ? [user.companyType] : []);
      const isPlant = activePlantTypes.includes('plant');
      if (isPlant) {
        const plantCoId = await this.companyRes.resolvePlantCompanyId(user);
        return this.prisma.branch.findMany({
          where: { companyId: plantCoId, active: true },
          select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
          orderBy: { name: 'asc' },
          take: t,
          skip: s,
        });
      }

      // Only platform_admin gets full branch list; others get empty
      if (user.role !== 'platform_admin') return [];
      return this.prisma.branch.findMany({
        where: { active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
        take: t,
        skip: s,
      });
    });
  }

  @Get('lots')
  @ApiOperation({ summary: 'Listar lotes del usuario' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async lots(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `lots:${user.sub}:${user.companyId}:${s}:${t}`;

    return cached(key, async () => {
      if (user.role === 'platform_admin') {
        return this.prisma.lot.findMany({
          where: { active: true },
          select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true },
          orderBy: { name: 'asc' },
          take: t,
          skip: s,
        });
      }

      const allIds = await this.companyRes.resolveAllCompanyIds(user);
      return this.prisma.lot.findMany({
        where: { active: true, companyId: { in: allIds } },
        select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
        take: t,
        skip: s,
      });
    });
  }

  @Get('transport-companies')
  @ApiOperation({ summary: 'Listar empresas transportistas con acceso a la planta' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async transportCompanies(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `transport:${user.companyId}:${s}:${t}`;

    return cached(key, async () => {
      const tTypes: string[] = user.companyTypes || (user.companyType ? [user.companyType] : []);
      const isPlant = tTypes.includes('plant');

      if (isPlant) {
        const plantCoId = await this.companyRes.resolvePlantCompanyId(user);
        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: { plantCompanyId: plantCoId, active: true },
          select: {
            producerCompanyId: true,
            producerUserId: true,
            producerUser: { select: { id: true, name: true, phone: true } },
          },
        });

        // Group by company: track company-wide vs user-specific access
        const companyAccess = new Map<string, { companyWide: boolean; users: any[] }>();
        for (const r of accessRecords) {
          if (!companyAccess.has(r.producerCompanyId)) {
            companyAccess.set(r.producerCompanyId, { companyWide: false, users: [] });
          }
          const entry = companyAccess.get(r.producerCompanyId)!;
          if (!r.producerUserId) {
            entry.companyWide = true;
          } else if (r.producerUser) {
            entry.users.push({ id: r.producerUser.id, name: r.producerUser.name, phone: r.producerUser.phone });
          }
        }

        const companyIds = [...companyAccess.keys()];
        if (companyIds.length === 0) return [];

        const companies = await this.prisma.company.findMany({
          where: { id: { in: companyIds }, active: true },
          select: { id: true, name: true, address: true, phone: true, type: true, types: true },
          orderBy: { name: 'asc' },
        });

        // Filter to companies that have transporter type (legacy or types[])
        const transportCompanies = companies.filter(c => {
          const cTypes = Array.isArray(c.types) && (c.types as string[]).length > 0
            ? (c.types as string[]) : [c.type];
          return cTypes.includes('transporter');
        });

        return transportCompanies.slice(s, s + t).map(c => {
          const access = companyAccess.get(c.id);
          return {
            id: c.id, name: c.name, address: c.address, phone: c.phone,
            companyWide: access?.companyWide || false,
            accessUsers: access?.companyWide ? [] : (access?.users || []),
          };
        });
      }

      // Only platform_admin gets full transporter list; others get empty
      if (user.role !== 'platform_admin') return [];
      const all = await this.prisma.company.findMany({
        where: { active: true },
        select: { id: true, name: true, address: true, phone: true, type: true, types: true },
        orderBy: { name: 'asc' },
      });
      return all.filter(c => {
        const cTypes = Array.isArray(c.types) && (c.types as string[]).length > 0
          ? (c.types as string[]) : [c.type];
        return cTypes.includes('transporter');
      }).slice(s, s + t).map(c => ({ id: c.id, name: c.name, address: c.address, phone: c.phone }));
    });
  }
}
