// =====================================================================
// TOLVINK — PlantProducerAccess Controller + Service
// Plants enable/disable which producers can send freights
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
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
}

// ======================== SERVICE ====================================

@Injectable()
export class PlantAccessService {
  constructor(private prisma: PrismaService) {}

  async grantAccess(dto: GrantAccessDto, user: any) {
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo plantas pueden gestionar accesos');
    }

    // Validate producer exists
    const producer = await this.prisma.company.findFirst({
      where: { id: dto.producerCompanyId, type: 'producer', active: true },
    });
    if (!producer) throw new BadRequestException('Empresa productora no encontrada');

    // Upsert: create or reactivate
    return this.prisma.plantProducerAccess.upsert({
      where: {
        plantCompanyId_producerCompanyId: {
          plantCompanyId: user.companyId,
          producerCompanyId: dto.producerCompanyId,
        },
      },
      update: { active: true },
      create: {
        plantCompanyId: user.companyId,
        producerCompanyId: dto.producerCompanyId,
        active: true,
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

  // Utility: check if producer has access to a plant
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
