import { Controller, Get, Query, UseGuards, OnModuleDestroy } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { CompanyResolutionService } from './common/services/company-resolution.service';
import { hydrateTolvinkPlantLocality } from './common/tolvink-plant-locality';
import { PrismaService } from './database/prisma.service';

const MAX_CATALOG = 500;

// Module-level ref so clearTransportCache() works without a class instance
let _cacheRef: Map<string, { data: any; ts: number }> | null = null;

/** Invalidate access-sensitive cache entries (called after access changes) */
export function clearTransportCache() {
  if (!_cacheRef) return;
  for (const key of _cacheRef.keys()) {
    if (key.startsWith('transport:') || key.startsWith('lots:') || key.startsWith('plants:') || key.startsWith('tolvink-plants:') || key.startsWith('branches:') || key.startsWith('all:')) {
      _cacheRef.delete(key);
    }
  }
}

@ApiTags('Catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog')
export class CatalogController implements OnModuleDestroy {
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private cache = new Map<string, { data: any; ts: number }>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  private isMissingTolvinkLocalityColumn(error: any) {
    const message = String(error?.message || '');
    return error?.code === 'P2022' || (message.includes('locality') && message.includes('tolvink'));
  }

  private async findTolvinkPlantsSafe(take: number, skip: number) {
    try {
      const rows = await this.prisma.tolvinkPlant.findMany({
        where: { active: true },
        select: {
          id: true,
          sourceRowId: true,
          sourcePlantId: true,
          name: true,
          altName: true,
          department: true,
          locality: true,
          lat: true,
          lng: true,
        },
        orderBy: { name: 'asc' },
        take,
        skip,
      });
      return hydrateTolvinkPlantLocality(rows).map(({ sourceRowId, sourcePlantId, ...row }) => row);
    } catch (error) {
      if (!this.isMissingTolvinkLocalityColumn(error)) throw error;
      const rows = await this.prisma.tolvinkPlant.findMany({
        where: { active: true },
        select: {
          id: true,
          sourceRowId: true,
          sourcePlantId: true,
          name: true,
          altName: true,
          department: true,
          lat: true,
          lng: true,
        },
        orderBy: { name: 'asc' },
        take,
        skip,
      });
      return hydrateTolvinkPlantLocality(rows).map(({ sourceRowId, sourcePlantId, ...row }) => row);
    }
  }

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {
    _cacheRef = this.cache;
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (now - entry.ts > this.CACHE_TTL) this.cache.delete(key);
      }
    }, this.CACHE_TTL);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
    this.cache.clear();
  }

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.CACHE_TTL) return Promise.resolve(hit.data);
    return fn().then(data => {
      // Hard cap — evict stale then oldest if still over
      if (this.cache.size > 5000) {
        const now = Date.now();
        for (const [k, entry] of this.cache) {
          if (now - entry.ts > this.CACHE_TTL) this.cache.delete(k);
        }
        if (this.cache.size > 4000) {
          const iter = this.cache.keys();
          while (this.cache.size > 4000) {
            const k = iter.next().value;
            if (k) this.cache.delete(k); else break;
          }
        }
      }
      this.cache.set(key, { data, ts: Date.now() });
      return data;
    });
  }

  /** Check if user has ANY producer company (via all memberships) */
  private async hasProducerCompany(userId: string): Promise<boolean> {
    return this.companyRes.hasCompanyType({ sub: userId }, 'producer');
  }

  /** Check if user is a manager (gerente/admin) */
  private isManager(user: any): boolean {
    return ['admin', 'platform_admin', 'gerente'].includes(user.role);
  }

  @Get('plants')
  @ApiOperation({ summary: 'Listar plantas/empresas planta accesibles' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async plants(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `plants:${user.sub}:${user.companyId}:${user.role}:${s}:${t}`;

    return this.cached(key, async () => {
      const isProducer = await this.hasProducerCompany(user.sub);

      if (isProducer) {
        // Resolve all producer company IDs for this user (multi-company support)
        const producerCompanyIds = await this.companyRes.resolveAllProducerCompanyIds(user);
        if (producerCompanyIds.length === 0) return [];

        // Managers see ALL access for their companies; non-managers only their own
        const userFilter = this.isManager(user)
          ? {}
          : { OR: [{ producerUserId: null }, { producerUserId: user.sub }] as any[] };

        // LEGACY: PlantProducerAccess — to be migrated to CompanyAccess
        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: {
            producerCompanyId: { in: producerCompanyIds },
            active: true,
            ...userFilter,
          },
          select: { plantCompanyId: true },
          take: 200,
        });

        // CompanyAccess: plants that granted OPERATOR access to this producer
        // READONLY (CONSULTA) plants are excluded — user can't create freights to them
        const companyAccessRecords = await this.prisma.companyAccess.findMany({
          where: {
            granteeCompanyId: { in: producerCompanyIds },
            isActive: true,
            accessLevel: 'OPERATOR',
          },
          select: { grantorCompanyId: true },
          take: 200,
        });

        const companyIds = [...new Set([
          ...accessRecords.map(r => r.plantCompanyId),
          ...companyAccessRecords.map(r => r.grantorCompanyId),
        ])];
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

      // Plant user: only their own plant company as destination
      const isPlantUser = await this.companyRes.hasCompanyType(user, 'plant');
      if (isPlantUser) {
        const plantCoId = await this.companyRes.resolvePlantCompanyId(user);
        if (!plantCoId) return [];
        const allPlantIds = await this.companyRes.resolveAllCompanyIds(user);
        // Filter to only plant-type companies the user belongs to
        const ownPlants = await this.prisma.company.findMany({
          where: { id: { in: allPlantIds }, active: true, OR: [{ type: 'plant' }, { types: { array_contains: 'plant' } }] },
          select: { id: true, name: true, address: true, lat: true, lng: true },
          orderBy: { name: 'asc' },
          take: t,
          skip: s,
        });
        return ownPlants.map(c => ({
          id: c.id, name: c.name, address: c.address,
          lat: c.lat, lng: c.lng, companyId: c.id,
        }));
      }

      // Only platform_admin gets full plant list; others get empty
      if (user.role !== 'platform_admin') return [];
      const allCos = await this.prisma.company.findMany({
        where: { active: true, OR: [{ type: 'plant' }, { types: { array_contains: 'plant' } }] },
        select: { id: true, name: true, address: true, lat: true, lng: true, type: true, types: true },
        orderBy: { name: 'asc' },
        take: t + s,
      });
      const plantCos = allCos.filter(c => {
        const cTypes = Array.isArray(c.types) && (c.types as string[]).length > 0
          ? (c.types as string[]) : [c.type];
        return cTypes.includes('plant');
      });
      return plantCos.slice(s, s + t).map(c => ({
        id: c.id, name: c.name, address: c.address,
        lat: c.lat, lng: c.lng, companyId: c.id,
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
    const key = `branches:${user.sub}:${user.companyId}:${user.role}:${s}:${t}`;

    return this.cached(key, async () => {
      const isProducer = await this.hasProducerCompany(user.sub);

      if (isProducer) {
        const producerCompanyIds = await this.companyRes.resolveAllProducerCompanyIds(user);
        if (producerCompanyIds.length === 0) return [];

        const userFilter = this.isManager(user)
          ? {}
          : { OR: [{ producerUserId: null }, { producerUserId: user.sub }] as any[] };

        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: {
            producerCompanyId: { in: producerCompanyIds },
            active: true,
            ...userFilter,
          },
          select: { plantCompanyId: true, allowedBranchIds: true },
          take: 200,
        });

        // CompanyAccess: plants that granted OPERATOR access to this producer
        const caRecords = await this.prisma.companyAccess.findMany({
          where: { granteeCompanyId: { in: producerCompanyIds }, isActive: true, accessLevel: 'OPERATOR' },
          select: { grantorCompanyId: true },
          take: 200,
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
        // CompanyAccess grants full access to all branches of the plant
        for (const ca of caRecords) {
          fullAccessCompanyIds.push(ca.grantorCompanyId);
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
      const isPlant = await this.companyRes.hasCompanyType(user, 'plant');
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
    const key = `lots:${user.sub}:${user.companyId}:${user.role}:${s}:${t}`;

    return this.cached(key, async () => {
      if (user.role === 'platform_admin') {
        return this.prisma.lot.findMany({
          where: { active: true },
          select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true, fieldId: true, field: { select: { name: true } } },
          orderBy: { name: 'asc' },
          take: t,
          skip: s,
        });
      }

      const allIds = await this.companyRes.resolveAllCompanyIds(user);
      return this.prisma.lot.findMany({
        where: { active: true, companyId: { in: allIds } },
        select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true, fieldId: true, field: { select: { name: true } } },
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
    const key = `transport:${user.sub}:${user.companyId}:${s}:${t}`;

    return this.cached(key, async () => {
      const isPlant = await this.companyRes.hasCompanyType(user, 'plant');

      if (isPlant) {
        const plantCoId = await this.companyRes.resolvePlantCompanyId(user);
        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: { plantCompanyId: plantCoId, active: true },
          select: {
            producerCompanyId: true,
            producerUserId: true,
            producerUser: { select: { id: true, name: true, phone: true } },
          },
          take: 200,
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
        take: 200,
      });
      return all.filter(c => {
        const cTypes = Array.isArray(c.types) && (c.types as string[]).length > 0
          ? (c.types as string[]) : [c.type];
        return cTypes.includes('transporter');
      }).slice(s, s + t).map(c => ({ id: c.id, name: c.name, address: c.address, phone: c.phone }));
    });
  }

  @Get('tolvink-plants')
  @ApiOperation({ summary: 'Listar plantas del directorio Tolvink (Uruguay)' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async tolvinkPlants(@CurrentUser() user: any, @Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `tolvink-plants:${user.sub}:${s}:${t}`;

    return this.cached(key, async () => {
      return this.findTolvinkPlantsSafe(t, s);
    });
  }

  @Get('all')
  @ApiOperation({ summary: 'Catálogo consolidado — plants, branches, lots, transport-companies en un solo request' })
  async all(@CurrentUser() user: any) {
    const key = `all:${user.sub}:${user.companyId}:${user.role}`;

    return this.cached(key, async () => {
      const [plants, tolvinkPlants, branches, lots, transportCompanies] = await Promise.all([
        this.plants(user),
        this.tolvinkPlants(user),
        this.branches(user),
        this.lots(user),
        this.transportCompanies(user),
      ]);
      return { plants, tolvinkPlants, branches, lots, transportCompanies };
    });
  }
}
