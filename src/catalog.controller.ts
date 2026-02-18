import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { CompanyResolutionService } from './common/services/company-resolution.service';
import { PrismaService } from './database/prisma.service';

const MAX_CATALOG = 500;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const cache = new Map<string, { data: any; ts: number }>();

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
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

  /** Check if user is a producer type */
  private async isProducer(userId: string): Promise<boolean> {
    return this.companyRes.hasCompanyType({ sub: userId }, 'producer');
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
      const isProducer = await this.isProducer(user.sub);

      if (isProducer) {
        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: { producerUserId: user.sub, active: true },
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

      return this.prisma.plant.findMany({
        where: { active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
        take: t,
        skip: s,
      });
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
      const isProducer = await this.isProducer(user.sub);

      if (isProducer) {
        const accessRecords = await this.prisma.plantProducerAccess.findMany({
          where: { producerUserId: user.sub, active: true },
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

      // Admin or others: all branches (with limit)
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
  @ApiOperation({ summary: 'Listar empresas transportistas activas' })
  @ApiQuery({ name: 'take', required: false })
  @ApiQuery({ name: 'skip', required: false })
  async transportCompanies(@Query('take') take?: string, @Query('skip') skip?: string) {
    const t = Math.min(MAX_CATALOG, parseInt(take || String(MAX_CATALOG), 10) || MAX_CATALOG);
    const s = parseInt(skip || '0', 10) || 0;
    const key = `transport:${s}:${t}`;

    return cached(key, () => this.prisma.company.findMany({
      where: { type: 'transporter', active: true },
      select: { id: true, name: true, address: true, phone: true },
      orderBy: { name: 'asc' },
      take: t,
      skip: s,
    }));
  }
}
