import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  AgroCentroTipo,
  AgroEscenario,
  AgroUnidad,
  Prisma,
} from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';
import { calcularEconomico, totalizarPorCentro } from '../dominio/presupuesto';

// ── DTOs ──────────────────────────────────────────────────────────────

export class PresFisicoDto {
  @IsInt() ejercicio!: number;
  @IsInt() @Min(1) @Max(12) mes!: number;
  @IsOptional() @IsEnum(AgroCentroTipo) centro?: AgroCentroTipo;
  @IsOptional() @IsString() categoriaCod?: string;
  @IsOptional() @IsString() productoId?: string;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsString() concepto!: string;
  @IsNumber() cantidad!: number;
  @IsOptional() @IsEnum(AgroUnidad) unidad?: AgroUnidad;
  @IsOptional() @IsString() obs?: string;
}

export class PresPrecioDto {
  @IsInt() ejercicio!: number;
  @IsInt() @Min(1) @Max(12) mes!: number;
  @IsEnum(AgroEscenario) escenario!: AgroEscenario;
  @IsOptional() @IsString() productoId?: string;
  @IsOptional() @IsString() categoriaCod?: string;
  @IsNumber() precioUsd!: number;
  @IsOptional() @IsEnum(AgroUnidad) unidad?: AgroUnidad;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroPresupuestoService {
  constructor(private prisma: PrismaService) {}

  // Físico ------------------------------------------------------------

  listFisico(empresaId: string, ejercicio: number) {
    return this.prisma.agroPresFisico.findMany({
      where: { empresaId, ejercicio },
      orderBy: [{ mes: 'asc' }, { concepto: 'asc' }],
    });
  }

  createFisico(empresaId: string, dto: PresFisicoDto) {
    return this.prisma.agroPresFisico.create({
      data: {
        empresaId,
        ejercicio: dto.ejercicio,
        mes: dto.mes,
        centro: dto.centro ?? null,
        categoriaCod: dto.categoriaCod ?? null,
        productoId: dto.productoId ?? null,
        loteCampaniaId: dto.loteCampaniaId ?? null,
        concepto: dto.concepto,
        cantidad: new Prisma.Decimal(dto.cantidad),
        unidad: dto.unidad ?? null,
        obs: dto.obs ?? null,
      },
    });
  }

  async removeFisico(empresaId: string, id: string) {
    const res = await this.prisma.agroPresFisico.deleteMany({
      where: { id, empresaId },
    });
    if (res.count === 0) throw new BadRequestException('Fila no encontrada');
    return { deleted: res.count };
  }

  // Precio ------------------------------------------------------------

  listPrecio(empresaId: string, ejercicio: number, escenario?: AgroEscenario) {
    return this.prisma.agroPresPrecio.findMany({
      where: { empresaId, ejercicio, ...(escenario ? { escenario } : {}) },
      orderBy: [{ escenario: 'asc' }, { mes: 'asc' }],
    });
  }

  upsertPrecio(empresaId: string, dto: PresPrecioDto) {
    return this.prisma.agroPresPrecio.upsert({
      where: {
        empresaId_ejercicio_mes_escenario_productoId_categoriaCod: {
          empresaId,
          ejercicio: dto.ejercicio,
          mes: dto.mes,
          escenario: dto.escenario,
          productoId: dto.productoId ?? null,
          categoriaCod: dto.categoriaCod ?? null,
        } as any,
      },
      create: {
        empresaId,
        ejercicio: dto.ejercicio,
        mes: dto.mes,
        escenario: dto.escenario,
        productoId: dto.productoId ?? null,
        categoriaCod: dto.categoriaCod ?? null,
        precioUsd: new Prisma.Decimal(dto.precioUsd),
        unidad: dto.unidad ?? null,
      },
      update: {
        precioUsd: new Prisma.Decimal(dto.precioUsd),
        unidad: dto.unidad ?? null,
      },
    });
  }

  // Económico (calculado) --------------------------------------------

  /**
   * Calcula el económico del ejercicio bajo un escenario dado. Usa el
   * `escenarioActivo` de config si no se pasa.
   */
  async calcularEconomico(
    empresaId: string,
    ejercicio: number,
    escenario?: AgroEscenario,
  ) {
    let esc = escenario;
    if (!esc) {
      const cfg = await this.prisma.agroConfig.findUnique({
        where: { empresaId },
        select: { escenarioActivo: true },
      });
      esc = cfg?.escenarioActivo ?? 'BASE';
    }
    const [fisico, precios] = await Promise.all([
      this.prisma.agroPresFisico.findMany({
        where: { empresaId, ejercicio },
        orderBy: [{ mes: 'asc' }],
      }),
      this.prisma.agroPresPrecio.findMany({
        where: { empresaId, ejercicio, escenario: esc },
      }),
    ]);
    const rows = calcularEconomico(
      fisico.map((f) => ({
        mes: f.mes,
        centro: f.centro,
        categoriaCod: f.categoriaCod,
        productoId: f.productoId,
        concepto: f.concepto,
        cantidad: f.cantidad,
      })),
      precios.map((p) => ({
        mes: p.mes,
        productoId: p.productoId,
        categoriaCod: p.categoriaCod,
        precioUsd: p.precioUsd,
      })),
    );
    return {
      ejercicio,
      escenario: esc,
      rows,
      totalesPorCentro: totalizarPorCentro(rows),
    };
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Presupuesto')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/presupuesto')
export class AgroPresupuestoController {
  constructor(
    private service: AgroPresupuestoService,
    private scope: AgroScopeService,
  ) {}

  @Get('fisico')
  async listFisico(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio: string,
  ) {
    return this.service.listFisico(
      await empresaIdOf(this.scope, user, req),
      parseInt(ejercicio, 10),
    );
  }

  @Post('fisico')
  @AgroRoles('agro_admin', 'agro_carga')
  async createFisico(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: PresFisicoDto,
  ) {
    return this.service.createFisico(await empresaIdOf(this.scope, user, req), dto);
  }

  @Delete('fisico/:id')
  @AgroRoles('agro_admin')
  async removeFisico(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.service.removeFisico(await empresaIdOf(this.scope, user, req), id);
  }

  @Get('precio')
  async listPrecio(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio: string,
    @Query('escenario') escenario?: AgroEscenario,
  ) {
    return this.service.listPrecio(
      await empresaIdOf(this.scope, user, req),
      parseInt(ejercicio, 10),
      escenario,
    );
  }

  @Post('precio')
  @AgroRoles('agro_admin', 'agro_carga')
  async upsertPrecio(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: PresPrecioDto,
  ) {
    return this.service.upsertPrecio(
      await empresaIdOf(this.scope, user, req),
      dto,
    );
  }

  @Get('economico')
  async economico(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ejercicio') ejercicio: string,
    @Query('escenario') escenario?: AgroEscenario,
  ) {
    return this.service.calcularEconomico(
      await empresaIdOf(this.scope, user, req),
      parseInt(ejercicio, 10),
      escenario,
    );
  }
}
