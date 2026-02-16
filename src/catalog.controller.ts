import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { CurrentUser } from './common/decorators/current-user.decorator';
import { PrismaService } from './database/prisma.service';

@ApiTags('Catalog')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('catalog')
export class CatalogController {
  constructor(private prisma: PrismaService) {}

  /** Check if user is a producer type */
  private async isProducer(userId: string): Promise<boolean> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { userTypes: true },
    });
    const userTypes = (dbUser?.userTypes as string[]) || [];
    return userTypes.includes('producer');
  }

  /** Resolve all company IDs for multi-type users */
  private async resolveAllCompanyIds(user: any): Promise<string[]> {
    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { companyId: true, companyByType: true },
    });
    if (dbUser?.companyId) ids.add(dbUser.companyId);
    const cbt = (dbUser?.companyByType as any) || {};
    Object.values(cbt).forEach((v: any) => { if (v) ids.add(v); });
    return Array.from(ids);
  }

  @Get('plants')
  @ApiOperation({ summary: 'Listar plantas/empresas planta accesibles' })
  async plants(@CurrentUser() user: any) {
    const isProducer = await this.isProducer(user.sub);

    if (isProducer) {
      // Producers see the plant COMPANIES they have access to
      const accessRecords = await this.prisma.plantProducerAccess.findMany({
        where: { producerUserId: user.sub, active: true },
        select: { plantCompanyId: true },
      });

      const companyIds = [...new Set(accessRecords.map(r => r.plantCompanyId))];
      if (companyIds.length === 0) return [];

      const companies = await this.prisma.company.findMany({
        where: { id: { in: companyIds }, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true },
      });

      // Return formatted like plants — companyId = id since it IS the company
      return companies.map(c => ({
        id: c.id,
        name: c.name,
        address: c.address,
        lat: c.lat,
        lng: c.lng,
        companyId: c.id,
      }));
    }

    // Non-producer users: all active plants
    return this.prisma.plant.findMany({
      where: { active: true },
      select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get('branches')
  @ApiOperation({ summary: 'Listar sucursales accesibles' })
  async branches(@CurrentUser() user: any) {
    const isProducer = await this.isProducer(user.sub);

    if (isProducer) {
      // Producers: branches from plant companies they have access to
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
      });
    }

    // Plant users: own branches
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { userTypes: true, companyByType: true },
    });
    const userTypes = (dbUser?.userTypes as string[]) || [];
    const cbt = (dbUser?.companyByType as any) || {};

    if (userTypes.includes('plant') || user.companyType === 'plant') {
      const plantCoId = cbt.plant || user.companyId;
      return this.prisma.branch.findMany({
        where: { companyId: plantCoId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
      });
    }

    // Admin or others: all branches
    return this.prisma.branch.findMany({
      where: { active: true },
      select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get('lots')
  @ApiOperation({ summary: 'Listar lotes del usuario' })
  async lots(@CurrentUser() user: any) {
    if (user.role === 'platform_admin') {
      return this.prisma.lot.findMany({
        where: { active: true },
        select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
      });
    }

    const allIds = await this.resolveAllCompanyIds(user);
    return this.prisma.lot.findMany({
      where: { active: true, companyId: { in: allIds } },
      select: { id: true, name: true, hectares: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get('transport-companies')
  @ApiOperation({ summary: 'Listar empresas transportistas activas' })
  async transportCompanies() {
    return this.prisma.company.findMany({
      where: { type: 'transporter', active: true },
      select: { id: true, name: true, address: true, phone: true },
      orderBy: { name: 'asc' },
    });
  }
}
