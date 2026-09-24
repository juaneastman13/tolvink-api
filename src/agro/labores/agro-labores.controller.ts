import {
  BadRequestException,
  Body,
  Controller,
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
  IsBoolean,
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, requireFecha } from '../common/agro-base.controller';

export class LaborDto {
  @IsDateString() fecha!: string;
  @IsString() loteCampaniaId!: string;
  @IsString() tipoLabor!: string;
  @IsNumber() hectareas!: number;
  @IsOptional() @IsBoolean() propia?: boolean;
  @IsOptional() @IsNumber() tarifaUsdHa?: number;
  @IsOptional() @IsString() obs?: string;
}

export class ListLaborQueryDto {
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  @IsOptional() @IsString() loteCampaniaId?: string;
  @IsOptional() @Min(1) @Max(500) take?: number;
  @IsOptional() @Min(0) skip?: number;
}

@Injectable()
export class AgroLaboresService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string, q: ListLaborQueryDto) {
    return this.prisma.agroLabor.findMany({
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
        ...(q.loteCampaniaId ? { loteCampaniaId: q.loteCampaniaId } : {}),
      },
      orderBy: [{ fecha: 'desc' }, { createdAt: 'desc' }],
      take: q.take ?? 100,
      skip: q.skip ?? 0,
    });
  }

  async create(empresaId: string, userId: string, dto: LaborDto) {
    if (dto.hectareas <= 0) throw new BadRequestException('hectareas > 0');
    return this.prisma.agroLabor.create({
      data: {
        empresaId,
        fecha: requireFecha(dto.fecha),
        loteCampaniaId: dto.loteCampaniaId,
        tipoLabor: dto.tipoLabor,
        hectareas: new Prisma.Decimal(dto.hectareas),
        propia: dto.propia ?? true,
        tarifaUsdHa:
          dto.tarifaUsdHa !== undefined ? new Prisma.Decimal(dto.tarifaUsdHa) : null,
        obs: dto.obs ?? null,
        origen: 'WEB',
        createdBy: userId,
      },
    });
  }

  async anular(empresaId: string, id: string) {
    const res = await this.prisma.agroLabor.updateMany({
      where: { id, empresaId, anuladoAt: null },
      data: { anuladoAt: new Date() },
    });
    if (res.count === 0) throw new BadRequestException('Labor no encontrada o ya anulada');
    return { anulado: true };
  }
}

@ApiTags('Agro / Labores')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/labores')
export class AgroLaboresController {
  constructor(
    private service: AgroLaboresService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query() q: ListLaborQueryDto,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), q);
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: LaborDto,
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
  ) {
    return this.service.anular(await empresaIdOf(this.scope, user, req), id);
  }
}
