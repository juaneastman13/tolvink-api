// =====================================================================
// TOLVINK — Trucks Controller + Service
// CRUD for fleet (camiones)
// Transporters and Producers with own fleet can manage trucks
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, MaxLength, IsUUID, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class CreateTruckDto {
  @ApiProperty({ example: 'ABC-123' })
  @IsNotEmpty()
  @MaxLength(20)
  plate: string;

  @ApiProperty({ required: false, example: 'Scania R500' })
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @ApiProperty({ required: false, description: 'UUID del chofer asignado' })
  @IsOptional()
  @IsUUID()
  assignedUserId?: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class TrucksService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateTruckDto, user: any) {
    // Allow transporters and producers
    if (user.companyType !== 'transporter' && user.companyType !== 'producer') {
      throw new ForbiddenException('Solo transportistas o productores pueden crear camiones');
    }

    // Check unique plate
    const existing = await this.prisma.truck.findUnique({ where: { plate: dto.plate.toUpperCase() } });
    if (existing) throw new BadRequestException(`La patente ${dto.plate} ya está registrada`);

    // Validate assigned user belongs to same company
    if (dto.assignedUserId) {
      const driver = await this.prisma.user.findFirst({
        where: { id: dto.assignedUserId, companyId: user.companyId, active: true },
      });
      if (!driver) throw new BadRequestException('Chofer no encontrado en tu empresa');
    }

    return this.prisma.truck.create({
      data: {
        plate: dto.plate.toUpperCase(),
        model: dto.model,
        companyId: user.companyId,
        assignedUserId: dto.assignedUserId,
      },
      include: { assignedUser: { select: { id: true, name: true } } },
    });
  }

  async list(user: any) {
    return this.prisma.truck.findMany({
      where: { companyId: user.companyId, active: true },
      include: { assignedUser: { select: { id: true, name: true } } },
      orderBy: { plate: 'asc' },
    });
  }

  async deactivate(truckId: string, user: any) {
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, companyId: user.companyId },
    });
    if (!truck) throw new NotFoundException('Camión no encontrado');

    return this.prisma.truck.update({
      where: { id: truckId },
      data: { active: false },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Trucks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('trucks')
export class TrucksController {
  constructor(private service: TrucksService) {}

  @Post()
  @Roles('transporter', 'producer')
  @ApiOperation({ summary: 'Registrar camión' })
  create(@Body() dto: CreateTruckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('transporter', 'producer')
  @ApiOperation({ summary: 'Listar camiones de la empresa' })
  list(@CurrentUser() user: any) {
    return this.service.list(user);
  }

  @Patch(':id/deactivate')
  @Roles('transporter', 'producer')
  @ApiOperation({ summary: 'Desactivar camión' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivate(id, user);
  }
}
