// =====================================================================
// TOLVINK — PlantProducerAccess Controller + Service
// Plants enable/disable which producers can send freights
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsArray } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class GrantAccessDto {
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
}

// ======================== SERVICE ====================================

@Injectable()
export class PlantAccessService {
  constructor(private prisma: PrismaService) {}

  async searchProducerByPhone(phone: string) {
    const user = await this.prisma.user.findFirst({
      where: { phone, active: true },
      include: {
        company: { select: { id: true, name: true, type: true } },
      },
    });

    if (!user) return { found: false, message: 'No se encontró usuario con ese teléfono' };

    const userTypes = (user.userTypes as string[]) || [];
    const cbt = (user.companyByType as any) || {};

    let producerCompanyId: string | null = null;
    let producerCompanyName: string | null = null;

    if (cbt.producer) {
      const company = await this.prisma.company.findUnique({
        where: { id: cbt.producer },
        select: { id: true, name: true, type: true },
      });
      if (company?.type === 'producer') {
        producerCompanyId = company.id;
        producerCompanyName = company.name;
      }
    }

    if (!producerCompanyId && user.company?.type === 'producer') {
      producerCompanyId = user.company.id;
      producerCompanyName = user.company.name;
    }

    if (!producerCompanyId || !userTypes.includes('producer')) {
      return { found: false, message: 'El usuario no tiene rol de productor' };
    }

    return {
      found: true,
      userId: user.id,
      userName: user.name,
      phone: user.phone,
      producerCompanyId,
      producerCompanyName,
    };
  }

  async grantAccess(dto: GrantAccessDto, user: any) {
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo plantas pueden gestionar accesos');
    }

    const producer = await this.prisma.company.findFirst({
      where: { id: dto.producerCompanyId, type: 'producer', active: true },
    });
    if (!producer) throw new BadRequestException('Empresa productora no encontrada');

    const newPlantIds = dto.allowedPlantIds || [];
    const newBranchIds = dto.allowedBranchIds || [];

    // Validate plant IDs belong to this company
    if (newPlantIds.length) {
      const validCount = await this.prisma.plant.count({
        where: { id: { in: newPlantIds }, companyId: user.companyId, active: true },
      });
      if (validCount !== newPlantIds.length) {
        throw new BadRequestException('Algunas plantas no pertenecen a tu empresa');
      }
    }

    // Validate branch IDs belong to this company
    if (newBranchIds.length) {
      const validCount = await this.prisma.branch.count({
        where: { id: { in: newBranchIds }, companyId: user.companyId, active: true },
      });
      if (validCount !== newBranchIds.length) {
        throw new BadRequestException('Algunas sucursales no pertenecen a tu empresa');
      }
    }

    // Check existing record for cumulative merge
    const existing = await this.prisma.plantProducerAccess.findUnique({
      where: {
        plantCompanyId_producerCompanyId: {
          plantCompanyId: user.companyId,
          producerCompanyId: dto.producerCompanyId,
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
        plantCompanyId: user.companyId,
        producerCompanyId: dto.producerCompanyId,
        active: true,
        allowedPlantIds: newPlantIds,
        allowedBranchIds: newBranchIds,
      },
    });
  }

  async revokeAccess(producerCompanyId: string, user: any) {
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo plantas pueden gestionar accesos');
    }

    const access = await this.prisma.plantProducerAccess.findUnique({
      where: {
        plantCompanyId_producerCompanyId: {
          plantCompanyId: user.companyId,
          producerCompanyId,
        },
      },
    });
    if (!access) throw new NotFoundException('Relación no encontrada');

    return this.prisma.plantProducerAccess.update({
      where: { id: access.id },
      data: { active: false },
    });
  }

  async listForPlant(user: any) {
    return this.prisma.plantProducerAccess.findMany({
      where: { plantCompanyId: user.companyId },
      include: { producerCompany: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listForProducer(user: any) {
    return this.prisma.plantProducerAccess.findMany({
      where: { producerCompanyId: user.companyId, active: true },
      include: { plantCompany: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getMyFacilities(user: any) {
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo plantas pueden consultar sus instalaciones');
    }

    const [plants, branches] = await Promise.all([
      this.prisma.plant.findMany({
        where: { companyId: user.companyId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.branch.findMany({
        where: { companyId: user.companyId, active: true },
        select: { id: true, name: true, address: true, lat: true, lng: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return { plants, branches };
  }

  async hasAccess(plantCompanyId: string, producerCompanyId: string): Promise<boolean> {
    const access = await this.prisma.plantProducerAccess.findUnique({
      where: {
        plantCompanyId_producerCompanyId: { plantCompanyId, producerCompanyId },
      },
    });
    return !!access?.active;
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Plant Access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('plant-access')
export class PlantAccessController {
  constructor(private service: PlantAccessService) {}

  @Get('search-producer')
  @Roles('plant')
  @ApiOperation({ summary: 'Buscar productor por teléfono' })
  searchProducer(@Query('phone') phone: string) {
    if (!phone?.trim()) throw new BadRequestException('Teléfono requerido');
    return this.service.searchProducerByPhone(phone.trim());
  }

  @Get('my-facilities')
  @Roles('plant')
  @ApiOperation({ summary: 'Plantas y sucursales de mi empresa' })
  myFacilities(@CurrentUser() user: any) {
    return this.service.getMyFacilities(user);
  }

  @Post('grant')
  @Roles('plant')
  @ApiOperation({ summary: 'Habilitar productor (solo planta)' })
  grant(@Body() dto: GrantAccessDto, @CurrentUser() user: any) {
    return this.service.grantAccess(dto, user);
  }

  @Patch('revoke/:producerCompanyId')
  @Roles('plant')
  @ApiOperation({ summary: 'Revocar acceso de productor' })
  revoke(@Param('producerCompanyId', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.revokeAccess(id, user);
  }

  @Get('producers')
  @Roles('plant')
  @ApiOperation({ summary: 'Listar productores habilitados (vista planta)' })
  listProducers(@CurrentUser() user: any) {
    return this.service.listForPlant(user);
  }

  @Get('plants')
  @Roles('producer')
  @ApiOperation({ summary: 'Listar plantas habilitadas (vista productor)' })
  listPlants(@CurrentUser() user: any) {
    return this.service.listForProducer(user);
  }
}
