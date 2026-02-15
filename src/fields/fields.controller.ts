// =====================================================================
// TOLVINK — Fields Controller + Service
// CRUD for producer fields (campos)
// Only producers can manage their own fields
// =====================================================================

import { Controller, Get, Post, Patch, Param, Body, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, MaxLength, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';

// ======================== DTOs =======================================

export class CreateFieldDto {
  @ApiProperty() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ required: false }) @IsOptional()
  address?: string;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lat?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lng?: number;
}

export class CreateLotDto {
  @ApiProperty() @IsNotEmpty() @MaxLength(255)
  name: string;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lat?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  lng?: number;

  @ApiProperty({ required: false }) @IsOptional() @IsNumber()
  hectares?: number;
}

// ======================== SERVICE ====================================

@Injectable()
export class FieldsService {
  constructor(private prisma: PrismaService) {}

  async createField(dto: CreateFieldDto, user: any) {
    if (user.companyType !== 'producer') {
      throw new ForbiddenException('Solo productores pueden crear campos');
    }
    return this.prisma.field.create({
      data: {
        name: dto.name,
        companyId: user.companyId,
        address: dto.address,
        lat: dto.lat,
        lng: dto.lng,
      },
      include: { lots: true },
    });
  }

  async listFields(user: any) {
    return this.prisma.field.findMany({
      where: { companyId: user.companyId, active: true },
      include: { lots: { where: { active: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createLot(fieldId: string, dto: CreateLotDto, user: any) {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.lot.create({
      data: {
        name: dto.name,
        companyId: user.companyId,
        fieldId: field.id,
        lat: dto.lat,
        lng: dto.lng,
        hectares: dto.hectares,
      },
    });
  }

  async listLots(fieldId: string, user: any) {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.lot.findMany({
      where: { fieldId, active: true },
      orderBy: { name: 'asc' },
    });
  }

  async deactivateField(fieldId: string, user: any) {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.field.update({
      where: { id: fieldId },
      data: { active: false },
    });
  }
}

// ======================== CONTROLLER =================================

@ApiTags('Fields')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('fields')
export class FieldsController {
  constructor(private service: FieldsService) {}

  @Post()
  @Roles('producer')
  @ApiOperation({ summary: 'Crear campo (solo productor)' })
  create(@Body() dto: CreateFieldDto, @CurrentUser() user: any) {
    return this.service.createField(dto, user);
  }

  @Get()
  @Roles('producer')
  @ApiOperation({ summary: 'Listar campos del productor' })
  list(@CurrentUser() user: any) {
    return this.service.listFields(user);
  }

  @Post(':id/lots')
  @Roles('producer')
  @ApiOperation({ summary: 'Crear lote dentro de un campo' })
  createLot(
    @Param('id', ParseUUIDPipe) fieldId: string,
    @Body() dto: CreateLotDto,
    @CurrentUser() user: any,
  ) {
    return this.service.createLot(fieldId, dto, user);
  }

  @Get(':id/lots')
  @Roles('producer')
  @ApiOperation({ summary: 'Listar lotes de un campo' })
  listLots(@Param('id', ParseUUIDPipe) fieldId: string, @CurrentUser() user: any) {
    return this.service.listLots(fieldId, user);
  }

  @Patch(':id/deactivate')
  @Roles('producer')
  @ApiOperation({ summary: 'Desactivar campo' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: any) {
    return this.service.deactivateField(id, user);
  }
}
