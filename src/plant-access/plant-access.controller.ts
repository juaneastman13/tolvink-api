// =====================================================================
// TOLVINK — PlantProducerAccess Controller + Service
// Plants enable/disable which producer USERS can send freights
// Platform admins can manage access for ALL companies
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class GrantAccessDto {
  @ApiProperty({ description: 'ID del usuario productor' })
  @IsUUID()
  producerUserId: string;

  @ApiProperty({ description: 'ID de empresa productora' })
  @IsUUID()
  producerCompanyId: string;

  @ApiProperty({ description: 'IDs de plantas habilitadas', type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowedPlantIds?: string[];

  @ApiProperty({ description: 'IDs de sucursales habilitadas', type: [String], required: false })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  allowedBranchIds?: string[];

  @ApiProperty({ description: 'ID de empresa planta (solo admin general)', required: false })
  @IsOptional()
  @IsUUID()
  plantCompanyId?: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class PlantAccessService {
  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  private isPlatformAdmin(user: any): boolean {
    return user.role === 'platform_admin';
  }

  /** Resolve the plant company ID — delegates to shared service */
  private async resolvePlantCompanyId(user: any, overrideId?: string): Promise<string> {
    if (this.isPlatformAdmin(user) && overrideId) return overrideId;
    return this.companyRes.resolvePlantCompanyId(user);
  }

  async searchUsers(query: string, type: string = 'producer') {
    if (!query || query.trim().length < 2) return [];

    const q = query.trim();
    const users = await this.prisma.user.findMany({
      where: {
        active: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
          { phone: { contains: q } },
        ],
      },
      take: 15,
      orderBy: { name: 'asc' },
    });

    if (users.length === 0) return [];

    // Batch query: all memberships for matched users in ONE query (fixes N+1)
    const userIds = users.map(u => u.id);
    const memberships = await (this.prisma as any).userCompany.findMany({
      where: { userId: { in: userIds }, active: true },
      include: { company: { select: { id: true, name: true, type: true } } },
    });

    const membershipMap = new Map<string, any[]>();
    for (const m of memberships) {
      if (!membershipMap.has(m.userId)) membershipMap.set(m.userId, []);
      membershipMap.get(m.userId)!.push(m);
    }

    const results: any[] = [];
    for (const user of users) {
      const userMemberships = membershipMap.get(user.id) || [];
      const typedMembership = userMemberships.find((m: any) => m.company?.type === type);

      if (typedMembership) {
        results.push({
          userId: user.id,
          userName: user.name,
          phone: user.phone,
          email: user.email,
          producerCompanyId: typedMembership.companyId,
          producerCompanyName: typedMembership.company?.name || '',
        });
      }
    }

    return results;
  }

  async grantAccess(dto: GrantAccessDto, user: any) {
    const isAdmin = this.isPlatformAdmin(user);
    const plantCoId = isAdmin && dto.plantCompanyId
      ? dto.plantCompanyId
      : await this.resolvePlantCompanyId(user);

    // Validate user exists and is a producer or transporter
    const producerUser = await this.prisma.user.findUnique({
      where: { id: dto.producerUserId },
      select: { id: true, userTypes: true },
    });
    if (!producerUser) throw new BadRequestException('Usuario no encontrado');
    const userTypes = (producerUser.userTypes as string[]) || [];
    if (!userTypes.includes('producer') && !userTypes.includes('transporter')) throw new BadRequestException('El usuario no es productor ni transportista');

    const newPlantIds = dto.allowedPlantIds || [];
    const newBranchIds = dto.allowedBranchIds || [];

    if (newPlantIds.length) {
      // Admin skips company ownership check on plants
      const whereClause: any = { id: { in: newPlantIds }, active: true };
      if (!isAdmin) whereClause.companyId = plantCoId;
      const validCount = await this.prisma.plant.count({ where: whereClause });
      if (validCount !== newPlantIds.length) {
        throw new BadRequestException('Algunas plantas no son válidas');
      }
    }

    if (newBranchIds.length) {
      const whereClause: any = { id: { in: newBranchIds }, active: true };
      if (!isAdmin) whereClause.companyId = plantCoId;
      const validCount = await this.prisma.branch.count({ where: whereClause });
      if (validCount !== newBranchIds.length) {
        throw new BadRequestException('Algunas sucursales no son válidas');
      }
    }

    // Check existing access by user (new unique constraint)
    const existing = await this.prisma.plantProducerAccess.findUnique({
      where: {
        plantCompanyId_producerUserId: {
          plantCompanyId: plantCoId,
          producerUserId: dto.producerUserId,
        },
      },
    });

    if (existing) {
      const existingPlants = (existing.allowedPlantIds as string[]) || [];
      const existingBranches = (existing.allowedBranchIds as string[]) || [];
      const mergedPlants = [...new Set([...existingPlants, ...newPlantIds])];
      const mergedBranches = [...new Set([...existingBranches, ...newBranchIds])];

      return this.prisma.plantProducerAccess.update({
        where: { id: existing.id },
        data: {
          active: true,
          allowedPlantIds: mergedPlants,
          allowedBranchIds: mergedBranches,
        },
      });
    }

    return this.prisma.plantProducerAccess.create({
      data: {
        plantCompanyId: plantCoId,
        producerCompanyId: dto.producerCompanyId,
        producerUserId: dto.producerUserId,
        active: true,
        allowedPlantIds: newPlantIds,
        allowedBranchIds: newBranchIds,
      },
    });
  }

  async revokeAccess(accessId: string, user: any) {
    const access = await this.prisma.plantProducerAccess.findUnique({
      where: { id: accessId },
    });
    if (!access) throw new NotFoundException('Relación no encontrada');

    // Platform admin can revoke any access; plant users only their own
    if (!this.isPlatformAdmin(user)) {
      const plantCoId = await this.resolvePlantCompanyId(user);
      if (access.plantCompanyId !== plantCoId) {
        throw new NotFoundException('Relación no encontrada');
      }
    }

    return this.prisma.plantProducerAccess.update({
      where: { id: access.id },
      data: { active: false },
    });
  }

  async listForPlant(user: any, plantCompanyId?: string, producerCompanyId?: string) {
    const isAdmin = this.isPlatformAdmin(user);
    const where: any = {};

    if (plantCompanyId) where.plantCompanyId = plantCompanyId;
    if (producerCompanyId) where.producerCompanyId = producerCompanyId;

    // Admin with no filters: return access records (limited)
    if (isAdmin && !plantCompanyId && !producerCompanyId) {
      return this.prisma.plantProducerAccess.findMany({
        include: {
          plantCompany: { select: { id: true, name: true } },
          producerCompany: { select: { id: true, name: true, email: true, type: true } },
          producerUser: { select: { id: true, name: true, email: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
    }

    // Non-admin without specific plant → use their own plant company
    if (!isAdmin && !plantCompanyId) {
      where.plantCompanyId = await this.resolvePlantCompanyId(user);
    }

    return this.prisma.plantProducerAccess.findMany({
      where,
      include: {
        plantCompany: { select: { id: true, name: true } },
        producerCompany: { select: { id: true, name: true, email: true, type: true } },
        producerUser: { select: { id: true, name: true, email: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForProducer(user: any) {
    // Query by user ID directly — no company resolution needed
    return this.prisma.plantProducerAccess.findMany({
      where: { producerUserId: user.sub, active: true },
      include: { plantCompany: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyFacilities(user: any, plantCompanyId?: string) {
    const isAdmin = this.isPlatformAdmin(user);

    // Admin with no specific company: return ALL plants and branches
    if (isAdmin && !plantCompanyId) {
      const [plants, branches] = await Promise.all([
        this.prisma.plant.findMany({
          where: { active: true },
          select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.branch.findMany({
          where: { active: true },
          select: { id: true, name: true, address: true, lat: true, lng: true, companyId: true },
          orderBy: { name: 'asc' },
        }),
      ]);
      return { plants, branches };
    }

    const plantCoId = isAdmin && plantCompanyId
      ? plantCompanyId
      : await this.resolvePlantCompanyId(user);

    const [plants, branches] = await Promise.all([
      this.prisma.plant.findMany({
        where: { companyId: plantCoId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.branch.findMany({
        where: { companyId: plantCoId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return { plants, branches };
  }

  async listPlantCompanies() {
    return this.prisma.company.findMany({
      where: { type: 'plant' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Plant Access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('plant-access')
export class PlantAccessController {
  constructor(private service: PlantAccessService) {}

  @Get('plant-companies')
  @Roles('platform_admin')
  @ApiOperation({ summary: 'Listar empresas tipo planta (solo admin general)' })
  listPlantCompanies() {
    return this.service.listPlantCompanies();
  }

  @Get('search-producer')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Buscar usuarios por nombre, email o teléfono' })
  @ApiQuery({ name: 'q', required: true })
  @ApiQuery({ name: 'type', required: false })
  searchProducer(@Query('q') q: string, @Query('type') type?: string) {
    if (!q?.trim() || q.trim().length < 2) throw new BadRequestException('Ingresá al menos 2 caracteres');
    return this.service.searchUsers(q.trim(), type || 'producer');
  }

  @Get('my-facilities')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Plantas y sucursales de mi empresa (o de empresa indicada para admin)' })
  @ApiQuery({ name: 'plantCompanyId', required: false })
  myFacilities(@CurrentUser() user: any, @Query('plantCompanyId') plantCompanyId?: string) {
    return this.service.getMyFacilities(user, plantCompanyId);
  }

  @Post('grant')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Habilitar usuario productor' })
  grant(@Body() dto: GrantAccessDto, @CurrentUser() user: any) {
    return this.service.grantAccess(dto, user);
  }

  @Patch('revoke/:accessId')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Revocar acceso de usuario productor' })
  revoke(@Param('accessId', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.revokeAccess(id, user);
  }

  @Get('producers')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Listar productores habilitados' })
  @ApiQuery({ name: 'plantCompanyId', required: false })
  @ApiQuery({ name: 'producerCompanyId', required: false })
  listProducers(@CurrentUser() user: any, @Query('plantCompanyId') plantCompanyId?: string, @Query('producerCompanyId') producerCompanyId?: string) {
    return this.service.listForPlant(user, plantCompanyId, producerCompanyId);
  }

  @Get('plants')
  @Roles('producer')
  @ApiOperation({ summary: 'Listar plantas habilitadas (vista productor)' })
  listPlants(@CurrentUser() user: any) {
    return this.service.listForProducer(user);
  }
}
