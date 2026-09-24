import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  AgroCentroTipo,
  AgroCuentaTipo,
  AgroTipoProducto,
  AgroTipoTercero,
  AgroUnidad,
  Prisma,
} from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';

// ── DTOs ──────────────────────────────────────────────────────────────

export class CentroDto {
  @IsEnum(AgroCentroTipo) codigo!: AgroCentroTipo;
  @IsString() @MaxLength(100) nombre!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CategoriaAnimalDto {
  @IsString() @MaxLength(20) codigo!: string;
  @IsString() @MaxLength(100) nombre!: string;
  @IsNumber() equivalenciaUg!: number;
  @IsOptional() @IsEnum(AgroCentroTipo) centroHabitual?: AgroCentroTipo;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class CuentaDto {
  @IsString() @MaxLength(20) codigo!: string;
  @IsString() @MaxLength(150) nombre!: string;
  @IsEnum(AgroCuentaTipo) tipo!: AgroCuentaTipo;
  @IsOptional() @IsEnum(AgroCentroTipo) centroDefault?: AgroCentroTipo;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class TerceroDto {
  @IsString() @MaxLength(200) nombre!: string;
  @IsEnum(AgroTipoTercero) tipo!: AgroTipoTercero;
  @IsOptional() @IsString() @MaxLength(20) rut?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class ProductoDto {
  @IsString() @MaxLength(30) codigo!: string;
  @IsString() @MaxLength(200) nombre!: string;
  @IsEnum(AgroTipoProducto) tipo!: AgroTipoProducto;
  @IsEnum(AgroUnidad) unidad!: AgroUnidad;
  @IsOptional() @IsBoolean() active?: boolean;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroMaestrosService {
  constructor(private prisma: PrismaService) {}

  // Centros
  listCentros(empresaId: string) {
    return this.prisma.agroCentro.findMany({
      where: { empresaId },
      orderBy: { codigo: 'asc' },
    });
  }
  upsertCentro(empresaId: string, dto: CentroDto) {
    return this.prisma.agroCentro.upsert({
      where: { empresaId_codigo: { empresaId, codigo: dto.codigo } },
      create: { empresaId, ...dto },
      update: { nombre: dto.nombre, active: dto.active ?? true },
    });
  }

  // Categorías
  listCategorias(empresaId: string) {
    return this.prisma.agroCategoriaAnimal.findMany({
      where: { empresaId },
      orderBy: { codigo: 'asc' },
    });
  }
  upsertCategoria(empresaId: string, dto: CategoriaAnimalDto) {
    const data = {
      empresaId,
      codigo: dto.codigo,
      nombre: dto.nombre,
      equivalenciaUg: new Prisma.Decimal(dto.equivalenciaUg),
      centroHabitual: dto.centroHabitual ?? null,
      active: dto.active ?? true,
    };
    return this.prisma.agroCategoriaAnimal.upsert({
      where: { empresaId_codigo: { empresaId, codigo: dto.codigo } },
      create: data,
      update: {
        nombre: data.nombre,
        equivalenciaUg: data.equivalenciaUg,
        centroHabitual: data.centroHabitual,
        active: data.active,
      },
    });
  }

  // Cuentas
  listCuentas(empresaId: string) {
    return this.prisma.agroCuenta.findMany({
      where: { empresaId },
      orderBy: { codigo: 'asc' },
    });
  }
  upsertCuenta(empresaId: string, dto: CuentaDto) {
    return this.prisma.agroCuenta.upsert({
      where: { empresaId_codigo: { empresaId, codigo: dto.codigo } },
      create: {
        empresaId,
        codigo: dto.codigo,
        nombre: dto.nombre,
        tipo: dto.tipo,
        centroDefault: dto.centroDefault ?? null,
        active: dto.active ?? true,
      },
      update: {
        nombre: dto.nombre,
        tipo: dto.tipo,
        centroDefault: dto.centroDefault ?? null,
        active: dto.active ?? true,
      },
    });
  }

  // Terceros
  listTerceros(empresaId: string, tipo?: AgroTipoTercero) {
    return this.prisma.agroTercero.findMany({
      where: { empresaId, ...(tipo ? { tipo } : {}) },
      orderBy: { nombre: 'asc' },
    });
  }
  createTercero(empresaId: string, dto: TerceroDto) {
    return this.prisma.agroTercero.create({ data: { empresaId, ...dto } });
  }
  async updateTercero(empresaId: string, id: string, dto: Partial<TerceroDto>) {
    await this.prisma.agroTercero.updateMany({
      where: { id, empresaId },
      data: dto,
    });
    return this.prisma.agroTercero.findUnique({ where: { id } });
  }

  // Productos
  listProductos(empresaId: string) {
    return this.prisma.agroProducto.findMany({
      where: { empresaId },
      orderBy: { codigo: 'asc' },
    });
  }
  upsertProducto(empresaId: string, dto: ProductoDto) {
    return this.prisma.agroProducto.upsert({
      where: { empresaId_codigo: { empresaId, codigo: dto.codigo } },
      create: { empresaId, ...dto },
      update: {
        nombre: dto.nombre,
        tipo: dto.tipo,
        unidad: dto.unidad,
        active: dto.active ?? true,
      },
    });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Maestros')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/maestros')
export class AgroMaestrosController {
  constructor(
    private service: AgroMaestrosService,
    private scope: AgroScopeService,
  ) {}

  private async empresaId(user: any, req: any): Promise<string> {
    const { empresaId } = await this.scope.resolveEmpresa(
      user,
      this.scope.extractExplicitId(req),
    );
    return empresaId;
  }

  // Centros ------------------------------------------------------------
  @Get('centros')
  async listCentros(@CurrentUser() user: any, @Req() req: any) {
    return this.service.listCentros(await this.empresaId(user, req));
  }

  @Post('centros')
  @AgroRoles('agro_admin')
  async upsertCentro(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: CentroDto,
  ) {
    return this.service.upsertCentro(await this.empresaId(user, req), dto);
  }

  // Categorías ---------------------------------------------------------
  @Get('categorias')
  async listCategorias(@CurrentUser() user: any, @Req() req: any) {
    return this.service.listCategorias(await this.empresaId(user, req));
  }

  @Post('categorias')
  @AgroRoles('agro_admin')
  async upsertCategoria(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: CategoriaAnimalDto,
  ) {
    return this.service.upsertCategoria(await this.empresaId(user, req), dto);
  }

  // Cuentas ------------------------------------------------------------
  @Get('cuentas')
  async listCuentas(@CurrentUser() user: any, @Req() req: any) {
    return this.service.listCuentas(await this.empresaId(user, req));
  }

  @Post('cuentas')
  @AgroRoles('agro_admin')
  async upsertCuenta(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: CuentaDto,
  ) {
    return this.service.upsertCuenta(await this.empresaId(user, req), dto);
  }

  // Terceros -----------------------------------------------------------
  @Get('terceros')
  async listTerceros(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('tipo') tipo?: AgroTipoTercero,
  ) {
    return this.service.listTerceros(await this.empresaId(user, req), tipo);
  }

  @Post('terceros')
  @AgroRoles('agro_admin', 'agro_carga')
  async createTercero(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: TerceroDto,
  ) {
    return this.service.createTercero(await this.empresaId(user, req), dto);
  }

  @Patch('terceros/:id')
  @AgroRoles('agro_admin')
  async updateTercero(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: TerceroDto,
  ) {
    return this.service.updateTercero(await this.empresaId(user, req), id, dto);
  }

  // Productos ----------------------------------------------------------
  @Get('productos')
  async listProductos(@CurrentUser() user: any, @Req() req: any) {
    return this.service.listProductos(await this.empresaId(user, req));
  }

  @Post('productos')
  @AgroRoles('agro_admin')
  async upsertProducto(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: ProductoDto,
  ) {
    return this.service.upsertProducto(await this.empresaId(user, req), dto);
  }
}
