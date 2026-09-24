import {
  Body,
  Controller,
  Delete,
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
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroScopeService } from '../common/agro-scope.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { empresaIdOf } from '../common/agro-base.controller';

// ── DTOs ──────────────────────────────────────────────────────────────

export class CampoDto {
  @IsString() @MaxLength(200) nombre!: string;
  @IsNumber() hectareas!: number;
  @IsOptional() @IsBoolean() propio?: boolean;
  @IsOptional() @IsNumber() rentaUsdHaAno?: number;
  @IsOptional() @IsString() @MaxLength(50) aptitud?: string;
}

export class PotreroDto {
  @IsString() @MaxLength(150) nombre!: string;
  @IsNumber() hectareas!: number;
  @IsString() campoId!: string;
}

// ── Services ──────────────────────────────────────────────────────────

@Injectable()
export class AgroCamposService {
  constructor(private prisma: PrismaService) {}

  list(empresaId: string) {
    return this.prisma.agroCampo.findMany({
      where: { empresaId },
      include: { potreros: true },
      orderBy: { nombre: 'asc' },
    });
  }

  create(empresaId: string, dto: CampoDto) {
    return this.prisma.agroCampo.create({
      data: {
        empresaId,
        nombre: dto.nombre,
        hectareas: new Prisma.Decimal(dto.hectareas),
        propio: dto.propio ?? true,
        rentaUsdHaAno:
          dto.rentaUsdHaAno !== undefined ? new Prisma.Decimal(dto.rentaUsdHaAno) : null,
        aptitud: dto.aptitud ?? null,
      },
    });
  }

  async update(empresaId: string, id: string, dto: Partial<CampoDto>) {
    const res = await this.prisma.agroCampo.updateMany({
      where: { id, empresaId },
      data: {
        ...(dto.nombre !== undefined && { nombre: dto.nombre }),
        ...(dto.hectareas !== undefined && { hectareas: new Prisma.Decimal(dto.hectareas) }),
        ...(dto.propio !== undefined && { propio: dto.propio }),
        ...(dto.rentaUsdHaAno !== undefined && {
          rentaUsdHaAno: new Prisma.Decimal(dto.rentaUsdHaAno),
        }),
        ...(dto.aptitud !== undefined && { aptitud: dto.aptitud }),
      },
    });
    if (res.count === 0) throw new Error('Campo no encontrado');
    return this.prisma.agroCampo.findUnique({ where: { id } });
  }

  async remove(empresaId: string, id: string) {
    const res = await this.prisma.agroCampo.deleteMany({ where: { id, empresaId } });
    return { deleted: res.count };
  }

  // Potreros -----------------------------------------------------------

  createPotrero(empresaId: string, dto: PotreroDto) {
    return this.prisma.agroPotrero.create({
      data: {
        empresaId,
        campoId: dto.campoId,
        nombre: dto.nombre,
        hectareas: new Prisma.Decimal(dto.hectareas),
      },
    });
  }

  async updatePotrero(empresaId: string, id: string, dto: Partial<PotreroDto>) {
    const res = await this.prisma.agroPotrero.updateMany({
      where: { id, empresaId },
      data: {
        ...(dto.nombre !== undefined && { nombre: dto.nombre }),
        ...(dto.hectareas !== undefined && { hectareas: new Prisma.Decimal(dto.hectareas) }),
        ...(dto.campoId !== undefined && { campoId: dto.campoId }),
      },
    });
    if (res.count === 0) throw new Error('Potrero no encontrado');
    return this.prisma.agroPotrero.findUnique({ where: { id } });
  }

  async removePotrero(empresaId: string, id: string) {
    const res = await this.prisma.agroPotrero.deleteMany({ where: { id, empresaId } });
    return { deleted: res.count };
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Campos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/campos')
export class AgroCamposController {
  constructor(
    private service: AgroCamposService,
    private scope: AgroScopeService,
  ) {}

  @Get()
  async list(@CurrentUser() user: any, @Req() req: any) {
    return this.service.list(await empresaIdOf(this.scope, user, req));
  }

  @Post()
  @AgroRoles('agro_admin')
  async create(@CurrentUser() user: any, @Req() req: any, @Body() dto: CampoDto) {
    return this.service.create(await empresaIdOf(this.scope, user, req), dto);
  }

  @Patch(':id')
  @AgroRoles('agro_admin')
  async update(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: CampoDto,
  ) {
    return this.service.update(await empresaIdOf(this.scope, user, req), id, dto);
  }

  @Delete(':id')
  @AgroRoles('agro_admin')
  async remove(@CurrentUser() user: any, @Req() req: any, @Param('id') id: string) {
    return this.service.remove(await empresaIdOf(this.scope, user, req), id);
  }

  // Potreros -----------------------------------------------------------

  @Post('potreros')
  @AgroRoles('agro_admin')
  async createPotrero(
    @CurrentUser() user: any,
    @Req() req: any,
    @Body() dto: PotreroDto,
  ) {
    return this.service.createPotrero(await empresaIdOf(this.scope, user, req), dto);
  }

  @Patch('potreros/:id')
  @AgroRoles('agro_admin')
  async updatePotrero(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
    @Body() dto: PotreroDto,
  ) {
    return this.service.updatePotrero(
      await empresaIdOf(this.scope, user, req),
      id,
      dto,
    );
  }

  @Delete('potreros/:id')
  @AgroRoles('agro_admin')
  async removePotrero(
    @CurrentUser() user: any,
    @Req() req: any,
    @Param('id') id: string,
  ) {
    return this.service.removePotrero(await empresaIdOf(this.scope, user, req), id);
  }
}
