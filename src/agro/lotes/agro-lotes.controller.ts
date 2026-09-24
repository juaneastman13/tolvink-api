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
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { AgroTipoLoteCampania, Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, parseFecha } from '../common/agro-base.controller';

// ── DTOs ──────────────────────────────────────────────────────────────

export class LoteCampaniaDto {
  @IsOptional() @IsString() potreroId?: string;
  @IsString() campania!: string; // ej. "2025/26"
  @IsEnum(AgroTipoLoteCampania) tipo!: AgroTipoLoteCampania;
  @IsNumber() hectareas!: number;
  @IsOptional() @IsDateString() fechaSiembra?: string;
  @IsOptional() @IsDateString() fechaCosecha?: string;
  @IsOptional() @IsNumber() rindeEsperado?: number;
  @IsOptional() @IsBoolean() cerrado?: boolean;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroLotesService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string, campania?: string) {
    return this.prisma.agroLoteCampania.findMany({
      where: { empresaId, ...(campania ? { campania } : {}) },
      include: { potrero: { include: { campo: true } } },
      orderBy: [{ campania: 'desc' }, { tipo: 'asc' }],
    });
  }

  create(empresaId: string, dto: LoteCampaniaDto) {
    return this.prisma.agroLoteCampania.create({
      data: {
        empresaId,
        potreroId: dto.potreroId ?? null,
        campania: dto.campania,
        tipo: dto.tipo,
        hectareas: new Prisma.Decimal(dto.hectareas),
        fechaSiembra: parseFecha(dto.fechaSiembra),
        fechaCosecha: parseFecha(dto.fechaCosecha),
        rindeEsperado:
          dto.rindeEsperado !== undefined ? new Prisma.Decimal(dto.rindeEsperado) : null,
        cerrado: dto.cerrado ?? false,
      },
    });
  }

  async update(empresaId: string, id: string, dto: Partial<LoteCampaniaDto>) {
    const res = await this.prisma.agroLoteCampania.updateMany({
      where: { id, empresaId },
      data: {
        ...(dto.potreroId !== undefined && { potreroId: dto.potreroId }),
        ...(dto.campania !== undefined && { campania: dto.campania }),
        ...(dto.tipo !== undefined && { tipo: dto.tipo }),
        ...(dto.hectareas !== undefined && { hectareas: new Prisma.Decimal(dto.hectareas) }),
        ...(dto.fechaSiembra !== undefined && { fechaSiembra: parseFecha(dto.fechaSiembra) }),
        ...(dto.fechaCosecha !== undefined && { fechaCosecha: parseFecha(dto.fechaCosecha) }),
        ...(dto.rindeEsperado !== undefined && {
          rindeEsperado: new Prisma.Decimal(dto.rindeEsperado),
        }),
        ...(dto.cerrado !== undefined && { cerrado: dto.cerrado }),
      },
    });
    if (res.count === 0) throw new Error('Lote-campaña no encontrado');
    return this.prisma.agroLoteCampania.findUnique({ where: { id } });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Lotes-Campaña')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/lotes-campania')
export class AgroLotesController {
  constructor(
    private service: AgroLotesService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('campania') campania?: string,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), campania);
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: LoteCampaniaDto,
  ) {
    return this.service.create(await empresaIdOf(this.scope, user, req), dto);
  }

  @Patch(':id')
  @AgroRoles('agro_admin')
  async update(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: LoteCampaniaDto,
  ) {
    return this.service.update(await empresaIdOf(this.scope, user, req), id, dto);
  }
}
