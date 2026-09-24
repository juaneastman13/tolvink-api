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
import {
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

export class LluviaDto {
  @IsDateString() fecha!: string;
  @IsNumber() mm!: number;
  @IsOptional() @IsString() pluviometro?: string;
}

export class ListLluviaQueryDto {
  @IsOptional() @IsDateString() desde?: string;
  @IsOptional() @IsDateString() hasta?: string;
  @IsOptional() @IsString() pluviometro?: string;
  @IsOptional() @Min(1) @Max(500) take?: number;
  @IsOptional() @Min(0) skip?: number;
}

@Injectable()
export class AgroLluviasService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string, q: ListLluviaQueryDto) {
    return this.prisma.agroLluvia.findMany({
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
        ...(q.pluviometro ? { pluviometro: q.pluviometro } : {}),
      },
      orderBy: [{ fecha: 'desc' }],
      take: q.take ?? 200,
      skip: q.skip ?? 0,
    });
  }

  create(empresaId: string, userId: string, dto: LluviaDto) {
    if (dto.mm < 0) throw new BadRequestException('mm ≥ 0');
    return this.prisma.agroLluvia.create({
      data: {
        empresaId,
        fecha: requireFecha(dto.fecha),
        mm: new Prisma.Decimal(dto.mm),
        pluviometro: dto.pluviometro ?? null,
        createdBy: userId,
      },
    });
  }
}

@ApiTags('Agro / Lluvias')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/lluvias')
export class AgroLluviasController {
  constructor(
    private service: AgroLluviasService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query() q: ListLluviaQueryDto,
  ) {
    return this.service.list(await empresaIdOf(this.scope, user, req), q);
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: LluviaDto,
  ) {
    return this.service.create(
      await empresaIdOf(this.scope, user, req),
      user.sub,
      dto,
    );
  }
}
