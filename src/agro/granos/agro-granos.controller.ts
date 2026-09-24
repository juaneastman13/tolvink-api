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
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { AgroMovGranoTipo, Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, parseFecha, requireFecha } from '../common/agro-base.controller';
import { calcularAsientoFeedlot } from '../dominio/transferencia-grano';

// ── DTOs ──────────────────────────────────────────────────────────────

export class MovGranoDto {
  @IsDateString() fecha!: string;
  @IsEnum(AgroMovGranoTipo) tipo!: AgroMovGranoTipo;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsString() productoId!: string;
  @IsNumber() toneladas!: number;
  @IsOptional() @IsNumber() precioNetoUsdT?: number; // requerido en VENTA y FEEDLOT
  @IsOptional() @IsNumber() precioReferenciaUsdT?: number; // sólo FEEDLOT (auto-cálculo)
  @IsOptional() @IsNumber() fleteUsdT?: number; // sólo FEEDLOT
  @IsOptional() @IsNumber() comisionUsdT?: number; // sólo FEEDLOT
  @IsOptional() @IsDateString() fechaCobro?: string;
  @IsOptional() @IsString() tandaId?: string; // requerido si tipo=FEEDLOT
  @IsOptional() @IsString() obs?: string;
}

export class ListMovGranoQueryDto {
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  @IsOptional() @IsEnum(AgroMovGranoTipo) tipo?: AgroMovGranoTipo;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsOptional() @IsString() productoId?: string;
  @IsOptional() @IsString() tandaId?: string;
  @IsOptional() @Min(1) @Max(500) take?: number;
  @IsOptional() @Min(0) skip?: number;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroGranosService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string, q: ListMovGranoQueryDto) {
    return this.prisma.agroMovGrano.findMany({
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
        ...(q.tipo ? { tipo: q.tipo } : {}),
        ...(q.loteCampaniaId ? { loteCampaniaId: q.loteCampaniaId } : {}),
        ...(q.productoId ? { productoId: q.productoId } : {}),
        ...(q.tandaId ? { tandaId: q.tandaId } : {}),
      },
      include: { producto: true, loteCampania: true, tanda: true },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      take: q.take ?? 100,
      skip: q.skip ?? 0,
    });
  }

  async create(empresaId: string, userId: string, dto: MovGranoDto) {
    if (dto.toneladas <= 0) {
      throw new BadRequestException('toneladas debe ser > 0');
    }

    let precioNetoUsdT: Prisma.Decimal | null = null;

    if (dto.tipo === 'FEEDLOT') {
      // §5.2: transferencia interna al valor neto en campo.
      if (!dto.tandaId) {
        throw new BadRequestException('FEEDLOT requiere tandaId');
      }
      if (dto.precioNetoUsdT !== undefined) {
        // El usuario ya calculó el neto; lo respetamos.
        precioNetoUsdT = new Prisma.Decimal(dto.precioNetoUsdT);
      } else {
        if (dto.precioReferenciaUsdT === undefined) {
          throw new BadRequestException(
            'FEEDLOT requiere precioNetoUsdT o precioReferenciaUsdT (con flete/comisión opcionales)',
          );
        }
        const asiento = calcularAsientoFeedlot({
          toneladas: dto.toneladas,
          precioReferenciaUsdT: dto.precioReferenciaUsdT,
          fleteUsdT: dto.fleteUsdT,
          comisionUsdT: dto.comisionUsdT,
        });
        precioNetoUsdT = asiento.precioNetoUsdT;
      }
    } else if (dto.tipo === 'VENTA') {
      if (dto.precioNetoUsdT === undefined) {
        throw new BadRequestException('VENTA requiere precioNetoUsdT');
      }
      precioNetoUsdT = new Prisma.Decimal(dto.precioNetoUsdT);
    } else if (dto.tipo === 'COSECHA') {
      // COSECHA no requiere precio; el grano queda en stock a valor neto de cierre.
      precioNetoUsdT = null;
      if (!dto.loteCampaniaId) {
        throw new BadRequestException('COSECHA requiere loteCampaniaId');
      }
    }

    return this.prisma.agroMovGrano.create({
      data: {
        empresaId,
        fecha: requireFecha(dto.fecha),
        tipo: dto.tipo,
        loteCampaniaId: dto.loteCampaniaId ?? null,
        productoId: dto.productoId,
        toneladas: new Prisma.Decimal(dto.toneladas),
        precioNetoUsdT,
        fechaCobro: parseFecha(dto.fechaCobro),
        tandaId: dto.tandaId ?? null,
        obs: dto.obs ?? null,
        origen: 'WEB',
        createdBy: userId,
      },
    });
  }

  async anular(empresaId: string, userId: string, id: string, motivo: string) {
    const existing = await this.prisma.agroMovGrano.findFirst({
      where: { id, empresaId },
    });
    if (!existing) throw new NotFoundException('Movimiento no encontrado');
    if (existing.anuladoAt) throw new BadRequestException('Ya está anulado');
    return this.prisma.agroMovGrano.update({
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

@ApiTags('Agro / Granos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/granos')
export class AgroGranosController {
  constructor(
    private service: AgroGranosService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query() q: ListMovGranoQueryDto,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), q);
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: MovGranoDto,
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
