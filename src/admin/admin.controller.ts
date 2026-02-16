// =====================================================================
// TOLVINK — Admin Module (Controller + Service + DTOs)
// Simple, clean, no over-engineering
// Roles: platform_admin (super), admin (company manager), operator (user)
// =====================================================================

import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe, Delete,
} from '@nestjs/common';
import {
  Injectable, BadRequestException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import {
  IsNotEmpty, IsOptional, IsString, IsEmail, IsUUID,
  IsBoolean, IsArray, MaxLength, MinLength, IsNumber,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs =======================================

export class CreateCompanyDto {
  @ApiProperty() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ enum: ['producer', 'plant', 'transporter'] }) @IsNotEmpty()
  type: string;

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
  @ApiProperty() @IsNotEmpty() @MinLength(2)
  name: string;

  @ApiProperty() @IsEmail()
  email: string;

  @ApiProperty({ required: false }) @IsOptional() @IsString()
  phone?: string;

  @ApiProperty() @IsNotEmpty() @MinLength(4)
  password: string;

  @ApiProperty({ required: false }) @IsOptional() @IsArray()
  userTypes?: string[];

  @ApiProperty({ required: false, enum: ['operator', 'admin', 'platform_admin'] })
  @IsOptional()
  role?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsUUID()
  companyId?: string;
}

export class UpdateUserDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString() name?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsEmail() email?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsString() phone?: string;
  @ApiProperty({ required: false }) @IsOptional() role?: string;
  @ApiProperty({ required: false }) @IsOptional() @IsArray() userTypes?: string[];
  @ApiProperty({ required: false }) @IsOptional() @IsBoolean() active?: boolean;
  @ApiProperty({ required: false }) @IsOptional() @IsUUID() companyId?: string;
  @ApiProperty({ required: false }) @IsOptional() companyByType?: any;
  @ApiProperty({ required: false }) @IsOptional() roleByType?: any;
}

// ======================== SERVICE ====================================

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  // --- Permission helpers ---
  isPlatformAdmin(user: any): boolean {
    return user.role === 'platform_admin';
  }

  isCompanyAdmin(user: any): boolean {
    return user.role === 'admin';
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

  // Extract all company IDs a user belongs to (from companyId + companyByType)
  getUserCompanyIds(user: any): string[] {
    const ids = new Set<string>();
    if (user.companyId) ids.add(user.companyId);
    if (user.companyByType && typeof user.companyByType === 'object') {
      Object.values(user.companyByType).forEach((v: any) => { if (v) ids.add(v); });
    }
    return Array.from(ids);
  }

  // Fetch full user from DB (JWT only has sub, role, companyId)
  async resolveFullUser(jwtUser: any): Promise<any> {
    if (this.isPlatformAdmin(jwtUser)) return jwtUser;
    const full = await this.prisma.user.findUnique({
      where: { id: jwtUser.sub },
      select: { id: true, role: true, companyId: true, companyByType: true, roleByType: true, userTypes: true, isSuperAdmin: true },
    });
    if (!full) throw new ForbiddenException('Usuario no encontrado');
    return { ...jwtUser, ...full, sub: full.id };
  }

  // --- Stats ---
  async getStats() {
    const [users, companies, branches, freights] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.company.count(),
      this.prisma.branch.count(),
      this.prisma.freight.count(),
    ]);
    return { users, companies, branches, freights };
  }

  // --- Companies ---
  async listCompanies(search?: string, callerUser?: any) {
    const where: any = {};

    // Non-superadmin: only see their own companies
    if (callerUser && !this.isPlatformAdmin(callerUser)) {
      const myIds = this.getUserCompanyIds(callerUser);
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
      const myIds = this.getUserCompanyIds(callerUser);
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
    return this.prisma.company.create({
      data: {
        name: dto.name,
        type: dto.type as any,
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

  async updateCompany(id: string, dto: Partial<CreateCompanyDto>, user: any) {
    // Non-superadmin can only edit companies they belong to
    if (!this.isPlatformAdmin(user)) {
      const myIds = this.getUserCompanyIds(user);
      if (!myIds.includes(id)) throw new ForbiddenException('No podés editar esta empresa');
    }
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.rut !== undefined) data.rut = dto.rut;
    if (dto.hasInternalFleet !== undefined) data.hasInternalFleet = dto.hasInternalFleet;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.company.update({ where: { id }, data });
  }

  // --- Branches ---
  async listBranches(companyId: string) {
    return this.prisma.branch.findMany({
      where: { companyId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  async createBranch(dto: CreateBranchDto) {
    const company = await this.prisma.company.findUnique({ where: { id: dto.companyId } });
    if (!company) throw new BadRequestException('Empresa no encontrada');

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

  async updateBranch(id: string, dto: Partial<CreateBranchDto>) {
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

  // --- Users ---
  async listUsers(search?: string, companyId?: string, callerUser?: any) {
    const where: any = {};

    // Non-superadmin: only see users from their own companies
    if (callerUser && !this.isPlatformAdmin(callerUser)) {
      const myIds = this.getUserCompanyIds(callerUser);
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
        companyByType: true, roleByType: true,
        createdAt: true,
        company: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createUser(dto: CreateUserDto) {
    const bcrypt = require('bcryptjs');

    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) throw new BadRequestException('Email ya registrado');

    if (dto.phone) {
      const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
      if (phoneExists) throw new BadRequestException('Teléfono ya registrado');
    }

    if (dto.companyId) {
      const c = await this.prisma.company.findUnique({ where: { id: dto.companyId } });
      if (!c) throw new BadRequestException('Empresa no encontrada');
    }

    const hash = await bcrypt.hash(dto.password, 10);

    return this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        phone: dto.phone || null,
        passwordHash: hash,
        role: (dto.role as any) || 'operator',
        userTypes: dto.userTypes || [],
        companyId: dto.companyId || null,
      },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });
  }

  async updateUser(userId: string, dto: UpdateUserDto, callerUser: any) {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('Usuario no encontrado');

    // Non-platform-admins can only edit users in their own company (or themselves)
    if (!this.isPlatformAdmin(callerUser)) {
      if (callerUser.companyId !== target.companyId && callerUser.sub !== userId) {
        throw new ForbiddenException('No podés editar este usuario');
      }
      // Company admins can't set platform_admin role
      if (dto.role === 'platform_admin') {
        throw new ForbiddenException('No podés asignar rol de administrador principal');
      }
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

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });
  }

  // Self-edit: any user can edit their own name/email/phone
  async updateSelf(userId: string, dto: { name?: string; email?: string; phone?: string }) {
    const data: any = {};
    if (dto.name) data.name = dto.name;
    if (dto.email) data.email = dto.email;
    if (dto.phone) data.phone = dto.phone;
    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, active: true, companyId: true, companyByType: true, roleByType: true,
        company: { select: { id: true, name: true, type: true, hasInternalFleet: true } },
      },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
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
  async updateCompany(@Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<CreateCompanyDto>, @CurrentUser() u: any) {
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
      const myIds = this.svc.getUserCompanyIds(fullUser);
      if (!myIds.includes(companyId)) throw new ForbiddenException('Sin acceso');
    }
    return this.svc.listBranches(companyId);
  }

  @Post('branches')
  @ApiOperation({ summary: 'Crear sucursal' })
  createBranch(@Body() dto: CreateBranchDto, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.createBranch(dto);
  }

  @Patch('branches/:id')
  @ApiOperation({ summary: 'Editar sucursal' })
  updateBranch(@Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<CreateBranchDto>, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.updateBranch(id, dto);
  }

  @Delete('branches/:id')
  @ApiOperation({ summary: 'Desactivar sucursal' })
  deleteBranch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    return this.svc.deleteBranch(id);
  }

  // --- Users ---
  @Get('users')
  @ApiOperation({ summary: 'Listar usuarios' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'companyId', required: false })
  async users(@CurrentUser() u: any, @Query('search') search?: string, @Query('companyId') companyId?: string) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    const fullUser = await this.svc.resolveFullUser(u);
    return this.svc.listUsers(search, companyId, fullUser);
  }

  @Post('users')
  @ApiOperation({ summary: 'Crear usuario' })
  createUser(@Body() dto: CreateUserDto, @CurrentUser() u: any) {
    this.svc.assertCompanyOrPlatformAdmin(u);
    // Company admins can only create users for their own company
    if (!this.svc.isPlatformAdmin(u)) {
      dto.companyId = u.companyId;
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
  @ApiOperation({ summary: 'Editar mi perfil' })
  updateMe(@Body() dto: { name?: string; email?: string; phone?: string }, @CurrentUser() u: any) {
    return this.svc.updateSelf(u.sub, dto);
  }
}
