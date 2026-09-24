import {
  Body,
  Controller,
  Get,
  Injectable,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../database/prisma.service';
import { AgroRoles, AgroRolesGuard } from '../common/agro-roles.guard';
import { ModuleAccessGuard } from '../common/module-access.guard';
import { AgroSeedService } from './agro-seed.service';

// ── DTOs ──────────────────────────────────────────────────────────────

export class CreateAgroEmpresaDto {
  @IsString() @MaxLength(255) nombre!: string;
  @IsOptional() @IsString() @MaxLength(20) rut?: string;
}

export class UpdateAgroEmpresaDto {
  @IsOptional() @IsString() @MaxLength(255) nombre?: string;
  @IsOptional() @IsString() @MaxLength(20) rut?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class AgroEmpresaService {
  constructor(
    private prisma: PrismaService,
    private seed: AgroSeedService,
  ) {}

  list(companyId: string) {
    return this.prisma.agroEmpresa.findMany({
      where: { companyId },
      orderBy: [{ active: 'desc' }, { nombre: 'asc' }],
    });
  }

  async create(companyId: string, dto: CreateAgroEmpresaDto) {
    const empresa = await this.prisma.agroEmpresa.create({
      data: { companyId, nombre: dto.nombre, rut: dto.rut },
    });
    // Aplico seeds base (centros, categorías, cuentas, config default) al crear.
    await this.seed.seedEmpresa(empresa.id);
    return empresa;
  }

  async update(companyId: string, id: string, dto: UpdateAgroEmpresaDto) {
    // Filtro por companyId para prevenir cross-tenant.
    const res = await this.prisma.agroEmpresa.updateMany({
      where: { id, companyId },
      data: dto,
    });
    if (res.count === 0) {
      throw new Error('AgroEmpresa no encontrada');
    }
    return this.prisma.agroEmpresa.findUnique({ where: { id } });
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Agro / Empresa')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
@Controller('agro/empresas')
export class AgroEmpresaController {
  constructor(private service: AgroEmpresaService) {}

  @Get()
  list(@CurrentUser() user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    return this.service.list(companyId);
  }

  @Post()
  @AgroRoles('agro_admin')
  create(@CurrentUser() user: any, @Body() dto: CreateAgroEmpresaDto) {
    const companyId = user.activeCompanyId || user.companyId;
    return this.service.create(companyId, dto);
  }

  @Patch(':id')
  @AgroRoles('agro_admin')
  update(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() dto: UpdateAgroEmpresaDto,
  ) {
    const companyId = user.activeCompanyId || user.companyId;
    return this.service.update(companyId, id, dto);
  }
}
