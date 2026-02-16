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

  @Get('plants')
  @ApiOperation({ summary: 'Listar plantas activas (filtradas por acceso para productores)' })
  async plants(@CurrentUser() user: any) {
    // Producer users: only see plants they have access to
    if (user.companyType === 'producer') {
      const accessRecords = await this.prisma.plantProducerAccess.findMany({
        where: { producerCompanyId: user.companyId, active: true },
        select: { allowedPlantIds: true, plantCompanyId: true },
      });

      const allowedPlantIds: string[] = [];
      const fullAccessCompanyIds: string[] = [];

      for (const record of accessRecords) {
        const ids = (record.allowedPlantIds as string[]) || [];
        if (ids.length > 0) {
          allowedPlantIds.push(...ids);
        } else {
          // Backward compat: empty array = all plants from that company
          fullAccessCompanyIds.push(record.plantCompanyId);
        }
      }

      if (allowedPlantIds.length === 0 && fullAccessCompanyIds.length === 0) {
        return [];
      }

      const where: any = { active: true, OR: [] as any[] };
      if (allowedPlantIds.length > 0) {
        where.OR.push({ id: { in: [...new Set(allowedPlantIds)] } });
      }
      if (fullAccessCompanyIds.length > 0) {
        where.OR.push({ companyId: { in: fullAccessCompanyIds } });
      }

      return this.prisma.plant.findMany({
        where,
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
      });
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
    if (user.companyType === 'producer') {
      const accessRecords = await this.prisma.plantProducerAccess.findMany({
        where: { producerCompanyId: user.companyId, active: true },
        select: { allowedBranchIds: true },
      });

      const allowedBranchIds: string[] = [];
      for (const record of accessRecords) {
        const ids = (record.allowedBranchIds as string[]) || [];
        allowedBranchIds.push(...ids);
      }

      if (allowedBranchIds.length === 0) return [];

      return this.prisma.branch.findMany({
        where: { id: { in: [...new Set(allowedBranchIds)] }, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
      });
    }

    if (user.companyType === 'plant') {
      return this.prisma.branch.findMany({
        where: { companyId: user.companyId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
        orderBy: { name: 'asc' },
      });
    }

    return this.prisma.branch.findMany({
      where: { active: true },
      select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get('lots')
  @ApiOperation({ summary: 'Listar lotes del usuario' })
  async lots(@CurrentUser() user: any) {
    const where: any = { active: true };
    if (user.role !== 'platform_admin') {
      where.companyId = user.companyId;
    }
    return this.prisma.lot.findMany({
      where,
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
