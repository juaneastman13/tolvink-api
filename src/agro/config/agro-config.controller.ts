import { Body, Controller, Get, Injectable, Put, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { AgroEscenario, AgroModoMaquinaria, Prisma } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

// ── DTOs ──────────────────────────────────────────────────────────────

export class UpsertAgroConfigDto {
  @IsInt() @Min(1) @Max(12) mesInicioEjercicio!: number;
  @IsOptional() @IsInt() @Min(1) @Max(12) cierreIntermedioMes?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(31) cierreIntermedioDia?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(1) tasaCostoOportunidad?: number;
  @IsOptional() @IsEnum(AgroModoMaquinaria) modoMaquinaria?: AgroModoMaquinaria;
  @IsOptional() @IsEnum(AgroEscenario) escenarioActivo?: AgroEscenario;
  @IsOptional() @IsBoolean() pasHabilitado?: boolean;
  @IsOptional() @IsNumber() pBaseCarne?: number;
  @IsOptional() @IsNumber() pBaseSoja?: number;
  @IsOptional() @IsNumber() pBaseTrigo?: number;
  @IsOptional() @IsNumber() desvioUsd?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) desvioPct?: number;
  @IsOptional() @IsNumber() saldoMinimoOperativo?: number;
  @IsOptional() @IsObject() porcentajesAsignacion?: Record<string, unknown>;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroConfigService {
  constructor(private prisma: PrismaService) {}

  async get(empresaId: string) {
    const cfg = await this.prisma.agroConfig.findUnique({ where: { empresaId } });
    if (cfg) return cfg;
    // Fallback: creo el default en la primera lectura.
    return this.prisma.agroConfig.create({
      data: { empresaId, mesInicioEjercicio: 1 },
    });
  }

  async upsert(empresaId: string, dto: UpsertAgroConfigDto) {
    const data: Prisma.AgroConfigUpsertArgs['create'] = {
      empresaId,
      mesInicioEjercicio: dto.mesInicioEjercicio,
      cierreIntermedioMes: dto.cierreIntermedioMes ?? null,
      cierreIntermedioDia: dto.cierreIntermedioDia ?? null,
      tasaCostoOportunidad:
        dto.tasaCostoOportunidad !== undefined
          ? new Prisma.Decimal(dto.tasaCostoOportunidad)
          : new Prisma.Decimal(0.05),
      modoMaquinaria: dto.modoMaquinaria ?? 'PORCENTAJE',
      escenarioActivo: dto.escenarioActivo ?? 'BASE',
      pasHabilitado: dto.pasHabilitado ?? false,
      pBaseCarne: new Prisma.Decimal(dto.pBaseCarne ?? 0),
      pBaseSoja: new Prisma.Decimal(dto.pBaseSoja ?? 0),
      pBaseTrigo: new Prisma.Decimal(dto.pBaseTrigo ?? 0),
      desvioUsd: new Prisma.Decimal(dto.desvioUsd ?? 1000),
      desvioPct: new Prisma.Decimal(dto.desvioPct ?? 0.1),
      saldoMinimoOperativo: new Prisma.Decimal(dto.saldoMinimoOperativo ?? 15000),
      porcentajesAsignacion: (dto.porcentajesAsignacion ?? {}) as Prisma.InputJsonValue,
    };

    return this.prisma.agroConfig.upsert({
      where: { empresaId },
      create: data,
      update: {
        mesInicioEjercicio: data.mesInicioEjercicio,
        cierreIntermedioMes: data.cierreIntermedioMes,
        cierreIntermedioDia: data.cierreIntermedioDia,
        tasaCostoOportunidad: data.tasaCostoOportunidad,
        modoMaquinaria: data.modoMaquinaria,
        escenarioActivo: data.escenarioActivo,
        pasHabilitado: data.pasHabilitado,
        pBaseCarne: data.pBaseCarne,
        pBaseSoja: data.pBaseSoja,
        pBaseTrigo: data.pBaseTrigo,
        desvioUsd: data.desvioUsd,
        desvioPct: data.desvioPct,
        saldoMinimoOperativo: data.saldoMinimoOperativo,
        porcentajesAsignacion: data.porcentajesAsignacion,
      },
    });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Config')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/config')
export class AgroConfigController {
  constructor(
    private service: AgroConfigService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async get(@CurrentUser() user: any, @Req() req: any) {
    const { empresaId } = await this.scope.resolveEmpresa(
      user,
      this.scope.extractExplicitId(req),
    );
    return this.service.get(empresaId);
  }

  @Put()
  @AgroRoles('agro_admin')
  async put(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: UpsertAgroConfigDto,
  ) {
    const { empresaId } = await this.scope.resolveEmpresa(
      user,
      this.scope.extractExplicitId(req),
    );
    return this.service.upsert(empresaId, dto);
  }
}
