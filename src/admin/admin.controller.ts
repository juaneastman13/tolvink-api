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
    return user.role === 'platform_admin';
  }

  isCompanyAdmin(user: any): boolean {
    return user.role === 'admin' || user.role === 'gerente';
  }

  assertPlatformAdmin(user: any) {
    if (!this.isPlatformAdmin(user)) {
      throw new ForbiddenException('Solo administradores de plataforma');
    }
  }

  assertCompanyOrPlatformAdmin(user: any) {
    if (!this.isPlatformAdmin(user) && !this.isCompanyAdmin(user)) {
      throw new ForbiddenException('Permisos insuficientes');
    }
  }

  async getUserCompanyIds(user: any): Promise<string[]> {
    return this.companyRes.resolveAllCompanyIds({ sub: user.sub || user.id, companyId: user.companyId });
  }

  // Fetch full user from DB (JWT only has sub, role, companyId)
  async resolveFullUser(jwtUser: any): Promise<any> {
    if (this.isPlatformAdmin(jwtUser)) {
      const adminCheck = await this.prisma.user.findUnique({ where: { id: jwtUser.sub }, select: { active: true, role: true } });
      if (!adminCheck || !adminCheck.active || adminCheck.role !== 'platform_admin') {
        throw new UnauthorizedException('Usuario desactivado o sin permisos');
      }
      return jwtUser;
    }
    const full = await this.prisma.user.findUnique({
      where: { id: jwtUser.sub },
      select: { id: true, role: true, companyId: true, isSuperAdmin: true, active: true },
    });
    if (!full || !full.active) throw new ForbiddenException('Usuario no encontrado');
    return { ...jwtUser, ...full, sub: full.id };
  }

  // --- Stats (cached 60s) ---
  private _statsCache: { data: any; ts: number } | null = null;
  async getStats() {
    const now = Date.now();
    if (this._statsCache && now - this._statsCache.ts < 60000) return this._statsCache.data;
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

  async updateBranch(id: string, dto: UpdateBranchDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id } });
    if (!branch) throw new NotFoundException('Sucursal no encontrada');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.reference !== undefined) data.reference = dto.reference;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.branch.update({ where: { id }, data });
  }

  async deleteBranch(id: string) {
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
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
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
    const hash = preHashedPassword || await bcrypt.hash(dto.password, 10);

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
      if (err.code === 'P2002') {
        throw new BadRequestException('Ya existe un usuario con ese email o teléfono');
      }
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
      if (e?.code === 'P2002') {
        const field = e.meta?.target?.[0] || 'email o teléfono';
        throw new BadRequestException(`Ya existe un usuario con ese ${field}`);
      }
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

  async updateField(fieldId: string, dto: any) {
    const f = await this.prisma.field.findFirst({ where: { id: fieldId, active: true } });
    if (!f) throw new NotFoundException('Campo no encontrado');
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.comments !== undefined) data.comments = dto.comments;
    return this.prisma.field.update({ where: { id: fieldId }, data });
  }

  async deleteField(fieldId: string) {
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

  async updateLot(lotId: string, dto: any) {
    const l = await this.prisma.lot.findFirst({ where: { id: lotId, active: true } });
    if (!l) throw new NotFoundException('Lote no encontrado');
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;
    if (dto.comments !== undefined) data.comments = dto.comments;
    return this.prisma.lot.update({ where: { id: lotId }, data });
  }

  async deleteLot(lotId: string) {
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

  async updateTruck(truckId: string, dto: any) {
    const t = await this.prisma.truck.findFirst({ where: { id: truckId, active: true } });
    if (!t) throw new NotFoundException('Vehículo no encontrado');
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

  async deleteTruck(truckId: string) {
    return this.prisma.truck.update({ where: { id: truckId }, data: { active: false } });
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

  // --- Stats (platform_admin only) ---
  @Get('stats')
  @ApiOperation({ summary: 'Dashboard stats' })
  stats(@CurrentUser() u: any) {
    this.svc.assertPlatformAdmin(u);
    return this.svc.getStats();
  }

  // --- Companies ---
  @Get('companies')
  @ApiOperation({ summary: 'Listar empresas' })
  @ApiQuery({ name: 'search', required: false })
  async companies(@CurrentUser() u: any, @Query('search') search?: string) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.listCompanies(search, fullUser);
  }

  @Get('companies/:id')
  @ApiOperation({ summary: 'Detalle de empresa' })
  async company(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.getCompany(id, fullUser);
  }

  @Post('companies')
  @ApiOperation({ summary: 'Crear empresa (solo platform_admin)' })
  createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() u: any) {
    this.svc.assertPlatformAdmin(u);
    return this.svc.createCompany(dto);
  }

  @Patch('companies/:id')
  @ApiOperation({ summary: 'Editar empresa' })
  async updateCompany(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCompanyDto, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.updateCompany(id, dto, fullUser);
  }

  // --- Branches ---
  @Get('branches/:companyId')
  @ApiOperation({ summary: 'Listar sucursales de empresa' })
  async branches(@Param('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const branch = await this.svc.getBranchCompanyId(id);
      if (!branch || !myIds.includes(branch)) throw new ForbiddenException('Sin acceso a esta sucursal');
    }
    return this.svc.updateBranch(id, dto);
  }

  @Delete('branches/:id')
  @ApiOperation({ summary: 'Desactivar sucursal' })
  async deleteBranch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const branch = await this.svc.getBranchCompanyId(id);
      if (!branch || !myIds.includes(branch)) throw new ForbiddenException('Sin acceso a esta sucursal');
    }
    return this.svc.deleteBranch(id);
  }

  // --- Users ---
  @Get('users')
  @ApiOperation({ summary: 'Listar usuarios' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'companyId', required: false })
  async users(@CurrentUser() u: any, @Query('search') search?: string, @Query('companyId') companyId?: string) {
    if (companyId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) throw new BadRequestException('companyId inválido');
    this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.listUsers(search, companyId, fullUser);
  }

  @Post('users')
  @ApiOperation({ summary: 'Crear usuario' })
  async createUser(@Body() dto: CreateUserDto, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
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
  updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.updateUser(id, dto, u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const field = await this.svc.prisma.field.findUnique({ where: { id }, select: { companyId: true } });
      if (!field || !myIds.includes(field.companyId)) throw new ForbiddenException('Sin acceso a este campo');
    }
    return this.svc.updateField(id, dto);
  }

  @Delete('fields/:id')
  @ApiOperation({ summary: 'Desactivar campo' })
  async deleteAdminField(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const field = await this.svc.prisma.field.findUnique({ where: { id }, select: { companyId: true } });
      if (!field || !myIds.includes(field.companyId)) throw new ForbiddenException('Sin acceso a este campo');
    }
    return this.svc.deleteField(id);
  }

  // ===================== LOTS =====================
  @Get('fields/:fieldId/lots')
  @ApiOperation({ summary: 'Listar lotes de campo' })
  async fieldLots(@Param('fieldId', ParseUUIDPipe) fieldId: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const lot = await this.svc.prisma.lot.findUnique({ where: { id }, select: { companyId: true } });
      if (!lot || !myIds.includes(lot.companyId)) throw new ForbiddenException('Sin acceso a este lote');
    }
    return this.svc.updateLot(id, dto);
  }

  @Delete('lots/:id')
  @ApiOperation({ summary: 'Desactivar lote' })
  async deleteAdminLot(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const lot = await this.svc.prisma.lot.findUnique({ where: { id }, select: { companyId: true } });
      if (!lot || !myIds.includes(lot.companyId)) throw new ForbiddenException('Sin acceso a este lote');
    }
    return this.svc.deleteLot(id);
  }

  // ===================== TRUCKS (Transporter) =====================
  @Get('companies/:companyId/trucks')
  @ApiOperation({ summary: 'Listar flota de empresa transportista' })
  async companyTrucks(@Param('companyId', ParseUUIDPipe) companyId: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
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
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const truck = await this.svc.prisma.truck.findUnique({ where: { id }, select: { companyId: true } });
      if (!truck || !myIds.includes(truck.companyId)) throw new ForbiddenException('Sin acceso a este vehículo');
    }
    return this.svc.updateTruck(id, dto);
  }

  @Delete('trucks/:id')
  @ApiOperation({ summary: 'Desactivar vehículo' })
  async deleteAdminTruck(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    if (!this.svc.isPlatformAdmin(u)) {
      const fullUser = await this.svc.resolveFullUser(u);
      const myIds = await this.svc.getUserCompanyIds(fullUser);
      const truck = await this.svc.prisma.truck.findUnique({ where: { id }, select: { companyId: true } });
      if (!truck || !myIds.includes(truck.companyId)) throw new ForbiddenException('Sin acceso a este vehículo');
    }
    return this.svc.deleteTruck(id);
  }
}
