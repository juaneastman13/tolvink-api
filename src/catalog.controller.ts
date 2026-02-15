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
  @ApiOperation({ summary: 'Listar plantas activas' })
  async plants() {
    return this.prisma.plant.findMany({
      where: { active: true },
      select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
      orderBy: { name: 'asc' },
    });
  }

  @Get('lots')
  @ApiOperation({ summary: 'Listar lotes del usuario' })
  async lots(@CurrentUser() user: any) {
    const where: any = { active: true };
    // Non-platform users only see their company's lots
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
