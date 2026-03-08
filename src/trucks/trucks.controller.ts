// =====================================================================
// TOLVINK — Trucks Controller + Service
// CRUD for fleet (camiones)
// Transporters and Producers with own fleet can manage trucks
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger } from '@nestjs/common';
import { UUID_RE } from '../common/constants';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsEmail, MaxLength, IsUUID, Matches, ValidateIf } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { randomBytes } from 'crypto';
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class CreateTruckDto {
  @ApiProperty({ example: 'ABC-123' })
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9\-\s]{2,20}$/, { message: 'Patente inválida (solo letras, números y guiones)' })
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

export class CreateDriverDto {
  @ApiProperty({ example: 'Juan Pérez' })
  @IsNotEmpty({ message: 'Nombre obligatorio' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ required: false, example: '098765432' })
  @IsOptional()
  @IsString()
  @Matches(/^09\d{7}$/, { message: 'Formato de teléfono inválido (09XXXXXXX)' })
  phone?: string;

  @ApiProperty({ required: false, example: 'juan@email.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  email?: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class TrucksService {
  private readonly logger = new Logger(TrucksService.name);

  constructor(private prisma: PrismaService, private wa: WhatsAppService) {}

  async create(dto: CreateTruckDto, user: any) {
    if (!user.companyId) throw new BadRequestException('No se pudo determinar tu empresa');
    // Allow transporters, producers, and plants (own fleet)
    const ct = user.companyType;
    const cts = Array.isArray(user.companyTypes) ? user.companyTypes : [];
    const allowed = ['transporter', 'producer', 'plant'];
    if (!allowed.includes(ct) && !cts.some((t: string) => allowed.includes(t)) && user.role !== 'platform_admin') {
      throw new ForbiddenException('Solo transportistas, productores o plantas pueden crear camiones');
    }

    // Normalize and check unique plate
    const normalizedPlate = dto.plate.toUpperCase().replace(/\s+/g, '').trim();
    const existing = await this.prisma.truck.findUnique({ where: { plate: normalizedPlate } });
    if (existing) {
      // Allow reactivation of same-company deactivated truck
      if (!existing.active && existing.companyId === user.companyId) {
        return this.prisma.truck.update({
          where: { id: existing.id },
          data: { active: true, model: dto.model || existing.model, assignedUserId: dto.assignedUserId || existing.assignedUserId },
          include: { assignedUser: { select: { id: true, name: true } } },
        });
      }
      throw new BadRequestException(`La patente ${dto.plate} ya está registrada`);
    }

    // Validate assigned user belongs to same company
    if (dto.assignedUserId) {
      const driver = await this.prisma.user.findFirst({
        where: { id: dto.assignedUserId, companyId: user.companyId, active: true },
      });
      if (!driver) throw new BadRequestException('Chofer no encontrado en tu empresa');
    }

    return this.prisma.truck.create({
      data: {
        plate: normalizedPlate,
        model: dto.model,
        companyId: user.companyId,
        assignedUserId: dto.assignedUserId,
      },
      include: { assignedUser: { select: { id: true, name: true } } },
    });
  }

  async list(user: any, companyId?: string) {
    // Plant/admin can query trucks of a specific company (for own-fleet assignment)
    let targetCompanyId = user.companyId;

    if (companyId && companyId !== user.companyId) {
      if (user.role === 'platform_admin') {
        targetCompanyId = companyId;
      } else if (user.companyType === 'plant' || (Array.isArray(user.companyTypes) && user.companyTypes.includes('plant'))) {
        // Verify business relationship: active freight assignment or plant-access
        // Time-bound to last 90 days to prevent perpetual access via old assignments
        const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
        const hasRelation = await this.prisma.freightAssignment.findFirst({
          where: {
            transportCompanyId: companyId,
            freight: { destCompanyId: user.companyId, status: { notIn: ['canceled'] } },
            createdAt: { gte: cutoff },
          },
        });
        const hasPlantAccess = await this.prisma.plantProducerAccess.findFirst({
          where: { plantCompanyId: user.companyId, producerCompanyId: companyId, active: true },
        }).catch(e => { this.logger.warn(e.message); return null; });
        if (!hasRelation && !hasPlantAccess) {
          // Also allow if companyId is one of the user's own companies
          const userCompanies = await this.prisma.userCompany.findMany({
            where: { userId: user.sub, active: true }, select: { companyId: true },
          });
          const myIds = [user.companyId, ...userCompanies.map(uc => uc.companyId)].filter(Boolean);
          if (!myIds.includes(companyId)) {
            throw new ForbiddenException('Sin acceso a la flota de esta empresa');
          }
        }
        targetCompanyId = companyId;
      }
    }

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

    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { truckId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) {
      throw new BadRequestException(`El camión tiene ${activeAssignments} asignación(es) activa(s). Cancele o finalice los viajes antes de desactivarlo.`);
    }

    return this.prisma.truck.update({
      where: { id: truckId },
      data: { active: false },
    });
  }

  // ======================== DRIVER CRUD ================================

  async createDriver(dto: CreateDriverDto, user: any) {
    const body = dto;

    const email = body.email?.trim().toLowerCase() || `chofer_${randomBytes(8).toString('hex')}@tolvink.internal`;
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new BadRequestException('Ya existe un usuario con ese email');

    if (body.phone?.trim()) {
      const existingPhone = await this.prisma.user.findFirst({ where: { phone: body.phone.trim() } });
      if (existingPhone) throw new BadRequestException('Ya existe un usuario con ese teléfono');
    }

    const driver = await this.prisma.$transaction(async (tx) => {
      const newUser = await tx.user.create({
        data: {
          name: body.name.trim(),
          email,
          phone: body.phone?.trim() || null,
          companyId: user.companyId,
          activeCompanyId: user.companyId,
          role: 'operator',
        },
      });

      await tx.userCompany.create({
        data: {
          userId: newUser.id,
          companyId: user.companyId,
          role: 'chofer',
        },
      });

      return newUser;
    });

    // Fire-and-forget: send WhatsApp welcome to driver
    if (driver.phone) {
      const welcomeMsg = `Hola ${driver.name?.split(' ')[0] || ''}! Te registraron como chofer en *Tolvink*.\n\nEscribime por acá para ver tus viajes asignados, iniciar fletes y compartir tu ubicación en tiempo real.`;
      this.wa.sendText(driver.phone, welcomeMsg).catch(err =>
        this.logger.warn(`WhatsApp welcome failed for driver: ${err.message}`),
      );
    }

    return { id: driver.id, name: driver.name, phone: driver.phone, email: driver.email };
  }

  async listDrivers(user: any) {
    if (!user.companyId) return [];
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

    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { driverId, status: { in: ['active', 'accepted'] }, freight: { status: { notIn: ['finished', 'canceled'] } } },
    });
    if (activeAssignments > 0) {
      throw new BadRequestException(`El chofer tiene ${activeAssignments} viaje(s) activo(s). Cancele o finalice los viajes antes de desactivarlo.`);
    }

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
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar camión' })
  create(@Body() dto: CreateTruckDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar camiones de la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  list(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.list(user, companyId);
  }

  @Patch(':id/deactivate')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Desactivar camión' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivate(id, user);
  }

  // ======================== DRIVER ENDPOINTS =============================

  @Post('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Registrar chofer para la empresa' })
  createDriver(@Body() dto: CreateDriverDto, @CurrentUser() user: any) {
    return this.service.createDriver(dto, user);
  }

  @Get('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar choferes de la empresa' })
  listDrivers(@CurrentUser() user: any) {
    return this.service.listDrivers(user);
  }

  @Patch('drivers/:id/deactivate')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Desactivar chofer' })
  deactivateDriver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivateDriver(id, user);
  }
}
