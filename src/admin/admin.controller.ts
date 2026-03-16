// =====================================================================
// TOLVINK — Admin Module (Controller + Service + DTOs)
// Simple, clean, no over-engineering
// Roles: platform_admin (super), admin (company manager), operator (user)
// =====================================================================

import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe, Delete,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  Injectable, BadRequestException, NotFoundException, ForbiddenException, UnauthorizedException, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  IsNotEmpty, IsOptional, IsString, IsEmail, IsUUID,
  IsBoolean, IsArray, MaxLength, MinLength, IsNumber, IsIn, Matches, IsObject, Min, Max,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs =======================================

export class CreateCompanyDto {
  @ApiProperty() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ enum: ['producer', 'plant', 'transporter'] }) @IsNotEmpty()
  @IsIn(['producer', 'plant', 'transporter'])
  type: string;

  @ApiProperty({ required: false, type: [String], description: 'Multi-type support: array of CompanyType values' })
  @IsOptional() @IsArray() @IsString({ each: true })
  @IsIn(['producer', 'plant', 'transporter'], { each: true })
  types?: string[];

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(255)
  address?: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(50)
  phone?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsEmail()
  email?: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(20)
  rut?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  hasInternalFleet?: boolean;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lat?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lng?: number;
}

export class CreateBranchDto {
  @ApiProperty() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty() @IsUUID()
  companyId: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(500)
  address?: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(500)
  reference?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lat?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lng?: number;
}

export class CreateUserDto {
  @ApiProperty() @IsNotEmpty() @MinLength(2) @MaxLength(255)
  name: string;

  @ApiProperty() @IsEmail()
  email: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString()
  phone?: string;

  @ApiProperty() @IsNotEmpty() @MinLength(8) @MaxLength(128)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/, { message: 'La contraseña debe tener al menos 8 caracteres, una mayúscula, una minúscula y un número' })
  password: string;

  @ApiProperty({ required: false }) @IsOptional() @IsArray()
  @IsIn(['producer', 'plant', 'transporter'], { each: true })
  userTypes?: string[];

  @ApiProperty({ required: false, enum: ['operator', 'admin'] })
  @IsOptional()
  @IsIn(['operator', 'admin'], { message: 'Rol debe ser operator o admin' })
  role?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsUUID()
  companyId?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsObject() companyByType?: Record<string, string>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() roleByType?: Record<string, string>;
}

export class AdminCreateFieldDto {
  @ApiProperty() @IsNotEmpty() @IsString() @MaxLength(200)
  name: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(500)
  address?: string;

  @ApiProperty() @IsNumber() @Min(-90) @Max(90)
  lat: number;

  @ApiProperty() @IsNumber() @Min(-180) @Max(180)
  lng: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  hectares?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000)
  comments?: string;
}

export class AdminCreateLotDto {
  @ApiProperty() @IsNotEmpty() @IsString() @MaxLength(200)
  name: string;

  @ApiProperty() @IsNumber() @Min(-90) @Max(90)
  lat: number;

  @ApiProperty() @IsNumber() @Min(-180) @Max(180)
  lng: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  hectares?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000)
  comments?: string;
}

export class AdminCreateTruckDto {
  @ApiProperty() @IsNotEmpty() @IsString() @Matches(/^[A-Za-z0-9\-\s]{2,20}$/, { message: 'Patente: solo letras, números, guiones (2-20 chars)' })
  plate: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100)
  brand?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100)
  model?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber() @Min(0) @Max(1000)
  capacity?: number;
}

export class UpdateUserDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(255) name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() @MaxLength(255) email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(50) phone?: string;
  @ApiProperty({ required: false, enum: ['operator', 'admin'] }) @IsOptional() @IsIn(['operator', 'admin'], { message: 'Rol debe ser operator o admin' }) role?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsArray() @IsString({ each: true }) @IsIn(['producer', 'plant', 'transporter'], { each: true }) userTypes?: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() active?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() companyId?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() companyByType?: Record<string, string>;
  @ApiProperty({ required: false }) @IsOptional() @IsObject() roleByType?: Record<string, string>;
}

export class UpdateSelfDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MinLength(2, { message: 'Nombre muy corto' }) @MaxLength(255) name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail({}, { message: 'Email inválido' }) email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @Matches(/^09\d{7}$/, { message: 'Formato: 09XXXXXXX (9 dígitos)' }) phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() currentPassword?: string;
}

// ======================== UPDATE DTOs (with @IsOptional on every field) ==

export class UpdateCompanyDto {
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(255) name?: string;
  @ApiProperty({ required: false, enum: ['producer', 'plant', 'transporter'] }) @IsOptional() @IsIn(['producer', 'plant', 'transporter']) type?: string;
  @ApiProperty({ required: false, type: [String] }) @IsOptional() @IsArray() @IsString({ each: true }) @IsIn(['producer', 'plant', 'transporter'], { each: true }) types?: string[];
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(255) address?: string;
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(50) phone?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(20) rut?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() hasInternalFleet?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lat?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lng?: number;
}

export class UpdateBranchDto {
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(255) name?: string;
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(500) address?: string;
  @ApiProperty({ required: false }) @IsOptional() @MaxLength(500) reference?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lat?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lng?: number;
}

export class UpdateFieldDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(500) address?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lat?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lng?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() hectares?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) comments?: string;
}

export class UpdateLotDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lat?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() lng?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() hectares?: number;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(1000) comments?: string;
}

export class UpdateAdminTruckDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(20) plate?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100) brand?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() @MaxLength(100) model?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsNumber() capacity?: number;
}

// ======================== CONSTANTS ===================================

const BCRYPT_ROUNDS = 10;
const MAX_USER_LIST_RESULTS = 200;
const STATS_CACHE_TTL_MS = 60_000;

// ======================== HELPERS =====================================

function handlePrismaUniqueError(err: any, fieldLabels: Record<string, string>): string | null {
  if (err?.code === 'P2002') {
    const target = err.meta?.target;
    for (const [field, label] of Object.entries(fieldLabels)) {
      if (target?.includes(field)) return `Ya existe un registro con ese ${label}`;
    }
    return 'Ya existe un registro con esos datos';
  }
  return null;
}

// ======================== SERVICE ====================================

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    public prisma: PrismaService,
    private companyRes: CompanyResolutionService,
    private wa: WhatsAppService,
  ) {}

  // --- Permission helpers ---
  isPlatformAdmin(user: any): boolean {
    // Quick JWT check — callers doing mutations MUST also call resolveFullUser() for DB verification
    return user.role === 'platform_admin' || user.isSuperAdmin === true;
  }

  /** Verify company admin role against the DATABASE, not JWT claims */
  async isCompanyAdmin(user: any): Promise<boolean> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub || user.id },
      select: { role: true, active: true },
    });
    if (!dbUser || !dbUser.active) return false;
    return dbUser.role === 'admin';
  }

  async assertPlatformAdmin(user: any) {
    if (!this.isPlatformAdmin(user)) {
      throw new ForbiddenException('Solo administradores de plataforma');
    }
    // Verify against DB — JWT claim could be stale
    await this.resolveFullUser(user);
  }

  /** Verify role against DB — not just JWT claims */
  async assertCompanyOrPlatformAdmin(user: any) {
    if (this.isPlatformAdmin(user)) {
      // Still verify platform_admin in DB via resolveFullUser
      await this.resolveFullUser(user);
      return;
    }
    // JWT may be stale (e.g., is_super_admin set after last login) — check DB
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub || user.id },
      select: { role: true, active: true, isSuperAdmin: true },
    });
    if (!dbUser || !dbUser.active) throw new ForbiddenException('Permisos insuficientes');
    if (dbUser.isSuperAdmin || dbUser.role === 'platform_admin' || dbUser.role === 'admin') return;
    throw new ForbiddenException('Permisos insuficientes');
  }

  async getUserCompanyIds(user: any): Promise<string[]> {
    return this.companyRes.resolveAllCompanyIds({ sub: user.sub || user.id, companyId: user.companyId });
  }

  // Fetch full user from DB (JWT only has sub, role, companyId)
  async resolveFullUser(jwtUser: any): Promise<any> {
    if (this.isPlatformAdmin(jwtUser)) {
      const adminCheck = await this.prisma.user.findUnique({ where: { id: jwtUser.sub }, select: { active: true, role: true, isSuperAdmin: true } });
      if (!adminCheck || !adminCheck.active) {
        throw new UnauthorizedException('Usuario desactivado o sin permisos');
      }
      if (adminCheck.role !== 'platform_admin' && !adminCheck.isSuperAdmin) {
        throw new UnauthorizedException('Usuario sin permisos de administrador');
      }
      return { ...jwtUser, isSuperAdmin: adminCheck.isSuperAdmin, role: adminCheck.isSuperAdmin ? 'platform_admin' : adminCheck.role };
    }
    const full = await this.prisma.user.findUnique({
      where: { id: jwtUser.sub },
      select: { id: true, role: true, companyId: true, isSuperAdmin: true, active: true },
    });
    if (!full || !full.active) throw new ForbiddenException('Usuario no encontrado');
    // If DB shows isSuperAdmin, ensure role reflects platform_admin (JWT may be stale)
    const resolvedRole = full.isSuperAdmin ? 'platform_admin' : full.role;
    return { ...jwtUser, ...full, role: resolvedRole, sub: full.id };
  }

  // --- Stats (cached 60s) ---
  private _statsCache: { data: any; ts: number } | null = null;
  async getStats() {
    const now = Date.now();
    if (this._statsCache && now - this._statsCache.ts < STATS_CACHE_TTL_MS) return this._statsCache.data;
    const [users, companies, branches, freights] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.company.count(),
      this.prisma.branch.count(),
      this.prisma.freight.count(),
    ]);
    const data = { users, companies, branches, freights };
    this._statsCache = { data, ts: now };
    return data;
  }

  async getActivity(callerUser: any, page: number, limit: number) {
    const companyIds = this.isPlatformAdmin(callerUser) ? [] : await this.getUserCompanyIds(callerUser);
    const skip = (page - 1) * limit;

    // Build where clause: filter by freights the company participates in
    const where: any = {};
    if (companyIds.length > 0) {
      const freightIds = await this.prisma.freight.findMany({
        where: { participantCompanyIds: { hasSome: companyIds } },
        select: { id: true },
        take: 500,
        orderBy: { updatedAt: 'desc' },
      });
      where.freightId = { in: freightIds.map(f => f.id) };
    }

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, name: true } },
          freight: { select: { id: true, code: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: data.map(e => ({
        id: e.id,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        freightId: e.freightId,
        freightCode: (e as any).freight?.code || null,
        userId: e.userId,
        userName: (e as any).user?.name || 'Sistema',
        metadata: e.metadata,
        fromValue: e.fromValue,
        toValue: e.toValue,
        reason: e.reason,
        createdAt: e.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  // --- Companies ---
  async listCompanies(search?: string, callerUser?: any) {
    const where: any = {};

    // Non-superadmin: only see their own companies
    if (callerUser && !this.isPlatformAdmin(callerUser)) {
      const myIds = await this.getUserCompanyIds(callerUser);
      if (myIds.length === 0) return [];
      where.id = { in: myIds };
    }

    if (search) {
      where.AND = [
        ...(where.id ? [{ id: where.id }] : []),
        { OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { rut: { contains: search, mode: 'insensitive' } },
        ]},
      ];
      delete where.id;
    }
    return this.prisma.company.findMany({
      where,
      include: {
        branches: { where: { active: true }, select: { id: true, name: true, lat: true, lng: true } },
        _count: { select: { users: true, branches: true } },
      },
      orderBy: { name: 'asc' },
      take: 200,
    });
  }

  async getCompany(id: string, callerUser?: any) {
    // Non-superadmin: verify they belong to this company
    if (callerUser && !this.isPlatformAdmin(callerUser)) {
      const myIds = await this.getUserCompanyIds(callerUser);
      if (!myIds.includes(id)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    const c = await this.prisma.company.findUnique({
      where: { id },
      include: {
        branches: { where: { active: true }, orderBy: { name: 'asc' } },
        users: { where: { active: true }, select: { id: true, name: true, email: true, phone: true, role: true } },
      },
    });
    if (!c) throw new NotFoundException('Empresa no encontrada');
    return c;
  }

  async createCompany(dto: CreateCompanyDto) {
    // If types[] provided, set type (primary) to first element; otherwise set types from type
    const primaryType = dto.types && dto.types.length > 0 ? dto.types[0] : dto.type;
    const typesArray = dto.types && dto.types.length > 0 ? dto.types : [dto.type];

    return (this.prisma.company as any).create({
      data: {
        name: dto.name,
        type: primaryType,
        types: typesArray,
        address: dto.address,
        phone: dto.phone,
        email: dto.email,
        rut: dto.rut,
        hasInternalFleet: dto.hasInternalFleet || false,
        lat: dto.lat,
        lng: dto.lng,
      },
    });
  }

  async updateCompany(id: string, dto: UpdateCompanyDto, user: any) {
    // Non-superadmin can only edit companies they belong to
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(id)) throw new ForbiddenException('No podés editar esta empresa');
    }
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    // Non-platform admins cannot change sensitive company fields
    if (!this.isPlatformAdmin(user)) {
      delete dto.type;
      delete dto.types;
      delete dto.rut;
      delete dto.hasInternalFleet;
    }

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.rut !== undefined) data.rut = dto.rut;
    if (dto.hasInternalFleet !== undefined) data.hasInternalFleet = dto.hasInternalFleet;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    // Multi-type support: if types[] provided, sync type (primary) and types
    if (dto.types !== undefined && Array.isArray(dto.types) && dto.types.length > 0) {
      data.type = dto.types[0]; // Primary type = first element
      data.types = dto.types;
    } else if (dto.type !== undefined) {
      data.type = dto.type;
      data.types = [dto.type]; // Sync types from single type
    }

    return (this.prisma.company as any).update({ where: { id }, data });
  }

  // --- Branches ---
  async listBranches(companyId: string) {
    return this.prisma.branch.findMany({
      where: { companyId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createBranch(dto: CreateBranchDto) {
    const company = await this.prisma.company.findFirst({ where: { id: dto.companyId, active: true } });
    if (!company) throw new BadRequestException('Empresa no encontrada o inactiva');

    return this.prisma.branch.create({
      data: {
        name: dto.name,
        companyId: dto.companyId,
        address: dto.address,
        reference: dto.reference,
        lat: dto.lat,
        lng: dto.lng,
      },
    });
  }

  async updateBranch(id: string, dto: UpdateBranchDto, user: any) {
    const branch = await this.prisma.branch.findUnique({ where: { id }, select: { id: true, companyId: true, name: true } });
    if (!branch) throw new NotFoundException('Sucursal no encontrada');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(branch.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.reference !== undefined) data.reference = dto.reference;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.branch.update({ where: { id }, data });
  }

  async deleteBranch(id: string, user: any) {
    const branch = await this.prisma.branch.findUnique({ where: { id }, select: { id: true, companyId: true } });
    if (!branch) throw new NotFoundException('Recurso no encontrado');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(branch.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    return this.prisma.branch.update({ where: { id }, data: { active: false } });
  }

  async getBranchCompanyId(id: string): Promise<string | null> {
    const b = await this.prisma.branch.findUnique({ where: { id }, select: { companyId: true } });
    return b?.companyId || null;
  }

  // --- Users ---
  async listUsers(search?: string, companyId?: string, callerUser?: any) {
    const where: any = {};

    // Non-superadmin: only see users from their own companies
    if (callerUser && !this.isPlatformAdmin(callerUser)) {
      const myIds = await this.getUserCompanyIds(callerUser);
      if (myIds.length === 0) return [];
      where.companyId = { in: myIds };
    } else if (companyId) {
      where.companyId = companyId;
    }

    if (search) {
      const searchFilter = {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search, mode: 'insensitive' } },
        ],
      };
      if (where.companyId) {
        where.AND = [{ companyId: where.companyId }, searchFilter];
        delete where.companyId;
      } else {
        Object.assign(where, searchFilter);
      }
    }
    return this.prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, isSuperAdmin: true, active: true, companyId: true,
        companyByType: true, roleByType: true, createdAt: true,
        company: { select: { id: true, name: true, type: true } },
        memberships: {
          where: { active: true },
          select: { id: true, companyId: true, role: true, company: { select: { id: true, name: true, type: true } } },
          orderBy: { createdAt: 'asc' as any },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: MAX_USER_LIST_RESULTS,
    });
  }

  async createUser(dto: CreateUserDto, preHashedPassword?: string) {

    dto.email = dto.email.toLowerCase().trim();

    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) throw new BadRequestException('Email ya registrado');

    if (dto.phone) {
      const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
      if (phoneExists) throw new BadRequestException('Teléfono ya registrado');
    }

    if (dto.companyId) {
      const c = await this.prisma.company.findFirst({ where: { id: dto.companyId, active: true } });
      if (!c) throw new BadRequestException('Empresa no encontrada o inactiva');
    }

    // Use pre-hashed password (internal callers like AI) or hash from plaintext
    const hash = preHashedPassword || await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const membershipRole = dto.role === 'admin' ? 'gerente' : 'operario';

    let user: any;
    try {
      user = await this.prisma.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone || null,
          passwordHash: hash,
          role: (dto.role as any) || 'operator',
          userTypes: dto.userTypes || [],
          companyId: dto.companyId || null,
          activeCompanyId: dto.companyId || null,
          companyByType: dto.companyByType || {},
          roleByType: dto.roleByType || {},
        },
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
          company: { select: { id: true, name: true, type: true } },
        },
      });
    } catch (err: any) {
      const msg = handlePrismaUniqueError(err, { email: 'email', phone: 'teléfono' });
      if (msg) throw new BadRequestException(msg);
      throw err;
    }

    // Create UserCompany membership
    if (dto.companyId) {
      await (this.prisma as any).userCompany.create({
        data: { userId: user.id, companyId: dto.companyId, role: membershipRole },
      }).catch(e => this.logger.warn(e.message));
    }

    // Create additional memberships from companyByType
    if (dto.companyByType && typeof dto.companyByType === 'object') {
      for (const [type, coId] of Object.entries(dto.companyByType)) {
        if (coId && coId !== dto.companyId) {
          const rbt = (dto.roleByType as any) || {};
          const role = rbt[type] === 'admin' ? 'gerente' : rbt[type] === 'chofer' ? 'chofer' : 'operario';
          await (this.prisma as any).userCompany.create({
            data: { userId: user.id, companyId: coId, role },
          }).catch(e => this.logger.warn(e.message));
        }
      }
    }

    // Fire-and-forget: send WhatsApp welcome if user has phone
    if (user.phone) {
      const companyName = user.company?.name || 'tu empresa';
      const welcomeMsg = `Hola ${user.name?.split(' ')[0] || ''}! Tu cuenta en *Tolvink* fue creada para ${companyName}.\n\nPodés escribirme por acá para gestionar tus fletes, consultar estados y más.`;
      this.wa.sendText(user.phone, welcomeMsg).catch(err =>
        this.logger.warn(`WhatsApp welcome failed: ${err.message}`),
      );
    }

    return user;
  }

  async updateUser(userId: string, dto: UpdateUserDto, callerUser: any) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('Usuario no encontrado');

    // Always resolve caller from DB to prevent stale JWT role bypass
    const resolvedCaller = await this.resolveFullUser(callerUser);
    const callerIsPlatformAdmin = resolvedCaller.isSuperAdmin === true;

    // Non-platform-admins can only edit users in their own companies (or themselves)
    if (!callerIsPlatformAdmin) {
      // Company admins can't set platform_admin role (applies to self-edit too)
      if (dto.role === 'platform_admin') {
        throw new ForbiddenException('No podés asignar rol de administrador principal');
      }
      if (callerUser.sub !== userId) {
        const callerCompanies = await this.getUserCompanyIds(resolvedCaller);
        const targetMemberships = await this.prisma.userCompany.findMany({ where: { userId }, select: { companyId: true } });
        const targetCompanies = [target.companyId, ...targetMemberships.map(m => m.companyId)].filter(Boolean);
        if (!targetCompanies.some(c => callerCompanies.includes(c))) {
          throw new ForbiddenException('No podés editar este usuario');
        }
      }
      // Prevent cross-tenant escalation: strip companyByType, roleByType, companyId
      dto.companyByType = undefined;
      dto.roleByType = undefined;
      if (dto.companyId !== undefined) {
        const callerCoIds = await this.getUserCompanyIds(resolvedCaller);
        if (!callerCoIds.includes(dto.companyId)) {
          throw new ForbiddenException('No podés mover usuarios a una empresa ajena');
        }
      }
    }

    // Normalize email before uniqueness check
    if (dto.email) {
      dto.email = dto.email.toLowerCase().trim();
      const dup = await this.prisma.user.findFirst({ where: { email: dto.email, id: { not: userId } } });
      if (dup) throw new BadRequestException('Ya existe un usuario con ese email');
    }
    if (dto.phone) {
      const dup = await this.prisma.user.findFirst({ where: { phone: dto.phone, id: { not: userId } } });
      if (dup) throw new BadRequestException('Ya existe un usuario con ese teléfono');
    }

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.userTypes !== undefined) data.userTypes = dto.userTypes;
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.companyId !== undefined) data.companyId = dto.companyId || null;
    if (dto.companyByType !== undefined) data.companyByType = dto.companyByType || {};
    if (dto.roleByType !== undefined) data.roleByType = dto.roleByType || {};

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });

    // Sync memberships if companyId changed
    if (dto.companyId !== undefined && dto.companyId) {
      const membershipRole = dto.role === 'admin' ? 'gerente' : 'operario';
      await (this.prisma as any).userCompany.upsert({
        where: { userId_companyId: { userId, companyId: dto.companyId } },
        create: { userId, companyId: dto.companyId, role: membershipRole },
        update: { active: true, role: membershipRole },
      }).catch(e => this.logger.warn(e.message));
    }

    // Sync additional memberships from companyByType
    if (dto.companyByType && typeof dto.companyByType === 'object') {
      for (const [type, coId] of Object.entries(dto.companyByType)) {
        if (coId && typeof coId === 'string') {
          const rbt = (dto.roleByType as any) || {};
          const role = rbt[type] === 'admin' ? 'gerente' : rbt[type] === 'chofer' ? 'chofer' : 'operario';
          await (this.prisma as any).userCompany.upsert({
            where: { userId_companyId: { userId, companyId: coId } },
            create: { userId, companyId: coId, role },
            update: { active: true, role },
          }).catch(e => this.logger.warn(e.message));
        }
      }
    }

    return updated;
  }

  // --- Membership management ---
  async addUserCompany(userId: string, companyId: string, role: string, callerUser: any) {
    const resolvedCaller = await this.resolveFullUser(callerUser);
    if (!resolvedCaller.isSuperAdmin) {
      const myIds = await this.getUserCompanyIds(resolvedCaller);
      if (!myIds.includes(companyId)) throw new ForbiddenException('No podés asignar esta empresa');
    }
    const company = await this.prisma.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, type: true } });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const membership = await (this.prisma as any).userCompany.upsert({
      where: { userId_companyId: { userId, companyId } },
      create: { userId, companyId, role, active: true },
      update: { role, active: true },
    });

    // Sync user.companyByType and userTypes
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { userTypes: true, companyByType: true, companyId: true } });
    if (user) {
      const types = Array.isArray(user.userTypes) ? [...user.userTypes as string[]] : [];
      const cbt = (user.companyByType && typeof user.companyByType === 'object') ? { ...(user.companyByType as any) } : {};
      if (!types.includes(company.type)) types.push(company.type);
      if (!cbt[company.type]) cbt[company.type] = companyId;
      const data: any = { userTypes: types, companyByType: cbt };
      if (!user.companyId) data.companyId = companyId;
      await this.prisma.user.update({ where: { id: userId }, data });
    }
    return { ...membership, company };
  }

  async updateUserCompany(userId: string, companyId: string, role: string, callerUser: any) {
    const resolvedCaller = await this.resolveFullUser(callerUser);
    if (!resolvedCaller.isSuperAdmin) {
      const myIds = await this.getUserCompanyIds(resolvedCaller);
      if (!myIds.includes(companyId)) throw new ForbiddenException('No podés editar esta membresía');
    }
    return (this.prisma as any).userCompany.update({
      where: { userId_companyId: { userId, companyId } },
      data: { role },
    });
  }

  async removeUserCompany(userId: string, companyId: string, callerUser: any) {
    const resolvedCaller = await this.resolveFullUser(callerUser);
    if (!resolvedCaller.isSuperAdmin) {
      const myIds = await this.getUserCompanyIds(resolvedCaller);
      if (!myIds.includes(companyId)) throw new ForbiddenException('No podés quitar esta empresa');
    }
    await (this.prisma as any).userCompany.updateMany({
      where: { userId, companyId },
      data: { active: false },
    });

    // Sync user.companyByType — remove this company from it
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { userTypes: true, companyByType: true, companyId: true, activeCompanyId: true } });
    if (user) {
      const cbt = (user.companyByType && typeof user.companyByType === 'object') ? { ...(user.companyByType as any) } : {};
      for (const [type, cId] of Object.entries(cbt)) {
        if (cId === companyId) delete cbt[type];
      }
      const data: any = { companyByType: cbt };
      if (user.companyId === companyId) data.companyId = null;
      if (user.activeCompanyId === companyId) data.activeCompanyId = null;
      await this.prisma.user.update({ where: { id: userId }, data });
    }
    return { ok: true };
  }

  // Self-edit: any user can edit their own name/email/phone
  async updateSelf(userId: string, dto: { name?: string; email?: string; phone?: string; currentPassword?: string }) {
    if (dto.name !== undefined) {
      dto.name = dto.name.trim();
      if (!dto.name) throw new BadRequestException('Nombre no puede estar vacío');
    }
    if (dto.email) {
      dto.email = dto.email.toLowerCase().trim();
      const dup = await this.prisma.user.findFirst({ where: { email: dto.email, id: { not: userId } } });
      if (dup) throw new BadRequestException('Ya existe un usuario con ese email');
    }
    if (dto.phone) {
      const dup = await this.prisma.user.findFirst({ where: { phone: dto.phone, id: { not: userId } } });
      if (dup) throw new BadRequestException('Ya existe un usuario con ese teléfono');
    }

    // Require current password for email/phone changes (only if user has a password set)
    if (dto.email || dto.phone) {
      const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
      if (user?.passwordHash) {
        if (!dto.currentPassword) {
          throw new BadRequestException('Se requiere la contraseña actual para cambiar email o teléfono');
        }
    
        const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
        if (!valid) throw new BadRequestException('Contraseña incorrecta');
      }
    }

    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.email) data.email = dto.email;
    if (dto.phone) data.phone = dto.phone;
    try {
      return await this.prisma.user.update({
        where: { id: userId },
        data,
        select: {
          id: true, name: true, email: true, phone: true, role: true,
          userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
          company: { select: { id: true, name: true, type: true, hasInternalFleet: true } },
        },
      });
    } catch (e: any) {
      const msg = handlePrismaUniqueError(e, { email: 'email', phone: 'teléfono' });
      if (msg) throw new BadRequestException(msg);
      throw e;
    }
  }

  // ===================== FIELDS (Producer) =====================
  async listFieldsByCompany(companyId: string) {
    return this.prisma.field.findMany({
      where: { companyId, active: true },
      include: {
        lots: { where: { active: true }, orderBy: { name: 'asc' } },
        _count: { select: { lots: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createField(companyId: string, dto: any) {
    if (!dto.name?.trim()) throw new BadRequestException('Nombre requerido');
    if (dto.lat == null || dto.lng == null) throw new BadRequestException('Ubicación requerida');
    return this.prisma.field.create({
      data: {
        name: dto.name.trim(),
        companyId,
        address: dto.address || null,
        lat: dto.lat, lng: dto.lng,
        hectares: dto.hectares || null,
        comments: dto.comments || null,
      },
    });
  }

  async updateField(fieldId: string, dto: any, user: any) {
    const f = await this.prisma.field.findFirst({ where: { id: fieldId, active: true }, select: { id: true, companyId: true } });
    if (!f) throw new NotFoundException('Campo no encontrado');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(f.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.comments !== undefined) data.comments = dto.comments;
    return this.prisma.field.update({ where: { id: fieldId }, data });
  }

  async deleteField(fieldId: string, user: any) {
    const f = await this.prisma.field.findUnique({ where: { id: fieldId }, select: { id: true, companyId: true } });
    if (!f) throw new NotFoundException('Recurso no encontrado');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(f.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    return this.prisma.field.update({ where: { id: fieldId }, data: { active: false } });
  }

  // ===================== LOTS (Inside Fields) =====================
  async listLotsByField(fieldId: string) {
    return this.prisma.lot.findMany({
      where: { fieldId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createLot(fieldId: string, companyId: string, dto: any) {
    if (!dto.name?.trim()) throw new BadRequestException('Nombre requerido');
    if (dto.lat == null || dto.lng == null) throw new BadRequestException('Ubicación requerida');
    return this.prisma.lot.create({
      data: {
        name: dto.name.trim(),
        companyId,
        fieldId,
        hectares: dto.hectares || null,
        lat: dto.lat, lng: dto.lng,
        comments: dto.comments || null,
      },
    });
  }

  async updateLot(lotId: string, dto: any, user: any) {
    const l = await this.prisma.lot.findFirst({
      where: { id: lotId, active: true },
      select: { id: true, companyId: true, field: { select: { companyId: true } } },
    });
    if (!l) throw new NotFoundException('Lote no encontrado');
    const ownerCompanyId = l.field?.companyId || l.companyId;
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!ownerCompanyId || !myIds.includes(ownerCompanyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (dto.comments !== undefined) data.comments = dto.comments;
    return this.prisma.lot.update({ where: { id: lotId }, data });
  }

  async deleteLot(lotId: string, user: any) {
    const l = await this.prisma.lot.findUnique({
      where: { id: lotId },
      select: { id: true, companyId: true, field: { select: { companyId: true } } },
    });
    if (!l) throw new NotFoundException('Recurso no encontrado');
    const ownerCompanyId = l.field?.companyId || l.companyId;
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!ownerCompanyId || !myIds.includes(ownerCompanyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    return this.prisma.lot.update({ where: { id: lotId }, data: { active: false } });
  }

  // ===================== TRUCKS (Transporter) =====================
  async listTrucksByCompany(companyId: string) {
    return this.prisma.truck.findMany({
      where: { companyId, active: true },
      include: { assignedUser: { select: { id: true, name: true } } },
      orderBy: { plate: 'asc' },
    });
  }

  async createTruck(companyId: string, dto: any) {
    if (!dto.plate?.trim()) throw new BadRequestException('Patente requerida');
    const plate = dto.plate.trim().toUpperCase();
    const existing = await this.prisma.truck.findUnique({ where: { plate } });
    if (existing && existing.active) throw new BadRequestException(`La patente ${plate} ya está registrada`);
    if (existing && !existing.active && existing.companyId === companyId) {
      return this.prisma.truck.update({ where: { id: existing.id }, data: { active: true, brand: dto.brand || existing.brand, model: dto.model || existing.model } });
    }
    if (existing) throw new BadRequestException(`La patente ${plate} ya está registrada`);
    return this.prisma.truck.create({
      data: {
        plate,
        brand: dto.brand || null,
        model: dto.model || null,
        capacity: dto.capacity || null,
        companyId,
      },
    });
  }

  async updateTruck(truckId: string, dto: any, user: any) {
    const t = await this.prisma.truck.findFirst({ where: { id: truckId, active: true }, select: { id: true, companyId: true } });
    if (!t) throw new NotFoundException('Vehículo no encontrado');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(t.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    const data: any = {};
    if (dto.plate !== undefined) {
      const normalized = dto.plate.trim().toUpperCase();
      const dup = await this.prisma.truck.findFirst({ where: { plate: normalized, id: { not: truckId }, active: true } });
      if (dup) throw new BadRequestException(`La patente ${normalized} ya está registrada`);
      data.plate = normalized;
    }
    if (dto.brand !== undefined) data.brand = dto.brand;
    if (dto.model !== undefined) data.model = dto.model;
    if (dto.capacity !== undefined) data.capacity = dto.capacity;
    return this.prisma.truck.update({ where: { id: truckId }, data });
  }

  async deleteTruck(truckId: string, user: any) {
    const t = await this.prisma.truck.findUnique({ where: { id: truckId }, select: { id: true, companyId: true } });
    if (!t) throw new NotFoundException('Recurso no encontrado');
    if (!this.isPlatformAdmin(user)) {
      const myIds = await this.getUserCompanyIds(user);
      if (!myIds.includes(t.companyId)) throw new ForbiddenException('No tenés acceso a este recurso');
    }
    // Prevent deactivation if truck has active/accepted assignments
    const activeAssignments = await this.prisma.freightAssignment.count({
      where: { truckId, status: { in: ['active', 'accepted'] } },
    });
    if (activeAssignments > 0) {
      throw new BadRequestException(`No se puede eliminar: el camión tiene ${activeAssignments} asignación(es) activa(s)`);
    }
    return this.prisma.truck.update({ where: { id: truckId }, data: { active: false } });
  }

  // ==================== BULK IMPORT ====================

  async importCompanies(rows: any[]) {
    const typeMap: Record<string, string> = { planta: 'plant', productor: 'producer', transportista: 'transporter' };
    const results: { imported: number; errors: { row: number; name: string; error: string }[] } = { imported: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.name?.toString().trim();
      if (!name) { results.errors.push({ row: i + 1, name: '(vacío)', error: 'Nombre requerido' }); continue; }

      const rawType = r.type?.toString().trim().toLowerCase();
      const type = typeMap[rawType];
      if (!type) { results.errors.push({ row: i + 1, name, error: `Tipo inválido: ${r.type || '(vacío)'}` }); continue; }

      const existing = await this.prisma.company.findFirst({ where: { name: { equals: name, mode: 'insensitive' } } });
      if (existing) { results.errors.push({ row: i + 1, name, error: 'Empresa ya existe' }); continue; }

      try {
        await (this.prisma.company as any).create({
          data: {
            name,
            type,
            types: [type],
            email: r.email?.toString().trim() || null,
            phone: r.phone?.toString().trim() || null,
            rut: r.rut?.toString().trim() || null,
            hasInternalFleet: r.hasInternalFleet === true,
          },
        });
        results.imported++;
      } catch (e: any) {
        results.errors.push({ row: i + 1, name, error: e.message?.slice(0, 120) || 'Error desconocido' });
      }
    }
    return results;
  }

  async importUsers(rows: any[]) {
    const roleMap: Record<string, { userRole: string; membershipRole: string }> = {
      operario: { userRole: 'operator', membershipRole: 'operario' },
      gerente: { userRole: 'admin', membershipRole: 'gerente' },
      chofer: { userRole: 'operator', membershipRole: 'chofer' },
    };
    const results: { imported: number; errors: { row: number; email: string; error: string }[] } = { imported: 0, errors: [] };

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const name = r.name?.toString().trim();
      const email = r.email?.toString().trim().toLowerCase();
      const password = r.password?.toString().trim();
      const companyName = r.companyName?.toString().trim();
      const rawRole = r.role?.toString().trim().toLowerCase();

      if (!name || !email) { results.errors.push({ row: i + 1, email: email || '(vacío)', error: 'Nombre y email requeridos' }); continue; }
      if (!password || password.length < 6) { results.errors.push({ row: i + 1, email, error: 'Contraseña requerida (mín 6 caracteres)' }); continue; }
      if (!companyName) { results.errors.push({ row: i + 1, email, error: 'Empresa requerida' }); continue; }

      const roleDef = roleMap[rawRole];
      if (!roleDef) { results.errors.push({ row: i + 1, email, error: `Rol inválido: ${r.role || '(vacío)'}` }); continue; }

      const company = await this.prisma.company.findFirst({ where: { name: { equals: companyName, mode: 'insensitive' }, active: true } });
      if (!company) { results.errors.push({ row: i + 1, email, error: `Empresa no encontrada: ${companyName}` }); continue; }

      const existing = await this.prisma.user.findUnique({ where: { email } });
      if (existing) { results.errors.push({ row: i + 1, email, error: 'Email ya registrado' }); continue; }

      try {
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const companyType = (company as any).type;
        const userTypes = [companyType];
        const companyByType: Record<string, string> = { [companyType]: company.id };
        const roleByType: Record<string, string> = { [companyType]: roleDef.userRole };

        const user = await this.prisma.user.create({
          data: {
            name,
            email,
            phone: r.phone?.toString().trim() || null,
            passwordHash: hash,
            role: roleDef.userRole as any,
            userTypes,
            companyId: company.id,
            activeCompanyId: company.id,
            companyByType,
            roleByType,
          },
        });

        await (this.prisma as any).userCompany.create({
          data: { userId: user.id, companyId: company.id, role: roleDef.membershipRole },
        }).catch(() => {});

        results.imported++;
      } catch (e: any) {
        const msg = handlePrismaUniqueError(e, { email: 'email', phone: 'teléfono' });
        results.errors.push({ row: i + 1, email, error: msg || e.message?.slice(0, 120) || 'Error desconocido' });
      }
    }
    return results;
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Throttle({ default: { ttl: 60000, limit: 30 } })
@Controller('admin')
export class AdminController {
  constructor(private svc: AdminService) {}

  // --- Activity log ---
  @Get('activity')
  @ApiOperation({ summary: 'Actividad reciente de la empresa' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async activity(
    @CurrentUser() u: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.getActivity(fullUser, parseInt(page || '1') || 1, Math.min(parseInt(limit || '20') || 20, 50));
  }

  // --- Stats (platform_admin only) ---
  @Get('stats')
  @ApiOperation({ summary: 'Dashboard stats' })
  async stats(@CurrentUser() u: any) {
    await this.svc.assertPlatformAdmin(u);
    return this.svc.getStats();
  }

  // --- Companies ---
  @Get('companies')
  @ApiOperation({ summary: 'Listar empresas' })
  @ApiQuery({ name: 'search', required: false })
  async companies(@CurrentUser() u: any, @Query('search') search?: string) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.listCompanies(search, fullUser);
  }

  @Get('companies/:id')
  @ApiOperation({ summary: 'Detalle de empresa' })
  async company(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.getCompany(id, fullUser);
  }

  @Post('companies')
  @ApiOperation({ summary: 'Crear empresa (solo platform_admin)' })
  async createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() u: any) {
    await this.svc.assertPlatformAdmin(u);
    return this.svc.createCompany(dto);
  }

  @Patch('companies/:id')
  @ApiOperation({ summary: 'Editar empresa' })
  async updateCompany(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateCompany(id, dto, fullUser);
  }

  // --- Branches ---
  @Get('branches/:companyId')
  @ApiOperation({ summary: 'Listar sucursales de empresa' })
  async branches(@Param('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    // Non-superadmin: verify they belong to this company
    if (!this.svc.isPlatformAdmin(fullUser)) {
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso');
    }
    return this.svc.listBranches(companyId);
  }

  @Post('branches')
  @ApiOperation({ summary: 'Crear sucursal' })
  async createBranch(@Body() dto: CreateBranchDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    // Non-superadmin: verify they own the target company
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(dto.companyId)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    return this.svc.createBranch(dto);
  }

  @Patch('branches/:id')
  @ApiOperation({ summary: 'Editar sucursal' })
  async updateBranch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBranchDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateBranch(id, dto, fullUser);
  }

  @Delete('branches/:id')
  @ApiOperation({ summary: 'Desactivar sucursal' })
  async deleteBranch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.deleteBranch(id, fullUser);
  }

  // --- Users ---
  @Get('users')
  @ApiOperation({ summary: 'Listar usuarios' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'companyId', required: false })
  async users(@CurrentUser() u: any, @Query('search') search?: string, @Query('companyId') companyId?: string) {
    if (companyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new BadRequestException('companyId inválido');
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.listUsers(search, companyId, fullUser);
  }

  @Post('users')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Crear usuario' })
  async createUser(@Body() dto: CreateUserDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    // Company admins can only create users for their own company
    if (!this.svc.isPlatformAdmin(u)) {
      const freshUser = await this.svc.prisma.user.findUnique({
        where: { id: u.sub },
        select: { companyId: true, activeCompanyId: true },
      });
      if (!freshUser) throw new ForbiddenException('Usuario no encontrado');
      dto.companyId = freshUser.activeCompanyId || freshUser.companyId;
      dto.companyByType = undefined;
      dto.roleByType = undefined;
      if (dto.role === 'platform_admin') throw new ForbiddenException('No podés asignar este rol');
    }
    return this.svc.createUser(dto);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Editar usuario' })
  async updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.updateUser(id, dto, u);
  }

  // --- User membership management ---
  @Post('users/:userId/companies')
  @ApiOperation({ summary: 'Agregar empresa a usuario' })
  async addUserCompany(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() body: { companyId: string; role?: string },
    @CurrentUser() u: any,
  ) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.addUserCompany(userId, body.companyId, body.role || 'operario', u);
  }

  @Patch('users/:userId/companies/:companyId')
  @ApiOperation({ summary: 'Editar rol de usuario en empresa' })
  async updateUserCompany(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() body: { role: string },
    @CurrentUser() u: any,
  ) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.updateUserCompany(userId, companyId, body.role, u);
  }

  @Delete('users/:userId/companies/:companyId')
  @ApiOperation({ summary: 'Quitar empresa de usuario' })
  async removeUserCompany(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @CurrentUser() u: any,
  ) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.removeUserCompany(userId, companyId, u);
  }

  // --- Self edit (any user) ---
  @Patch('me')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({ summary: 'Editar mi perfil' })
  updateMe(@Body() dto: UpdateSelfDto, @CurrentUser() u: any) {
    return this.svc.updateSelf(u.sub, dto);
  }

  // ===================== FIELDS (Producer) =====================
  @Get('companies/:companyId/fields')
  @ApiOperation({ summary: 'Listar campos de empresa productora' })
  async companyFields(@Param('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    return this.svc.listFieldsByCompany(companyId);
  }

  @Post('companies/:companyId/fields')
  @ApiOperation({ summary: 'Crear campo' })
  async createCompanyField(@Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: AdminCreateFieldDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    return this.svc.createField(companyId, dto);
  }

  @Patch('fields/:id')
  @ApiOperation({ summary: 'Editar campo' })
  async updateAdminField(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFieldDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateField(id, dto, fullUser);
  }

  @Delete('fields/:id')
  @ApiOperation({ summary: 'Desactivar campo' })
  async deleteAdminField(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.deleteField(id, fullUser);
  }

  // ===================== LOTS =====================
  @Get('fields/:fieldId/lots')
  @ApiOperation({ summary: 'Listar lotes de campo' })
  async fieldLots(@Param('fieldId', ParseUUIDPipe) fieldId: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const field = await this.svc.prisma.field.findUnique({ where: { id: fieldId }, select: { companyId: true } });
      if (!field || !myIds.includes(field.companyId)) throw new ForbiddenException('Sin acceso a este campo');
    }
    return this.svc.listLotsByField(fieldId);
  }

  @Post('fields/:fieldId/lots')
  @ApiOperation({ summary: 'Crear lote en campo' })
  async createFieldLot(@Param('fieldId', ParseUUIDPipe) fieldId: string, @Body() dto: AdminCreateLotDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const field = await this.svc.prisma.field.findUnique({ where: { id: fieldId }, select: { id: true, companyId: true } });
    if (!field) throw new NotFoundException('Campo no encontrado');
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(field.companyId)) throw new ForbiddenException('Sin acceso a este campo');
    }
    return this.svc.createLot(fieldId, field.companyId, dto);
  }

  @Patch('lots/:id')
  @ApiOperation({ summary: 'Editar lote' })
  async updateAdminLot(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLotDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateLot(id, dto, fullUser);
  }

  @Delete('lots/:id')
  @ApiOperation({ summary: 'Desactivar lote' })
  async deleteAdminLot(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.deleteLot(id, fullUser);
  }

  // ===================== TRUCKS (Transporter) =====================
  @Get('companies/:companyId/trucks')
  @ApiOperation({ summary: 'Listar flota de empresa transportista' })
  async companyTrucks(@Param('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    return this.svc.listTrucksByCompany(companyId);
  }

  @Post('companies/:companyId/trucks')
  @ApiOperation({ summary: 'Crear vehículo' })
  async createCompanyTruck(@Param('companyId', ParseUUIDPipe) companyId: string, @Body() dto: AdminCreateTruckDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso a esta empresa');
    }
    return this.svc.createTruck(companyId, dto);
  }

  @Patch('trucks/:id')
  @ApiOperation({ summary: 'Editar vehículo' })
  async updateAdminTruck(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAdminTruckDto, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateTruck(id, dto, fullUser);
  }

  @Delete('trucks/:id')
  @ApiOperation({ summary: 'Desactivar vehículo' })
  async deleteAdminTruck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.deleteTruck(id, fullUser);
  }

  // ==================== BULK IMPORT ====================

  @Post('import/companies')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Importar empresas desde Excel (batch)' })
  async importCompanies(@Body() body: { companies: any[] }, @CurrentUser() u: any) {
    await this.svc.assertPlatformAdmin(u);
    if (!Array.isArray(body.companies) || body.companies.length === 0) throw new BadRequestException('Lista de empresas vacía');
    if (body.companies.length > 200) throw new BadRequestException('Máximo 200 empresas por importación');
    return this.svc.importCompanies(body.companies);
  }

  @Post('import/users')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Importar usuarios desde Excel (batch)' })
  async importUsers(@Body() body: { users: any[] }, @CurrentUser() u: any) {
    await this.svc.assertCompanyOrPlatformAdmin(u);
    if (!Array.isArray(body.users) || body.users.length === 0) throw new BadRequestException('Lista de usuarios vacía');
    if (body.users.length > 200) throw new BadRequestException('Máximo 200 usuarios por importación');
    return this.svc.importUsers(body.users);
  }
}
