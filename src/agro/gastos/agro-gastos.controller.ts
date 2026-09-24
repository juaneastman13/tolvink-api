import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AgroCentroTipo, AgroUnidad, Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, parseFecha, requireFecha } from '../common/agro-base.controller';
import { AgroTipoCambioService } from '../tipo-cambio/agro-tipo-cambio.controller';
import { normalizarImporte } from '../dominio/moneda';

// ── DTOs ──────────────────────────────────────────────────────────────

export class GastoDto {
  @IsDateString() fecha!: string;
  @IsOptional() @IsString() terceroId?: string;
  @IsString() cuentaId!: string;
  @IsEnum(AgroCentroTipo) centro!: AgroCentroTipo;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsOptional() @IsString() tandaId?: string;
  @IsOptional() @IsString() prestamoId?: string;
  @IsOptional() @IsString() detalle?: string;
  @IsIn(['USD', 'UYU']) moneda!: 'USD' | 'UYU';
  @IsNumber() monto!: number;
  /** Opcional: si no se envía, se resuelve del AgroTipoCambio del día. */
  @IsOptional() @IsNumber() tipoCambio?: number;
  @IsOptional() @IsString() comprobante?: string;
  @IsOptional() @IsDateString() fechaPago?: string;
  @IsOptional() @IsNumber() cantidad?: number;
  @IsOptional() @IsEnum(AgroUnidad) unidad?: AgroUnidad;
}

export class ListGastoQueryDto {
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  @IsOptional() @IsEnum(AgroCentroTipo) centro?: AgroCentroTipo;
  @IsOptional() @IsString() cuentaId?: string;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsOptional() @IsString() tandaId?: string;
  @IsOptional() @IsString() terceroId?: string;
  @IsOptional() @Min(1) @Max(500) take?: number;
  @IsOptional() @Min(0) skip?: number;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroGastosService {
  constructor(
    private prisma: PrismaService,
    private tc: AgroTipoCambioService,
  ) {}

  list(empresaId: string, q: ListGastoQueryDto) {
    return this.prisma.agroGasto.findMany({
      where: {
        empresaId,
        ...(q.desde || q.hasta
          ? {
              fecha: {
                ...(q.desde ? { gte: requireFecha(q.desde) } : {}),
                ...(q.hasta ? { lte: requireFecha(q.hasta) } : {}),
              },
            }
          : {}),
        ...(q.centro ? { centro: q.centro } : {}),
        ...(q.cuentaId ? { cuentaId: q.cuentaId } : {}),
        ...(q.loteCampaniaId ? { loteCampaniaId: q.loteCampaniaId } : {}),
        ...(q.tandaId ? { tandaId: q.tandaId } : {}),
        ...(q.terceroId ? { terceroId: q.terceroId } : {}),
      },
      include: { cuenta: true, tercero: true },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      take: q.take ?? 100,
      skip: q.skip ?? 0,
    });
  }

  async create(empresaId: string, userId: string, dto: GastoDto) {
    if (dto.monto <= 0) throw new BadRequestException('monto debe ser > 0');
    const fecha = requireFecha(dto.fecha);

    // Resolver tipo de cambio.
    let tc: Prisma.Decimal;
    if (dto.moneda === 'USD') {
      tc = new Prisma.Decimal(1);
    } else if (dto.tipoCambio !== undefined) {
      if (dto.tipoCambio <= 0) throw new BadRequestException('tipoCambio > 0');
      tc = new Prisma.Decimal(dto.tipoCambio);
    } else {
      const tcRow = await this.tc.resolver(empresaId, fecha);
      if (!tcRow) {
        throw new BadRequestException(
          `Falta tipo de cambio para ${dto.fecha}. Cargalo primero en /agro/tipo-cambio o mandá tipoCambio en el body.`,
        );
      }
      tc = tcRow.uyuUsd;
    }

    const norm = normalizarImporte(new Prisma.Decimal(dto.monto), dto.moneda, tc);

    return this.prisma.agroGasto.create({
      data: {
        empresaId,
        fecha,
        terceroId: dto.terceroId ?? null,
        cuentaId: dto.cuentaId,
        centro: dto.centro,
        loteCampaniaId: dto.loteCampaniaId ?? null,
        tandaId: dto.tandaId ?? null,
        prestamoId: dto.prestamoId ?? null,
        detalle: dto.detalle ?? null,
        moneda: dto.moneda,
        monto: norm.monto,
        tipoCambio: norm.tipoCambio,
        montoUsd: norm.montoUsd,
        comprobante: dto.comprobante ?? null,
        fechaPago: parseFecha(dto.fechaPago),
        cantidad: dto.cantidad !== undefined ? new Prisma.Decimal(dto.cantidad) : null,
        unidad: dto.unidad ?? null,
        origen: 'WEB',
        createdBy: userId,
      },
    });
  }

  async anular(empresaId: string, userId: string, id: string, motivo: string) {
    const existing = await this.prisma.agroGasto.findFirst({
      where: { id, empresaId },
    });
    if (!existing) throw new NotFoundException('Gasto no encontrado');
    if (existing.anuladoAt) throw new BadRequestException('Ya está anulado');
    return this.prisma.agroGasto.update({
      where: { id },
      data: {
        anuladoAt: new Date(),
        anuladoPor: userId,
        motivoAnulacion: motivo,
      },
    });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Gastos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/gastos')
export class AgroGastosController {
  constructor(
    private service: AgroGastosService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query() q: ListGastoQueryDto,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), q);
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: GastoDto,
  ) {
    return this.service.create(
      await empresaIdOf(this.scope, user, req),
      user.sub,
      dto,
    );
  }

  @Post(':id/anular')
  @AgroRoles('agro_admin')
  async anular(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body('motivo') motivo: string,
  ) {
    if (!motivo) throw new BadRequestException('motivo requerido');
    return this.service.anular(
      await empresaIdOf(this.scope, user, req),
      user.sub,
      id,
      motivo,
    );
  }
}
