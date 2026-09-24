import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, IsString } from 'class-validator';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';

// ── DTOs ──────────────────────────────────────────────────────────────

export class SetTipoCambioDto {
  @IsDateString() fecha!: string;
  @IsNumber() uyuUsd!: number;
  @IsOptional() @IsString() fuente?: string; // MANUAL | BCU
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroTipoCambioService {
  constructor(private prisma: PrismaService) {}

  /**
   * Resuelve el TC vigente para una fecha:
   *   1. Registro exacto de la fecha.
   *   2. El más reciente <= fecha.
   * Si no hay ninguno, retorna null (el llamador decide qué hacer).
   */
  async resolver(empresaId: string, fecha: Date) {
    const exact = await this.prisma.agroTipoCambio.findUnique({
      where: { empresaId_fecha: { empresaId, fecha } },
    });
    if (exact) return exact;
    return this.prisma.agroTipoCambio.findFirst({
      where: { empresaId, fecha: { lte: fecha } },
      orderBy: { fecha: 'desc' },
    });
  }

  async set(empresaId: string, dto: SetTipoCambioDto) {
    const fecha = new Date(dto.fecha);
    if (isNaN(fecha.getTime())) throw new BadRequestException('Fecha inválida');
    if (dto.uyuUsd <= 0) throw new BadRequestException('uyuUsd debe ser > 0');
    return this.prisma.agroTipoCambio.upsert({
      where: { empresaId_fecha: { empresaId, fecha } },
      create: {
        empresaId,
        fecha,
        uyuUsd: new Prisma.Decimal(dto.uyuUsd),
        fuente: dto.fuente ?? 'MANUAL',
      },
      update: {
        uyuUsd: new Prisma.Decimal(dto.uyuUsd),
        fuente: dto.fuente ?? 'MANUAL',
      },
    });
  }

  async list(empresaId: string, desde?: Date, hasta?: Date) {
    return this.prisma.agroTipoCambio.findMany({
      where: {
        empresaId,
        ...(desde || hasta
          ? { fecha: { ...(desde ? { gte: desde } : {}), ...(hasta ? { lte: hasta } : {}) } }
          : {}),
      },
      orderBy: { fecha: 'desc' },
      take: 200,
    });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Tipo de cambio')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/tipo-cambio')
export class AgroTipoCambioController {
  constructor(
    private service: AgroTipoCambioService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
  ) {
    const { empresaId } = await this.scope.resolveEmpresa(
      user,
      this.scope.extractExplicitId(req),
    );
    return this.service.list(
      empresaId,
      desde ? new Date(desde) : undefined,
      hasta ? new Date(hasta) : undefined,
    );
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async set(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: SetTipoCambioDto,
  ) {
    const { empresaId } = await this.scope.resolveEmpresa(
      user,
      this.scope.extractExplicitId(req),
    );
    return this.service.set(empresaId, dto);
  }
}
