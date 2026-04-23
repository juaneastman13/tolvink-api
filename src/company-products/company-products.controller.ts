// =====================================================================
// TOLVINK — Company Products Module (Controller + Service + DTOs)
// Each company maintains its own product/grain catalog for freight creation.
//
// PERMISSION DECISION:
//   WRITE operations (create/update/toggle) require role 'gerente', 'admin', or 'platform_admin'.
//   These roles represent "company manager" level in the system:
//     - 'gerente'        = company manager (UserCompany.role string value, used in JWT)
//     - 'admin'          = legacy Prisma UserRole, also maps to company manager
//     - 'platform_admin' = super admin, full access
//   No new roles were introduced — the existing 'gerente' tier already covers this use case.
//
//   READ operations (list) require only valid authentication.
//   Any logged-in user can read their company's active products (needed for freight creation).
//
// MULTI-TENANT SAFETY:
//   All queries are scoped to user.companyId from the JWT.
//   platform_admin can optionally query any company via ?forCompanyId= param.
// =====================================================================

import {
  Controller, Get, Post, Patch, Param, Body, Query,
  UseGuards, ParseUUIDPipe, ForbiddenException, NotFoundException, BadRequestException,
  Injectable, Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsNumber, MaxLength, Min, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

// ── Roles that can manage the product catalog (write access) ──
// Intentionally NOT introducing new roles — these already exist in the system.
const CATALOG_MANAGER_ROLES = ['gerente', 'admin', 'platform_admin'];

// ======================== DTOs ========================================

export class CreateCompanyProductDto {
  @ApiProperty({ example: 'Soja', description: 'Product name (max 100 chars)' })
  @IsNotEmpty({ message: 'El nombre del producto es obligatorio' })
  @IsString()
  @MaxLength(100, { message: 'Nombre máximo 100 caracteres' })
  name: string;

  @ApiProperty({ required: false, example: 'SOJ', description: 'Short code (max 20 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiProperty({ required: false, enum: ['kg', 't', 'toneladas'], description: 'Default unit for freight creation' })
  @IsOptional()
  @IsString()
  @IsIn(['kg', 't', 'toneladas'])
  defaultUnit?: string;

  @ApiProperty({ required: false, example: 0, description: 'Display order (lower = first)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;
}

export class UpdateCompanyProductDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @ApiProperty({ required: false, enum: ['kg', 't', 'toneladas'] })
  @IsOptional()
  @IsString()
  @IsIn(['kg', 't', 'toneladas'])
  defaultUnit?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  sortOrder?: number;
}

// ======================== SERVICE =====================================

@Injectable()
export class CompanyProductsService {
  private readonly logger = new Logger(CompanyProductsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, activeOnly: boolean) {
    return this.prisma.companyProduct.findMany({
      where: {
        companyId,
        ...(activeOnly ? { isActive: true } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        code: true,
        defaultUnit: true,
        isActive: true,
        sortOrder: true,
        createdAt: true,
      },
    });
  }

  async create(companyId: string, userId: string, dto: CreateCompanyProductDto) {
    // Enforce name uniqueness within company (case-insensitive)
    const duplicate = await this.prisma.companyProduct.findFirst({
      where: { companyId, name: { equals: dto.name.trim(), mode: 'insensitive' } },
    });
    if (duplicate) {
      throw new BadRequestException(`Ya existe un producto llamado "${dto.name}" en esta empresa`);
    }

    // Auto-assign sort order after last if not provided
    let sortOrder = dto.sortOrder;
    if (sortOrder === undefined || sortOrder === null) {
      const agg = await this.prisma.companyProduct.aggregate({
        where: { companyId },
        _max: { sortOrder: true },
      });
      sortOrder = (agg._max.sortOrder ?? -1) + 1;
    }

    const product = await this.prisma.companyProduct.create({
      data: {
        companyId,
        name: dto.name.trim(),
        code: dto.code?.trim() || null,
        defaultUnit: dto.defaultUnit || null,
        isActive: true,
        sortOrder,
        createdById: userId,
      },
    });

    this.logger.log(`Product created: ${product.id} "${product.name}" company=${companyId}`);
    return product;
  }

  async update(id: string, companyId: string, dto: UpdateCompanyProductDto) {
    await this.assertOwnership(id, companyId);

    if (dto.name) {
      const duplicate = await this.prisma.companyProduct.findFirst({
        where: { companyId, name: { equals: dto.name.trim(), mode: 'insensitive' }, NOT: { id } },
      });
      if (duplicate) {
        throw new BadRequestException(`Ya existe un producto llamado "${dto.name}" en esta empresa`);
      }
    }

    return this.prisma.companyProduct.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code?.trim() || null } : {}),
        ...(dto.defaultUnit !== undefined ? { defaultUnit: dto.defaultUnit || null } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      },
    });
  }

  async toggle(id: string, companyId: string) {
    const product = await this.assertOwnership(id, companyId);
    const updated = await this.prisma.companyProduct.update({
      where: { id },
      data: { isActive: !product.isActive },
    });
    this.logger.log(`Product ${id} toggled to isActive=${updated.isActive}`);
    return updated;
  }

  private async assertOwnership(id: string, companyId: string) {
    const product = await this.prisma.companyProduct.findUnique({ where: { id } });
    if (!product || product.companyId !== companyId) {
      throw new NotFoundException('Producto no encontrado');
    }
    return product;
  }
}

// ======================== CONTROLLER ==================================

@ApiTags('Company Products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('company-products')
export class CompanyProductsController {
  constructor(private readonly svc: CompanyProductsService) {}

  @Get()
  @ApiOperation({ summary: 'List company products. ?all=1 to include inactive (managers only).' })
  @ApiQuery({ name: 'all', required: false, description: '1 = include inactive products' })
  @ApiQuery({ name: 'forCompanyId', required: false, description: 'platform_admin only: query another company' })
  async list(
    @CurrentUser() user: any,
    @Query('all') all?: string,
    @Query('forCompanyId') forCompanyId?: string,
  ) {
    // platform_admin can query any company's products (e.g., from company detail view in admin panel)
    let companyId = user.companyId;
    if (forCompanyId && user.role === 'platform_admin') {
      companyId = forCompanyId;
    }
    if (!companyId) return [];

    // Only managers can see inactive products
    const showAll = all === '1' && CATALOG_MANAGER_ROLES.includes(user.role);
    const activeOnly = !showAll;

    return this.svc.list(companyId, activeOnly);
  }

  @Post()
  @ApiOperation({ summary: 'Create product — requires gerente/admin/platform_admin' })
  async create(@CurrentUser() user: any, @Body() dto: CreateCompanyProductDto) {
    if (!CATALOG_MANAGER_ROLES.includes(user.role)) {
      throw new ForbiddenException('Se requiere rol de gerente o administrador para gestionar productos');
    }
    if (!user.companyId) throw new BadRequestException('Sin empresa activa');
    return this.svc.create(user.companyId, user.sub, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update product — requires gerente/admin/platform_admin' })
  async update(
    @CurrentUser() user: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyProductDto,
  ) {
    if (!CATALOG_MANAGER_ROLES.includes(user.role)) {
      throw new ForbiddenException('Se requiere rol de gerente o administrador para gestionar productos');
    }
    const companyId = user.role === 'platform_admin' && user.companyId ? user.companyId : user.companyId;
    return this.svc.update(id, companyId, dto);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Toggle active/inactive — requires gerente/admin/platform_admin' })
  async toggle(@CurrentUser() user: any, @Param('id', ParseUUIDPipe) id: string) {
    if (!CATALOG_MANAGER_ROLES.includes(user.role)) {
      throw new ForbiddenException('Se requiere rol de gerente o administrador para gestionar productos');
    }
    return this.svc.toggle(id, user.companyId);
  }
}
