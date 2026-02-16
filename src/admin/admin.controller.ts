// =====================================================================
// TOLVINK — Admin Controller + Service
// Platform administration: users, companies, linking
// Only accessible by platform_admin / isSuperAdmin
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsEmail, IsUUID, IsBoolean, IsArray, MaxLength, MinLength, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ======================== DTOs =======================================

export class CreateCompanyDto {
  @ApiProperty({ example: 'Agro Sur S.A.' })
  @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ enum: ['producer', 'plant', 'transporter'] })
  @IsNotEmpty()
  type: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(255)
  address?: string;

  @ApiProperty({ required: false }) @IsOptional() @MaxLength(50)
  phone?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsEmail()
  email?: string;

  @ApiProperty({ required: false, default: false }) @IsOptional() @IsBoolean()
  hasInternalFleet?: boolean;
}

export class LinkUserDto {
  @ApiProperty() @IsUUID()
  userId: string;

  @ApiProperty() @IsUUID()
  companyId: string;

  @ApiProperty({ required: false, default: 'operator' }) @IsOptional()
  role?: string;
}

export class UpdateUserAdminDto {
  @ApiProperty({ required: false }) @IsOptional() @IsString()
  name?: string;

  @ApiProperty({ required: false }) @IsOptional()
  role?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsArray()
  userTypes?: string[];

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  isSuperAdmin?: boolean;

  @ApiProperty({ required: false }) @IsOptional() @IsBoolean()
  active?: boolean;
}

// ======================== SERVICE ====================================

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService) {}

  private assertAdmin(user: any) {
    if (user.role !== 'platform_admin') {
      throw new ForbiddenException('Solo administradores de plataforma');
    }
  }

  // ---- Companies ----

  async listCompanies(search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.company.findMany({
      where,
      include: { _count: { select: { users: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createCompany(dto: CreateCompanyDto) {
    return this.prisma.company.create({
      data: {
        name: dto.name,
        type: dto.type as any,
        address: dto.address,
        phone: dto.phone,
        email: dto.email,
        hasInternalFleet: dto.hasInternalFleet || false,
      },
    });
  }

  async updateCompany(id: string, dto: Partial<CreateCompanyDto>) {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.phone !== undefined) data.phone = dto.phone;
    if (dto.email !== undefined) data.email = dto.email;
    if (dto.hasInternalFleet !== undefined) data.hasInternalFleet = dto.hasInternalFleet;

    return this.prisma.company.update({ where: { id }, data });
  }

  // ---- Users ----

  async listUsers(search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }
    return this.prisma.user.findMany({
      where,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, isSuperAdmin: true, active: true,
        companyId: true, lastLogin: true, createdAt: true,
        company: { select: { id: true, name: true, type: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateUser(userId: string, dto: UpdateUserAdminDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.userTypes !== undefined) data.userTypes = dto.userTypes;
    if (dto.isSuperAdmin !== undefined) data.isSuperAdmin = dto.isSuperAdmin;
    if (dto.active !== undefined) data.active = dto.active;

    return this.prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, isSuperAdmin: true, active: true, companyId: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });
  }

  // ---- Link user to company ----

  async linkUserToCompany(dto: LinkUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const company = await this.prisma.company.findUnique({ where: { id: dto.companyId } });
    if (!company) throw new NotFoundException('Empresa no encontrada');

    // Update user's main company
    const updated = await this.prisma.user.update({
      where: { id: dto.userId },
      data: {
        companyId: dto.companyId,
        role: (dto.role as any) || 'operator',
      },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, isSuperAdmin: true, active: true, companyId: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });

    return updated;
  }

  async unlinkUser(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    return this.prisma.user.update({
      where: { id: userId },
      data: { companyId: null },
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        userTypes: true, isSuperAdmin: true, active: true, companyId: true,
        company: { select: { id: true, name: true, type: true } },
      },
    });
  }

  // ---- Dashboard stats ----

  async getStats() {
    const [users, companies, freights, unlinked] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.company.count(),
      this.prisma.freight.count(),
      this.prisma.user.count({ where: { companyId: null } }),
    ]);
    return { users, companies, freights, unlinkedUsers: unlinked };
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private service: AdminService) {}

  private check(user: any) {
    if (user.role !== 'platform_admin') {
      throw new ForbiddenException('Solo administradores de plataforma');
    }
  }

  // Stats
  @Get('stats')
  @ApiOperation({ summary: 'Dashboard stats' })
  stats(@CurrentUser() user: any) { this.check(user); return this.service.getStats(); }

  // Companies
  @Get('companies')
  @ApiOperation({ summary: 'Listar empresas' })
  @ApiQuery({ name: 'search', required: false })
  companies(@CurrentUser() user: any, @Query('search') search?: string) {
    this.check(user); return this.service.listCompanies(search);
  }

  @Post('companies')
  @ApiOperation({ summary: 'Crear empresa' })
  createCompany(@Body() dto: CreateCompanyDto, @CurrentUser() user: any) {
    this.check(user); return this.service.createCompany(dto);
  }

  @Patch('companies/:id')
  @ApiOperation({ summary: 'Editar empresa' })
  updateCompany(@Param('id', ParseUUIDPipe) id: string, @Body() dto: Partial<CreateCompanyDto>, @CurrentUser() user: any) {
    this.check(user); return this.service.updateCompany(id, dto);
  }

  // Users
  @Get('users')
  @ApiOperation({ summary: 'Listar usuarios' })
  @ApiQuery({ name: 'search', required: false })
  users(@CurrentUser() user: any, @Query('search') search?: string) {
    this.check(user); return this.service.listUsers(search);
  }

  @Patch('users/:id')
  @ApiOperation({ summary: 'Editar usuario' })
  updateUser(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateUserAdminDto, @CurrentUser() user: any) {
    this.check(user); return this.service.updateUser(id, dto);
  }

  // Link / Unlink
  @Post('link-user')
  @ApiOperation({ summary: 'Vincular usuario a empresa' })
  linkUser(@Body() dto: LinkUserDto, @CurrentUser() user: any) {
    this.check(user); return this.service.linkUserToCompany(dto);
  }

  @Patch('users/:id/unlink')
  @ApiOperation({ summary: 'Desvincular usuario de empresa' })
  unlinkUser(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    this.check(user); return this.service.unlinkUser(id);
  }
}
