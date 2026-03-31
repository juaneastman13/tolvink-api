import {
  Controller, Get, Post, Patch, Delete, Param, Query, Body,
  UseGuards, Injectable, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsInt, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';
import { randomUUID } from 'crypto';

// ── DTOs ──────────────────────────────────────────────────────────────

export class CreateMachineDto {
  @IsString() @IsNotEmpty() machineType: string;
  @IsString() @IsNotEmpty() brand: string;
  @IsString() @IsNotEmpty() model: string;
  @IsString() @IsNotEmpty() serialNumber: string;
  @IsOptional() @IsInt() @Type(() => Number) year?: number;
  @IsOptional() @IsString() templateId?: string;
  @IsOptional() @IsString() engineBrand?: string;
  @IsOptional() @IsString() engineModel?: string;
  @IsOptional() @IsString() enginePower?: string;
  @IsOptional() @IsString() engineDisplacement?: string;
  @IsOptional() @IsString() transmissionType?: string;
  @IsOptional() @IsString() fuelType?: string;
  @IsOptional() @IsString() hydraulicSystem?: string;
  @IsOptional() @IsString() hydraulicCapacity?: string;
  @IsOptional() @IsString() tireSize?: string;
  @IsOptional() @IsString() tireBrand?: string;
  @IsOptional() @IsNumber() @Type(() => Number) currentHorometer?: number;
  @IsOptional() @IsNumber() @Type(() => Number) currentOdometer?: number;
  @IsOptional() notes?: string;
  @IsOptional() photos?: any;
}

export class UpdateMachineDto {
  @IsOptional() @IsString() brand?: string;
  @IsOptional() @IsString() model?: string;
  @IsOptional() @IsString() machineType?: string;
  @IsOptional() @IsInt() @Type(() => Number) year?: number;
  @IsOptional() @IsString() serialNumber?: string;
  @IsOptional() @IsString() engineBrand?: string;
  @IsOptional() @IsString() engineModel?: string;
  @IsOptional() @IsString() enginePower?: string;
  @IsOptional() @IsString() engineDisplacement?: string;
  @IsOptional() @IsString() transmissionType?: string;
  @IsOptional() @IsString() fuelType?: string;
  @IsOptional() @IsString() hydraulicSystem?: string;
  @IsOptional() @IsString() hydraulicCapacity?: string;
  @IsOptional() @IsString() tireSize?: string;
  @IsOptional() @IsString() tireBrand?: string;
  @IsOptional() @IsNumber() @Type(() => Number) currentHorometer?: number;
  @IsOptional() @IsNumber() @Type(() => Number) currentOdometer?: number;
  @IsOptional() @IsString() notes?: string;
  @IsOptional() photos?: any;
  @IsOptional() @IsString() @IsIn(['active', 'inactive', 'sold']) status?: string;
}

export class CreateModificationDto {
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() notes?: string;
}

export class CreateRepairDto {
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsString() date?: string;
  @IsOptional() @IsString() workshop?: string;
  @IsOptional() @IsNumber() @Type(() => Number) cost?: number;
  @IsOptional() @IsString() notes?: string;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class MachinesService {
  constructor(private prisma: PrismaService) {}

  // ── Templates ──

  async listTemplates(brand?: string, machineType?: string, search?: string) {
    const where: any = {};
    if (brand) where.brand = brand;
    if (machineType) where.machineType = machineType;
    if (search) where.OR = [
      { brand: { contains: search, mode: 'insensitive' } },
      { model: { contains: search, mode: 'insensitive' } },
      { series: { contains: search, mode: 'insensitive' } },
    ];
    return this.prisma.machineTemplate.findMany({ where, orderBy: [{ brand: 'asc' }, { model: 'asc' }] });
  }

  async getTemplate(id: string) {
    const t = await this.prisma.machineTemplate.findUnique({ where: { id } });
    if (!t) throw new NotFoundException('Template no encontrado');
    return t;
  }

  async getBrands() {
    const rows = await this.prisma.machineTemplate.findMany({ select: { brand: true }, distinct: ['brand'], orderBy: { brand: 'asc' } });
    return rows.map(r => r.brand);
  }

  async getSeriesForBrand(brand: string) {
    const rows = await this.prisma.machineTemplate.findMany({
      where: { brand: { equals: brand, mode: 'insensitive' } },
      select: { series: true },
      distinct: ['series'],
      orderBy: { series: 'asc' },
    });
    return rows.map(r => r.series).filter(Boolean);
  }

  // ── Machines ──

  async createMachine(companyId: string, dto: CreateMachineDto) {
    let templateData: any = {};
    if (dto.templateId) {
      const tmpl = await this.prisma.machineTemplate.findUnique({ where: { id: dto.templateId } });
      if (tmpl) {
        templateData = {
          engineBrand: tmpl.engineBrand, engineModel: tmpl.engineModel,
          enginePower: tmpl.enginePower, engineDisplacement: tmpl.engineDisplacement,
          transmissionType: tmpl.transmissionType, fuelType: tmpl.fuelType,
          hydraulicSystem: tmpl.hydraulicSystem,
        };
      }
    }

    return this.prisma.machine.create({
      data: {
        companyId,
        templateId: dto.templateId || undefined,
        machineType: dto.machineType,
        brand: dto.brand,
        model: dto.model,
        serialNumber: dto.serialNumber,
        year: dto.year,
        qrCode: randomUUID(),
        photos: dto.photos || [],
        notes: dto.notes,
        currentHorometer: dto.currentHorometer,
        currentOdometer: dto.currentOdometer,
        // Template defaults, overridden by explicit DTO values
        ...templateData,
        ...(dto.engineBrand && { engineBrand: dto.engineBrand }),
        ...(dto.engineModel && { engineModel: dto.engineModel }),
        ...(dto.enginePower && { enginePower: dto.enginePower }),
        ...(dto.engineDisplacement && { engineDisplacement: dto.engineDisplacement }),
        ...(dto.transmissionType && { transmissionType: dto.transmissionType }),
        ...(dto.fuelType && { fuelType: dto.fuelType }),
        ...(dto.hydraulicSystem && { hydraulicSystem: dto.hydraulicSystem }),
        ...(dto.hydraulicCapacity && { hydraulicCapacity: dto.hydraulicCapacity }),
        ...(dto.tireSize && { tireSize: dto.tireSize }),
        ...(dto.tireBrand && { tireBrand: dto.tireBrand }),
      },
    });
  }

  async listMachines(companyId: string, machineType?: string, status?: string, search?: string) {
    const where: any = { companyId };
    if (machineType) where.machineType = machineType;
    if (status) where.status = status;
    else where.status = { not: 'inactive' }; // default: hide inactive
    if (search) where.OR = [
      { brand: { contains: search, mode: 'insensitive' } },
      { model: { contains: search, mode: 'insensitive' } },
      { serialNumber: { contains: search, mode: 'insensitive' } },
    ];
    return this.prisma.machine.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async getMachine(id: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({
      where: { id },
      include: { modifications: { orderBy: { date: 'desc' } }, repairHistory: { orderBy: { date: 'desc' } }, template: true },
    });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
    return m;
  }

  async updateMachine(id: string, companyId: string, dto: UpdateMachineDto) {
    const m = await this.prisma.machine.findUnique({ where: { id }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
    return this.prisma.machine.update({ where: { id }, data: dto as any });
  }

  async deleteMachine(id: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({ where: { id }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
    return this.prisma.machine.update({ where: { id }, data: { status: 'inactive' } });
  }

  async lookupByQr(qrCode: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({ where: { qrCode }, select: { id: true, companyId: true } });
    if (!m) throw new NotFoundException('QR no encontrado');
    if (m.companyId !== companyId) throw new ForbiddenException('Esta máquina no pertenece a tu empresa');
    return { id: m.id };
  }

  // ── Modifications ──

  async addModification(machineId: string, companyId: string, dto: CreateModificationDto) {
    await this.validateOwnership(machineId, companyId);
    return this.prisma.machineModification.create({
      data: { machineId, description: dto.description, date: dto.date ? new Date(dto.date) : undefined, notes: dto.notes },
    });
  }

  async listModifications(machineId: string, companyId: string) {
    await this.validateOwnership(machineId, companyId);
    return this.prisma.machineModification.findMany({ where: { machineId }, orderBy: { date: 'desc' } });
  }

  // ── Repair History ──

  async addRepair(machineId: string, companyId: string, dto: CreateRepairDto) {
    await this.validateOwnership(machineId, companyId);
    return this.prisma.machineRepairHistory.create({
      data: { machineId, description: dto.description, date: dto.date ? new Date(dto.date) : undefined, workshop: dto.workshop, cost: dto.cost, notes: dto.notes },
    });
  }

  async listRepairs(machineId: string, companyId: string) {
    await this.validateOwnership(machineId, companyId);
    return this.prisma.machineRepairHistory.findMany({ where: { machineId }, orderBy: { date: 'desc' } });
  }

  // ── Helpers ──

  private async validateOwnership(machineId: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
  }
}

// ── Templates Controller (public) ─────────────────────────────────────

@ApiTags('Machine Templates')
@Controller('machine-templates')
export class MachineTemplatesController {
  constructor(private svc: MachinesService) {}

  @Get('brands')
  getBrands() { return this.svc.getBrands(); }

  @Get('brands/:brand/series')
  getSeries(@Param('brand') brand: string) { return this.svc.getSeriesForBrand(decodeURIComponent(brand)); }

  @Get(':id')
  getTemplate(@Param('id') id: string) { return this.svc.getTemplate(id); }

  @Get()
  listTemplates(@Query('brand') brand?: string, @Query('machineType') machineType?: string, @Query('search') search?: string) {
    return this.svc.listTemplates(brand, machineType, search);
  }
}

// ── Machines Controller (auth required) ───────────────────────────────

@ApiTags('Machines')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('machines')
export class MachinesController {
  constructor(private svc: MachinesService) {}

  @Get('qr/:qrCode')
  lookupQr(@Param('qrCode') qrCode: string, @CurrentUser() user: any) {
    return this.svc.lookupByQr(qrCode, user.activeCompanyId || user.companyId);
  }

  @Post()
  create(@Body() dto: CreateMachineDto, @CurrentUser() user: any) {
    return this.svc.createMachine(user.activeCompanyId || user.companyId, dto);
  }

  @Get()
  list(@CurrentUser() user: any, @Query('machineType') machineType?: string, @Query('status') status?: string, @Query('search') search?: string) {
    return this.svc.listMachines(user.activeCompanyId || user.companyId, machineType, status, search);
  }

  @Get(':id')
  getOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.getMachine(id, user.activeCompanyId || user.companyId);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMachineDto, @CurrentUser() user: any) {
    return this.svc.updateMachine(id, user.activeCompanyId || user.companyId, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.deleteMachine(id, user.activeCompanyId || user.companyId);
  }

  // ── Modifications ──
  @Post(':machineId/modifications')
  addMod(@Param('machineId') machineId: string, @Body() dto: CreateModificationDto, @CurrentUser() user: any) {
    return this.svc.addModification(machineId, user.activeCompanyId || user.companyId, dto);
  }

  @Get(':machineId/modifications')
  listMods(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.listModifications(machineId, user.activeCompanyId || user.companyId);
  }

  // ── Repair History ──
  @Post(':machineId/repair-history')
  addRepair(@Param('machineId') machineId: string, @Body() dto: CreateRepairDto, @CurrentUser() user: any) {
    return this.svc.addRepair(machineId, user.activeCompanyId || user.companyId, dto);
  }

  @Get(':machineId/repair-history')
  listRepairs(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.listRepairs(machineId, user.activeCompanyId || user.companyId);
  }
}
