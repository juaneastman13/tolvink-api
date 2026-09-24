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
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import {
  AgroCentroTipo,
  AgroMovHaciendaTipo,
  Prisma,
} from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import {
  empresaIdOf,
  parseFecha,
  requireFecha,
} from '../common/agro-base.controller';
import {
  aplicar,
  MovHacienda,
  StockMap,
  stockKey,
  validar,
} from '../dominio/stock-hacienda';

// ── DTOs ──────────────────────────────────────────────────────────────

export class MovHaciendaDto {
  @IsDateString() fecha!: string;
  @IsEnum(AgroMovHaciendaTipo) tipo!: AgroMovHaciendaTipo;
  @IsEnum(AgroCentroTipo) centro!: AgroCentroTipo;
  @IsString() categoriaCod!: string;
  @IsOptional() @IsEnum(AgroCentroTipo) centroDestino?: AgroCentroTipo;
  @IsOptional() @IsString() categoriaDestino?: string;
  @IsOptional() @IsString() tandaId?: string;
  @IsInt() @Min(0) cabezas!: number;
  @IsOptional() @IsNumber() kgCab?: number;
  @IsOptional() @IsNumber() kgTotal?: number;
  @IsOptional() @IsNumber() usdKg?: number;
  @IsOptional() @IsInt() @Min(0) prenadas?: number;
  @IsOptional() @IsString() terceroId?: string;
  @IsOptional() @IsString() guia?: string;
  @IsOptional() @IsString() obs?: string;
  @IsOptional() @IsDateString() fechaCobroPago?: string;
}

export class AnularDto {
  @IsString() motivo!: string;
}

export class ListMovHaciendaQueryDto {
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  @IsOptional() @IsEnum(AgroCentroTipo) centro?: AgroCentroTipo;
  @IsOptional() @IsString() categoriaCod?: string;
  @IsOptional() @IsString() tandaId?: string;
  @IsOptional() @IsEnum(AgroMovHaciendaTipo) tipo?: AgroMovHaciendaTipo;
  @IsOptional() @Min(1) @Max(500) take?: number;
  @IsOptional() @Min(0) skip?: number;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroHaciendaService {
  constructor(private prisma: PrismaService) {}

  async list(empresaId: string, q: ListMovHaciendaQueryDto) {
    return this.prisma.agroMovHacienda.findMany({
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
        ...(q.categoriaCod ? { categoriaCod: q.categoriaCod } : {}),
        ...(q.tandaId ? { tandaId: q.tandaId } : {}),
        ...(q.tipo ? { tipo: q.tipo } : {}),
      },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      take: q.take ?? 100,
      skip: q.skip ?? 0,
    });
  }

  /**
   * Snapshot de stock a una fecha, reconstruido desde los movimientos no
   * anulados. Simple y correcto para volúmenes moderados; se materializará
   * cuando pese (Fase 4).
   */
  async stockAt(empresaId: string, hasta: Date): Promise<Map<string, number>> {
    const movs = await this.prisma.agroMovHacienda.findMany({
      where: { empresaId, fecha: { lte: hasta }, anuladoAt: null },
      orderBy: [{ fecha: 'asc' }, { createdAt: 'asc' }],
      select: {
        tipo: true,
        centro: true,
        categoriaCod: true,
        centroDestino: true,
        categoriaDestino: true,
        cabezas: true,
      },
    });
    const stock: StockMap = new Map();
    for (const m of movs) {
      aplicar(stock, m as MovHacienda);
    }
    return stock;
  }

  async create(empresaId: string, userId: string, dto: MovHaciendaDto) {
    const fecha = requireFecha(dto.fecha);

    // Reconstruyo stock hasta esta fecha y valido reglas.
    const stock = await this.stockAt(empresaId, fecha);
    const errs = validar(
      {
        tipo: dto.tipo,
        centro: dto.centro,
        categoriaCod: dto.categoriaCod,
        centroDestino: dto.centroDestino,
        categoriaDestino: dto.categoriaDestino,
        cabezas: dto.cabezas,
      },
      stock,
    );
    if (errs.length) {
      throw new BadRequestException({ message: 'Validación', errores: errs });
    }

    // kgTotal = kgCab * cabezas si viene kgCab; si el usuario mandó ambos, respetamos kgTotal.
    let kgTotal = dto.kgTotal;
    if (kgTotal === undefined && dto.kgCab !== undefined && dto.cabezas > 0) {
      kgTotal = Number((dto.kgCab * dto.cabezas).toFixed(2));
    }

    return this.prisma.agroMovHacienda.create({
      data: {
        empresaId,
        fecha,
        tipo: dto.tipo,
        centro: dto.centro,
        categoriaCod: dto.categoriaCod,
        centroDestino: dto.centroDestino ?? null,
        categoriaDestino: dto.categoriaDestino ?? null,
        tandaId: dto.tandaId ?? null,
        cabezas: dto.cabezas,
        kgCab: dto.kgCab !== undefined ? new Prisma.Decimal(dto.kgCab) : null,
        kgTotal: kgTotal !== undefined ? new Prisma.Decimal(kgTotal) : null,
        usdKg: dto.usdKg !== undefined ? new Prisma.Decimal(dto.usdKg) : null,
        prenadas: dto.prenadas ?? null,
        terceroId: dto.terceroId ?? null,
        guia: dto.guia ?? null,
        obs: dto.obs ?? null,
        fechaCobroPago: parseFecha(dto.fechaCobroPago),
        origen: 'WEB',
        createdBy: userId,
      },
    });
  }

  /**
   * Anular es append-only: marca el mov como anulado. No lo borra.
   * Si se necesita corregir, el usuario crea un nuevo movimiento.
   */
  async anular(empresaId: string, userId: string, id: string, motivo: string) {
    const existing = await this.prisma.agroMovHacienda.findFirst({
      where: { id, empresaId },
    });
    if (!existing) throw new NotFoundException('Movimiento no encontrado');
    if (existing.anuladoAt) throw new BadRequestException('Ya está anulado');
    return this.prisma.agroMovHacienda.update({
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

@ApiTags('Agro / Hacienda')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/hacienda')
export class AgroHaciendaController {
  constructor(
    private service: AgroHaciendaService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query() q: ListMovHaciendaQueryDto,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), q);
  }

  @Get('stock')
  async stock(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('hasta') hasta?: string,
  ) {
    const fecha = hasta ? requireFecha(hasta) : new Date();
    const s = await this.service.stockAt(
      await empresaIdOf(this.scope, user, req),
      fecha,
    );
    // Devuelvo un array plano [{centro, categoriaCod, cabezas}]
    return Array.from(s.entries())
      .filter(([, n]) => n !== 0)
      .map(([k, cabezas]) => {
        const [centro, categoriaCod] = k.split('::');
        return { centro, categoriaCod, cabezas };
      });
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: MovHaciendaDto,
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
    @Body() dto: AnularDto,
  ) {
    return this.service.anular(
      await empresaIdOf(this.scope, user, req),
      user.sub,
      id,
      dto.motivo,
    );
  }
}
