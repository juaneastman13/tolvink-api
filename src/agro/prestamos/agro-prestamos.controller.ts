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
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';
import { AgroPrestamoMoneda, Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf, requireFecha } from '../common/agro-base.controller';

export class PrestamoDto {
  @IsString() nombre!: string;
  @IsNumber() capital!: number;
  @IsEnum(AgroPrestamoMoneda) moneda!: AgroPrestamoMoneda;
  @IsNumber() tasaAnual!: number;
  @IsInt() cuotas!: number;
  @IsOptional() @IsString() garantia?: string;
  @IsDateString() fechaInicio!: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

@Injectable()
export class AgroPrestamosService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string) {
    return this.prisma.agroPrestamo.findMany({
      where: { empresaId },
      orderBy: [{ active: 'desc' }, { fechaInicio: 'desc' }],
    });
  }

  create(empresaId: string, dto: PrestamoDto) {
    return this.prisma.agroPrestamo.create({
      data: {
        empresaId,
        nombre: dto.nombre,
        capital: new Prisma.Decimal(dto.capital),
        moneda: dto.moneda,
        tasaAnual: new Prisma.Decimal(dto.tasaAnual),
        cuotas: dto.cuotas,
        garantia: dto.garantia ?? null,
        fechaInicio: requireFecha(dto.fechaInicio),
        active: dto.active ?? true,
      },
    });
  }

  async update(empresaId: string, id: string, dto: Partial<PrestamoDto>) {
    const res = await this.prisma.agroPrestamo.updateMany({
      where: { id, empresaId },
      data: {
        ...(dto.nombre !== undefined && { nombre: dto.nombre }),
        ...(dto.capital !== undefined && { capital: new Prisma.Decimal(dto.capital) }),
        ...(dto.moneda !== undefined && { moneda: dto.moneda }),
        ...(dto.tasaAnual !== undefined && { tasaAnual: new Prisma.Decimal(dto.tasaAnual) }),
        ...(dto.cuotas !== undefined && { cuotas: dto.cuotas }),
        ...(dto.garantia !== undefined && { garantia: dto.garantia }),
        ...(dto.fechaInicio !== undefined && { fechaInicio: requireFecha(dto.fechaInicio) }),
        ...(dto.active !== undefined && { active: dto.active }),
      },
    });
    if (res.count === 0) throw new Error('Préstamo no encontrado');
    return this.prisma.agroPrestamo.findUnique({ where: { id } });
  }
}

@ApiTags('Agro / Préstamos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/prestamos')
export class AgroPrestamosController {
  constructor(
    private service: AgroPrestamosService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(@CurrentUser() user: any, @Req() req: any) {
    return this.service.list(await empresaIdOf(this.scope, user, req));
  }

  @Post()
  @AgroRoles('agro_admin')
  async create(@CurrentUser() user: any, @Req() req: any, @Body() dto: PrestamoDto) {
    return this.service.create(await empresaIdOf(this.scope, user, req), dto);
  }

  @Patch(':id')
  @AgroRoles('agro_admin')
  async update(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: PrestamoDto,
  ) {
    return this.service.update(await empresaIdOf(this.scope, user, req), id, dto);
  }
}
