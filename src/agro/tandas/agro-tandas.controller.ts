import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, parseFecha, requireFecha } from '../common/agro-base.controller';

export class TandaDto {
  @IsString() @MaxLength(30) codigo!: string;
  @IsDateString() fechaIngreso!: string;
  @IsOptional() @IsString() @MaxLength(50) corral?: string;
  @IsOptional() @IsString() @MaxLength(20) categoriaCod?: string;
  @IsOptional() @IsDateString() fechaCierre?: string;
}

@Injectable()
export class AgroTandasService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string) {
    return this.prisma.agroTanda.findMany({
      where: { empresaId },
      orderBy: { fechaIngreso: 'desc' },
    });
  }

  create(empresaId: string, dto: TandaDto) {
    return this.prisma.agroTanda.create({
      data: {
        empresaId,
        codigo: dto.codigo,
        fechaIngreso: requireFecha(dto.fechaIngreso),
        corral: dto.corral ?? null,
        categoriaCod: dto.categoriaCod ?? null,
        fechaCierre: parseFecha(dto.fechaCierre),
      },
    });
  }

  async update(empresaId: string, id: string, dto: Partial<TandaDto>) {
    const res = await this.prisma.agroTanda.updateMany({
      where: { id, empresaId },
      data: {
        ...(dto.codigo !== undefined && { codigo: dto.codigo }),
        ...(dto.fechaIngreso !== undefined && {
          fechaIngreso: requireFecha(dto.fechaIngreso),
        }),
        ...(dto.corral !== undefined && { corral: dto.corral }),
        ...(dto.categoriaCod !== undefined && { categoriaCod: dto.categoriaCod }),
        ...(dto.fechaCierre !== undefined && { fechaCierre: parseFecha(dto.fechaCierre) }),
      },
    });
    if (res.count === 0) throw new Error('Tanda no encontrada');
    return this.prisma.agroTanda.findUnique({ where: { id } });
  }
}

@ApiTags('Agro / Tandas')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/tandas')
export class AgroTandasController {
  constructor(
    private service: AgroTandasService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(@CurrentUser() user: any, @Req() req: any) {
    return this.service.list(await empresaIdOf(this.scope, user, req));
  }

  @Post()
  @AgroRoles('agro_admin', 'agro_carga')
  async create(@CurrentUser() user: any, @Req() req: any, @Body() dto: TandaDto) {
    return this.service.create(await empresaIdOf(this.scope, user, req), dto);
  }

  @Patch(':id')
  @AgroRoles('agro_admin')
  async update(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: TandaDto,
  ) {
    return this.service.update(await empresaIdOf(this.scope, user, req), id, dto);
  }
}
