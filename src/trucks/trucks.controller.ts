// =====================================================================
// TOLVINK — Trucks Controller + Service
// CRUD for fleet (camiones)
// Transporters and Producers with own fleet can manage trucks
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
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
    // Allow transporters, producers, and plants (own fleet)
    const ct = user.companyType;
    const cts = Array.isArray(user.companyTypes) ? user.companyTypes : [];
    const allowed = ['transporter', 'producer', 'plant'];
    if (!allowed.includes(ct) && !cts.some((t: string) => allowed.includes(t)) && user.role !== 'platform_admin') {
      throw new ForbiddenException('Solo transportistas, productores o plantas pueden crear camiones');
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

  async list(user: any, companyId?: string) {
    // Plant/admin can query trucks of a specific company (for own-fleet assignment)
    const targetCompanyId = companyId && (user.role === 'platform_admin' || user.companyType === 'plant' || (Array.isArray(user.companyTypes) && user.companyTypes.includes('plant')))
      ? companyId : user.companyId;
    if (!targetCompanyId) return [];
    return this.prisma.truck.findMany({
      where: { companyId: targetCompanyId, active: true },
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

  // ======================== DRIVER CRUD ================================

  async createDriver(body: { name: string; phone?: string; email?: string }, user: any) {
    if (!body.name?.trim()) throw new BadRequestException('Nombre obligatorio');

    const email = body.email?.trim().toLowerCase() || `chofer_${Date.now()}@tolvink.internal`;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Ya existe un usuario con ese email');

    if (body.phone?.trim()) {
      const existingPhone = await this.prisma.user.findFirst({ where: { phone: body.phone.trim() } });
      if (existingPhone) throw new BadRequestException('Ya existe un usuario con ese teléfono');
    }

    const driver = await this.prisma.user.create({
      data: {
        name: body.name.trim(),
        email,
        phone: body.phone?.trim() || null,
        companyId: user.companyId,
        activeCompanyId: user.companyId,
        role: 'operator',
      },
    });

    await this.prisma.userCompany.create({
      data: {
        userId: driver.id,
        companyId: user.companyId,
        role: 'chofer',
      },
    });

    return { id: driver.id, name: driver.name, phone: driver.phone, email: driver.email };
  }

  async listDrivers(user: any) {
    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: user.companyId, role: 'chofer', active: true },
      include: { user: { select: { id: true, name: true, phone: true, email: true, active: true } } },
    });
    return memberships.filter(m => m.user.active).map(m => ({
      id: m.user.id,
      name: m.user.name,
      phone: m.user.phone,
      email: m.user.email,
    }));
  }

  async deactivateDriver(driverId: string, user: any) {
    const membership = await this.prisma.userCompany.findFirst({
      where: { userId: driverId, companyId: user.companyId, role: 'chofer' },
    });
    if (!membership) throw new NotFoundException('Chofer no encontrado');

    await this.prisma.userCompany.update({
      where: { id: membership.id },
      data: { active: false },
    });
    return { ok: true };
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
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Registrar camión' })
  create(@Body() dto: CreateTruckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Listar camiones de la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  list(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    return this.service.list(user, companyId);
  }

  @Patch(':id/deactivate')
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Desactivar camión' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivate(id, user);
  }

  // ======================== DRIVER ENDPOINTS =============================

  @Post('drivers')
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Registrar chofer para la empresa' })
  createDriver(@Body() body: { name: string; phone?: string; email?: string }, @CurrentUser() user: any) {
    return this.service.createDriver(body, user);
  }

  @Get('drivers')
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Listar choferes de la empresa' })
  listDrivers(@CurrentUser() user: any) {
    return this.service.listDrivers(user);
  }

  @Patch('drivers/:id/deactivate')
  @Roles('transporter', 'producer', 'plant', 'admin')
  @ApiOperation({ summary: 'Desactivar chofer' })
  deactivateDriver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivateDriver(id, user);
  }
}
