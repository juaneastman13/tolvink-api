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
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { JwtAuthGuard, invalidateUserActiveCache } from '../common/guards/jwt-auth.guard';
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

  @ApiProperty({ required: false, description: 'Empresa dueña lógica (cuando planta crea para transportista/productor)' })
  @IsOptional()
  @IsUUID()
  ownerCompanyId?: string;
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

  constructor(private prisma: PrismaService, private wa: WhatsAppService, private companyRes: CompanyResolutionService) {}

  /** Block CONSULTA (READONLY) users from mutations. */
  private async assertNotConsulta(user: any): Promise<void> {
    const isPlant = await this.companyRes.hasCompanyType(user, 'plant');
    if (isPlant || user.role === 'platform_admin') return;
    const activeCompanyId = user.activeCompanyId || user.companyId;
    if (!activeCompanyId) return;
    const access = await this.prisma.companyAccess.findFirst({
      where: { granteeCompanyId: activeCompanyId, isActive: true, accessLevel: 'READONLY' },
    });
    if (access) throw new ForbiddenException('Usuario CONSULTA no puede realizar esta acción');
  }

  async create(dto: CreateTruckDto, user: any) {
    await this.assertNotConsulta(user);
    const effectiveCompanyId = user.activeCompanyId || user.companyId;
    if (!effectiveCompanyId) throw new BadRequestException('No se pudo determinar tu empresa');
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
      if (!existing.active && existing.companyId === effectiveCompanyId) {
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
        where: { id: dto.assignedUserId, companyId: effectiveCompanyId, active: true },
      });
      if (!driver) throw new BadRequestException('Chofer no encontrado en tu empresa');
    }

    // If ownerCompanyId is set, validate CompanyAccess
    if (dto.ownerCompanyId) {
      const access = await this.prisma.companyAccess.findFirst({
        where: {
          grantorCompanyId: effectiveCompanyId,
          granteeCompanyId: dto.ownerCompanyId,
          isActive: true,
        },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
    }

    return this.prisma.truck.create({
      data: {
        plate: normalizedPlate,
        model: dto.model,
        companyId: effectiveCompanyId,
        ownerCompanyId: dto.ownerCompanyId || null,
        assignedUserId: dto.assignedUserId,
      },
      include: { assignedUser: { select: { id: true, name: true } } },
    });
  }

  async list(user: any, companyId?: string) {
    const targetCompanyId = companyId || user.companyId;
    if (!targetCompanyId) return [];

    const isAdmin = user.role === 'platform_admin' || user.isSuperAdmin;
    if (!isAdmin) {
      // Resolve all companies: memberships + companyId + companyByType
      const callerCompanies = await this.companyRes.resolveAllCompanyIds(user);
      if (!callerCompanies.includes(targetCompanyId)) {
        // Plant-centric fallback: check CompanyAccess (plant → linked company)
        const plantId = user.activeCompanyId || user.companyId;
        const hasAccess = plantId ? await this.prisma.companyAccess.findFirst({
          where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
          select: { id: true },
        }) : null;
        if (!hasAccess) {
          this.logger.warn(`list access denied: user=${user.sub} jwt.companyId=${user.companyId} requested=${targetCompanyId} resolvedIds=${JSON.stringify(callerCompanies)}`);
          throw new ForbiddenException('Sin acceso a la flota de esta empresa');
        }
      }
    }

    if (!targetCompanyId) return [];

    // Include trucks owned by this company (created by plant with ownerCompanyId)
    return this.prisma.truck.findMany({
      where: {
        active: true,
        OR: [
          { companyId: targetCompanyId },
          { ownerCompanyId: targetCompanyId },
        ],
      },
      include: { assignedUser: { select: { id: true, name: true } } },
      orderBy: { plate: 'asc' },
    });
  }

  async deactivate(truckId: string, user: any) {
    await this.assertNotConsulta(user);
    const effectiveCompanyId = user.activeCompanyId || user.companyId;
    const truck = await this.prisma.truck.findFirst({
      where: { id: truckId, OR: [{ companyId: effectiveCompanyId }, { ownerCompanyId: effectiveCompanyId }] },
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

  async createDriver(dto: CreateDriverDto, user: any, targetCompanyId?: string) {
    await this.assertNotConsulta(user);
    const body = dto;

    // Resolve target company: own company or linked company (plant cross-company)
    let driverCompanyId = user.companyId;
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const plantId = user.activeCompanyId || user.companyId;
      const access = await this.prisma.companyAccess.findFirst({
        where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
        select: { id: true, accessLevel: true },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
      if (access.accessLevel === 'READONLY') throw new ForbiddenException('Acceso CONSULTA no permite crear choferes');
      driverCompanyId = targetCompanyId;
    }

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
          companyId: driverCompanyId,
          activeCompanyId: driverCompanyId,
          role: 'operator',
        },
      });

      await tx.userCompany.create({
        data: {
          userId: newUser.id,
          companyId: driverCompanyId,
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

  async listDrivers(user: any, targetCompanyId?: string) {
    let driverCompanyId = targetCompanyId || user.companyId;
    if (!driverCompanyId) return [];

    // If requesting drivers of a different company, validate CompanyAccess
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const isAdmin = user.role === 'platform_admin' || user.isSuperAdmin;
      if (!isAdmin) {
        const plantId = user.activeCompanyId || user.companyId;
        const access = plantId ? await this.prisma.companyAccess.findFirst({
          where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
          select: { id: true },
        }) : null;
        if (!access) throw new ForbiddenException('Sin acceso a los choferes de esta empresa');
      }
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId: driverCompanyId, role: 'chofer', active: true },
      include: { user: { select: { id: true, name: true, phone: true, email: true, active: true } } },
    });
    return memberships.filter(m => m.user.active).map(m => ({
      id: m.user.id,
      name: m.user.name,
      phone: m.user.phone,
      email: m.user.email,
    }));
  }

  async deactivateDriver(driverId: string, user: any, targetCompanyId?: string) {
    await this.assertNotConsulta(user);

    // Resolve company: own company or linked company (plant cross-company)
    let driverCompanyId = user.companyId;
    if (targetCompanyId && targetCompanyId !== user.companyId) {
      const plantId = user.activeCompanyId || user.companyId;
      const access = await this.prisma.companyAccess.findFirst({
        where: { grantorCompanyId: plantId, granteeCompanyId: targetCompanyId, isActive: true },
        select: { id: true, accessLevel: true },
      });
      if (!access) throw new ForbiddenException('No hay vinculación activa con esa empresa');
      if (access.accessLevel === 'READONLY') throw new ForbiddenException('Acceso CONSULTA no permite desactivar choferes');
      driverCompanyId = targetCompanyId;
    }

    const membership = await this.prisma.userCompany.findFirst({
      where: { userId: driverId, companyId: driverCompanyId, role: 'chofer' },
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

    // Invalidate JWT active cache so deactivated driver is rejected immediately
    invalidateUserActiveCache(driverId);

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
  @ApiQuery({ name: 'companyId', required: false })
  createDriver(@Body() dto: CreateDriverDto, @CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.createDriver(dto, user, companyId);
  }

  @Get('drivers')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Listar choferes de la empresa' })
  @ApiQuery({ name: 'companyId', required: false })
  listDrivers(@CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.listDrivers(user, companyId);
  }

  @Patch('drivers/:id/deactivate')
  @Roles('transporter', 'producer', 'plant')
  @ApiOperation({ summary: 'Desactivar chofer' })
  @ApiQuery({ name: 'companyId', required: false })
  deactivateDriver(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any, @Query('companyId') companyId?: string) {
    if (companyId && !UUID_RE.test(companyId)) throw new BadRequestException('companyId inválido');
    return this.service.deactivateDriver(id, user, companyId);
  }
}
