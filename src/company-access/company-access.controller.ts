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
import { IsUUID, IsOptional, IsString, IsEnum, IsBoolean, IsObject, MinLength, MaxLength, Matches, IsNotEmpty } from 'class-validator';
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

  @ApiProperty({ description: 'Celular uruguayo: 09XXXXXXX' })
  @IsNotEmpty({ message: 'El teléfono es obligatorio' })
  @Matches(/^09\d{7}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' })
  phone: string;

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
  // In-memory cache for accessLevel lookups (key: grantorId:granteeId, value: { level, ts })
  private accessLevelCache = new Map<string, { level: string; ts: number }>();
  private static readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

  /** Resolve the user's active company ID (hub = any company with linked companies) */
  private resolveHubCompanyId(user: any): string {
    const id = user.activeCompanyId || user.companyId;
    if (!id) throw new ForbiddenException('No se pudo determinar la empresa activa');
    return id;
  }

  // ── Core access methods ──────────────────────────────────────

  async getAccess(grantorId: string, granteeId: string) {
    return this.prisma.companyAccess.findUnique({
      where: { grantorCompanyId_granteeCompanyId: { grantorCompanyId: grantorId, granteeCompanyId: granteeId } },
    });
  }

  async getAccessLevel(grantorId: string, granteeId: string): Promise<string> {
    const cacheKey = `${grantorId}:${granteeId}`;
    const cached = this.accessLevelCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < CompanyAccessService.CACHE_TTL) return cached.level;

    const access = await this.getAccess(grantorId, granteeId);
    const level = (!access || !access.isActive) ? 'NONE' : access.accessLevel;

    this.accessLevelCache.set(cacheKey, { level, ts: Date.now() });
    // Evict old entries if cache grows too large
    if (this.accessLevelCache.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.accessLevelCache) {
        if (now - v.ts > CompanyAccessService.CACHE_TTL) this.accessLevelCache.delete(k);
      }
    }
    return level;
  }

  /** Invalidate cache for a specific grantor-grantee pair */
  invalidateAccessLevel(grantorId: string, granteeId: string): void {
    this.accessLevelCache.delete(`${grantorId}:${granteeId}`);
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
      take: 100,
    });
  }

  async listByGrantee(granteeId: string) {
    return this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: granteeId, isActive: true },
      include: {
        grantorCompany: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async updateLevel(id: string, level: string, user: any) {
    const access = await this.prisma.companyAccess.findUnique({ where: { id } });
    if (!access) throw new NotFoundException('Vinculación no encontrada');

    if (!this.isPlatformAdmin(user)) {
      const hubId = this.resolveHubCompanyId(user);
      if (access.grantorCompanyId !== hubId) throw new ForbiddenException('Sin acceso');
    }

    const updated = await this.prisma.companyAccess.update({
      where: { id },
      data: { accessLevel: level as any },
    });
    // Invalidate cache
    this.invalidateAccessLevel(access.grantorCompanyId, access.granteeCompanyId);
    return updated;
  }

  async updatePermissions(id: string, permissions: Record<string, boolean>, user: any) {
    const access = await this.prisma.companyAccess.findUnique({ where: { id } });
    if (!access) throw new NotFoundException('Vinculación no encontrada');

    if (!this.isPlatformAdmin(user)) {
      const hubId = this.resolveHubCompanyId(user);
      if (access.grantorCompanyId !== hubId) throw new ForbiddenException('Sin acceso');
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
      const hubId = this.resolveHubCompanyId(user);
      if (access.grantorCompanyId !== hubId) throw new ForbiddenException('Sin acceso');
    }

    return this.prisma.companyAccess.update({
      where: { id },
      data: { isActive: !access.isActive },
    });
  }

  // ── Plant creates linked company ──────────────────────────────

  async createLinkedCompany(dto: CreateLinkedCompanyDto, user: any) {
    const hubId = this.isPlatformAdmin(user)
      ? user.activeCompanyId
      : this.resolveHubCompanyId(user);

    const companyType = dto.type === 'PRODUCER' ? 'producer' : 'transporter';

    // Create company
    const company = await this.prisma.company.create({
      data: {
        name: dto.name,
        type: companyType as any,
        types: [companyType],
        phone: dto.phone,
        email: dto.contactEmail || null,
        rut: dto.rut || null,
        hasInternalFleet: dto.hasInternalFleet || false,
      },
    });

    // Create CompanyAccess link
    const access = await this.prisma.companyAccess.create({
      data: {
        grantorCompanyId: hubId,
        granteeCompanyId: company.id,
        granteeType: dto.type as any,
        accessLevel: (dto.accessLevel || 'OPERATOR') as any,
        invitedBy: user.sub,
      },
    });

    this.logger.log(`createLinkedCompany: ${dto.name} (${dto.type}) linked to hub ${hubId}`);
    return { company, access };
  }

  // ── Plant creates user for linked company ─────────────────────

  async createLinkedUser(dto: CreateLinkedUserDto, user: any) {
    const hubId = this.isPlatformAdmin(user)
      ? user.activeCompanyId
      : this.resolveHubCompanyId(user);

    // Validate CompanyAccess exists and is active
    const access = await this.prisma.companyAccess.findFirst({
      where: {
        grantorCompanyId: hubId,
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

    this.logger.log(`createLinkedUser: ${dto.name} (${dto.role}) for company ${dto.targetCompanyId} by hub ${hubId}`);
    return newUser;
  }

  // ── Stats for linked companies (active freights + last activity) ─────

  async getLinkedCompaniesStats(grantorId: string) {
    const accesses = await this.prisma.companyAccess.findMany({
      where: { grantorCompanyId: grantorId, isActive: true },
      select: { granteeCompanyId: true },
      take: 100,
    });
    const companyIds = accesses.map(a => a.granteeCompanyId);
    if (companyIds.length === 0) return {};

    const activeStatuses = ['pending_assignment', 'assigned', 'accepted', 'in_progress', 'loaded'] as any;

    // Fetch active freights and last freight per company using simple queries
    const [activeFreights, activeAssignments, lastFreights] = await Promise.all([
      this.prisma.freight.findMany({
        where: {
          status: { in: activeStatuses },
          OR: [
            { originCompanyId: { in: companyIds } },
            { producerCompanyId: { in: companyIds } },
          ],
        },
        select: { originCompanyId: true, producerCompanyId: true },
      }),
      this.prisma.freightAssignment.findMany({
        where: {
          transportCompanyId: { in: companyIds },
          freight: { status: { in: activeStatuses } },
        },
        select: { transportCompanyId: true },
      }),
      this.prisma.freight.findMany({
        where: {
          OR: [
            { originCompanyId: { in: companyIds } },
            { producerCompanyId: { in: companyIds } },
          ],
        },
        select: { originCompanyId: true, producerCompanyId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: companyIds.length * 3,
      }),
    ]);

    const stats: Record<string, { activeFreights: number; lastFreightAt: string | null }> = {};
    for (const cid of companyIds) {
      stats[cid] = { activeFreights: 0, lastFreightAt: null };
    }

    for (const f of activeFreights) {
      const cid = f.producerCompanyId || f.originCompanyId;
      if (stats[cid]) stats[cid].activeFreights++;
    }
    for (const a of activeAssignments) {
      if (stats[a.transportCompanyId]) stats[a.transportCompanyId].activeFreights++;
    }
    for (const f of lastFreights) {
      const cid = f.producerCompanyId || f.originCompanyId;
      if (stats[cid] && !stats[cid].lastFreightAt) {
        stats[cid].lastFreightAt = f.createdAt.toISOString();
      }
    }

    return stats;
  }

  // ── My access (for producer/transporter) ──────────────────────

  async listUnified(grantorId: string) {
    // 1. CompanyAccess records (primary source)
    const caRecords = await this.prisma.companyAccess.findMany({
      where: { grantorCompanyId: grantorId },
      include: {
        granteeCompany: {
          select: { id: true, name: true, type: true, types: true, email: true, phone: true, hasInternalFleet: true, rut: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    // LEGACY: PlantProducerAccess — to be migrated to CompanyAccess
    // 2. PlantProducerAccess records (legacy)
    const ppaRecords = await this.prisma.plantProducerAccess.findMany({
      where: { plantCompanyId: grantorId },
      include: {
        producerCompany: {
          select: { id: true, name: true, type: true, types: true, email: true, phone: true, hasInternalFleet: true },
        },
      },
      take: 100,
    });

    // 3. Deduplicate: CompanyAccess takes priority
    const caCompanyIds = new Set(caRecords.map(r => r.granteeCompanyId));
    const unified: any[] = caRecords.map(r => ({
      ...r,
      accessSource: 'company_access',
    }));

    for (const ppa of ppaRecords) {
      if (caCompanyIds.has(ppa.producerCompanyId)) continue; // already in CompanyAccess
      unified.push({
        id: ppa.id,
        grantorCompanyId: ppa.plantCompanyId,
        granteeCompanyId: ppa.producerCompanyId,
        granteeType: 'PRODUCER',
        accessLevel: 'OPERATOR',
        isActive: ppa.active,
        createdAt: ppa.createdAt,
        updatedAt: ppa.updatedAt,
        granteeCompany: ppa.producerCompany,
        accessSource: 'plant_producer_access',
      });
    }

    return unified;
  }

  async getMyAccess(user: any) {
    const companyId = user.activeCompanyId;
    if (!companyId) return [];

    return this.prisma.companyAccess.findMany({
      where: { granteeCompanyId: companyId, isActive: true },
      include: {
        grantorCompany: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
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

  @Get('my-access')
  @ApiOperation({ summary: 'Acceso del usuario actual (productor/transportista)' })
  getMyAccess(@CurrentUser() user: any) {
    return this.service.getMyAccess(user);
  }

  @Get('stats/:companyId')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Stats de empresas vinculadas (fletes activos, última actividad)' })
  getLinkedStats(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.service.getLinkedCompaniesStats(companyId);
  }

  @Get('unified/:companyId')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Lista unificada: CompanyAccess + PlantProducerAccess' })
  listUnified(@Param('companyId', ParseUUIDPipe) companyId: string) {
    return this.service.listUnified(companyId);
  }

  @Get(':companyId')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Listar vinculaciones de una planta' })
  @ApiQuery({ name: 'type', required: false, enum: ['PRODUCER', 'TRANSPORTER'] })
  listByGrantor(
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Query('type') type?: string,
  ) {
    return this.service.listByGrantor(companyId, type);
  }

  @Patch(':id/level')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Cambiar nivel de acceso (OPERATOR ↔ READONLY)' })
  updateLevel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLevelDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updateLevel(id, dto.level, user);
  }

  @Patch(':id/permissions')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Actualizar permisos de visibilidad' })
  updatePermissions(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePermissionsDto,
    @CurrentUser() user: any,
  ) {
    return this.service.updatePermissions(id, dto.permissions, user);
  }

  @Patch(':id/toggle')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Activar/desactivar vinculación' })
  toggleActive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: any,
  ) {
    return this.service.toggleActive(id, user);
  }

  @Post('create-company')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Crear empresa vinculada (productor o transportista)' })
  createCompany(
    @Body() dto: CreateLinkedCompanyDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createLinkedCompany(dto, user);
  }

  @Post('create-user')
  @Roles('plant', 'producer', 'transporter', 'platform_admin')
  @ApiOperation({ summary: 'Crear usuario para empresa vinculada' })
  createUser(
    @Body() dto: CreateLinkedUserDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createLinkedUser(dto, user);
  }
}
