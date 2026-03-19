// =====================================================================
// TOLVINK — CompanyAccess Controller + Service
// Plant-centric access model: plants configure OPERATOR / READONLY
// access for linked producer and transporter companies.
// =====================================================================

import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe,
  Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiProperty } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsString, IsEnum, IsBoolean, IsObject, MinLength, MaxLength } from 'class-validator';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UUID_RE } from '../common/constants';
import * as bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 10;

// ======================== DTOs =======================================

export class UpdateLevelDto {
  @ApiProperty({ enum: ['NONE', 'READONLY', 'OPERATOR'] })
  @IsEnum(['NONE', 'READONLY', 'OPERATOR'])
  level: string;
}

export class UpdatePermissionsDto {
  @ApiProperty({ description: 'Permisos de visibilidad (canViewTickets, canViewDocuments, etc.)' })
  @IsObject()
  permissions: Record<string, boolean>;
}

export class CreateLinkedCompanyDto {
  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @ApiProperty({ enum: ['PRODUCER', 'TRANSPORTER'] })
  @IsEnum(['PRODUCER', 'TRANSPORTER'])
  type: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  contactEmail?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  rut?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  hasInternalFleet?: boolean;

  @ApiProperty({ required: false, enum: ['OPERATOR', 'READONLY'] })
  @IsOptional()
  @IsEnum(['OPERATOR', 'READONLY'])
  accessLevel?: string;
}

export class CreateLinkedUserDto {
  @ApiProperty()
  @IsUUID()
  targetCompanyId: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(255)
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiProperty({ enum: ['gerente', 'operario', 'chofer'] })
  @IsEnum(['gerente', 'operario', 'chofer'])
  role: string;
}

// ======================== SERVICE ====================================

@Injectable()
export class CompanyAccessService {
  private readonly logger = new Logger(CompanyAccessService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  private isPlatformAdmin(user: any): boolean {
    return user.role === 'platform_admin';
  }

  private async resolvePlantCompanyId(user: any): Promise<string> {
    return this.companyRes.resolvePlantCompanyId(user);
  }

  // ── Core access methods ──────────────────────────────────────

  async getAccess(grantorId: string, granteeId: string) {
    return this.prisma.companyAccess.findUnique({
      where: { grantorCompanyId_granteeCompanyId: { grantorCompanyId: grantorId, granteeCompanyId: granteeId } },
    });
  }

  async getAccessLevel(grantorId: string, granteeId: string): Promise<string> {
    const access = await this.getAccess(grantorId, granteeId);
    if (!access || !access.isActive) return 'NONE';
    return access.accessLevel;
  }

  async isConsulta(grantorId: string, granteeId: string): Promise<boolean> {
    const level = await this.getAccessLevel(grantorId, granteeId);
    return level === 'READONLY';
  }

  async listByGrantor(grantorId: string, type?: string) {
    const where: any = { grantorCompanyId: grantorId };
    if (type) where.granteeType = type;

    return this.prisma.companyAccess.findMany({
      where,
      include: {
        granteeCompany: {
          select: { id: true, name: true, type: true, types: true, email: true, phone: true, hasInternalFleet: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listByGrantee(granteeId: string) {
    return this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: granteeId, isActive: true },
      include: {
        grantorCompany: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateLevel(id: string, level: string, user: any) {
    const access = await this.prisma.companyAccess.findUnique({ where: { id } });
    if (!access) throw new NotFoundException('Vinculación no encontrada');

    if (!this.isPlatformAdmin(user)) {
      const plantId = await this.resolvePlantCompanyId(user);
      if (access.grantorCompanyId !== plantId) throw new ForbiddenException('Sin acceso');
    }

    return this.prisma.companyAccess.update({
      where: { id },
      data: { accessLevel: level as any },
    });
  }

  async updatePermissions(id: string, permissions: Record<string, boolean>, user: any) {
    const access = await this.prisma.companyAccess.findUnique({ where: { id } });
    if (!access) throw new NotFoundException('Vinculación no encontrada');

    if (!this.isPlatformAdmin(user)) {
      const plantId = await this.resolvePlantCompanyId(user);
      if (access.grantorCompanyId !== plantId) throw new ForbiddenException('Sin acceso');
    }

    // Only allow visibility permissions, never action overrides
    const safeKeys = ['canViewTickets', 'canViewDocuments', 'canViewFleetDetails', 'canChatOnFreight'];
    const safePerms: Record<string, boolean> = {};
    for (const key of safeKeys) {
      if (key in permissions) safePerms[key] = !!permissions[key];
    }

    return this.prisma.companyAccess.update({
      where: { id },
      data: { permissions: safePerms },
    });
  }

  async toggleActive(id: string, user: any) {
    const access = await this.prisma.companyAccess.findUnique({ where: { id } });
    if (!access) throw new NotFoundException('Vinculación no encontrada');

    if (!this.isPlatformAdmin(user)) {
      const plantId = await this.resolvePlantCompanyId(user);
      if (access.grantorCompanyId !== plantId) throw new ForbiddenException('Sin acceso');
    }

    return this.prisma.companyAccess.update({
      where: { id },
      data: { isActive: !access.isActive },
    });
  }

  // ── Plant creates linked company ──────────────────────────────

  async createLinkedCompany(dto: CreateLinkedCompanyDto, user: any) {
    const plantId = this.isPlatformAdmin(user)
      ? user.activeCompanyId
      : await this.resolvePlantCompanyId(user);

    const companyType = dto.type === 'PRODUCER' ? 'producer' : 'transporter';

    // Create company
    const company = await this.prisma.company.create({
      data: {
        name: dto.name,
        type: companyType as any,
        types: [companyType],
        email: dto.contactEmail || null,
        rut: dto.rut || null,
        hasInternalFleet: dto.hasInternalFleet || false,
      },
    });

    // Create CompanyAccess link
    const access = await this.prisma.companyAccess.create({
      data: {
        grantorCompanyId: plantId,
        granteeCompanyId: company.id,
        granteeType: dto.type as any,
        accessLevel: (dto.accessLevel || 'OPERATOR') as any,
        invitedBy: user.sub,
      },
    });

    this.logger.log(`createLinkedCompany: ${dto.name} (${dto.type}) linked to plant ${plantId}`);
    return { company, access };
  }

  // ── Plant creates user for linked company ─────────────────────

  async createLinkedUser(dto: CreateLinkedUserDto, user: any) {
    const plantId = this.isPlatformAdmin(user)
      ? user.activeCompanyId
      : await this.resolvePlantCompanyId(user);

    // Validate CompanyAccess exists and is active
    const access = await this.prisma.companyAccess.findFirst({
      where: {
        grantorCompanyId: plantId,
        granteeCompanyId: dto.targetCompanyId,
        isActive: true,
      },
    });
    if (!access) throw new BadRequestException('No hay vinculación activa con esa empresa');

    // Generate email if not provided
    const email = dto.email || `${dto.name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@tolvink.generated`;
    const normalizedEmail = email.toLowerCase().trim();

    // Check email uniqueness
    const existing = await this.prisma.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new BadRequestException('Email ya registrado');

    // Check phone uniqueness
    if (dto.phone) {
      const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
      if (phoneExists) throw new BadRequestException('Teléfono ya registrado');
    }

    // Hash password
    const password = dto.password || 'Tolvink2026';
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Map role: gerente→admin, operario/chofer→operator
    const userRole = dto.role === 'gerente' ? 'admin' : 'operator';
    const membershipRole = dto.role; // gerente, operario, chofer

    // Create user
    const newUser = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: normalizedEmail,
        phone: dto.phone || null,
        passwordHash: hash,
        role: userRole as any,
        companyId: dto.targetCompanyId,
        activeCompanyId: dto.targetCompanyId,
        userTypes: [],
      },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        companyId: true, active: true,
      },
    });

    // Create membership
    await this.prisma.userCompany.create({
      data: {
        userId: newUser.id,
        companyId: dto.targetCompanyId,
        role: membershipRole,
      },
    }).catch(e => this.logger.warn(`createLinkedUser membership: ${e.message}`));

    this.logger.log(`createLinkedUser: ${dto.name} (${dto.role}) for company ${dto.targetCompanyId} by plant ${plantId}`);
    return newUser;
  }

  // ── My access (for producer/transporter) ──────────────────────

  async getMyAccess(user: any) {
    const companyId = user.activeCompanyId;
    if (!companyId) return [];

    return this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: companyId, isActive: true },
      include: {
        grantorCompany: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Company Access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('company-access')
export class CompanyAccessController {
  constructor(private service: CompanyAccessService) {}

  @Get(':companyId')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Listar vinculaciones de una planta' })
  @ApiQuery({ name: 'type', required: false, enum: ['PRODUCER', 'TRANSPORTER'] })
  listByGrantor(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('type') type?: string,
  ) {
    return this.service.listByGrantor(companyId, type);
  }

  @Get('my-access')
  @ApiOperation({ summary: 'Acceso del usuario actual (productor/transportista)' })
  getMyAccess(@CurrentUser() user: any) {
    return this.service.getMyAccess(user);
  }

  @Patch(':id/level')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Cambiar nivel de acceso (OPERATOR ↔ READONLY)' })
  updateLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLevelDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateLevel(id, dto.level, user);
  }

  @Patch(':id/permissions')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Actualizar permisos de visibilidad' })
  updatePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermissionsDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updatePermissions(id, dto.permissions, user);
  }

  @Patch(':id/toggle')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Activar/desactivar vinculación' })
  toggleActive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.toggleActive(id, user);
  }

  @Post('create-company')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Crear empresa vinculada (productor o transportista)' })
  createCompany(
    @Body() dto: CreateLinkedCompanyDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createLinkedCompany(dto, user);
  }

  @Post('create-user')
  @Roles('plant', 'platform_admin')
  @ApiOperation({ summary: 'Crear usuario para empresa vinculada' })
  createUser(
    @Body() dto: CreateLinkedUserDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createLinkedUser(dto, user);
  }
}
