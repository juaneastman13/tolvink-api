import {
  Controller, Get, Post, Patch, Param, Query, Body,
  UseGuards, Injectable, NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsNumber, IsIn, IsArray, IsDateString } from 'class-validator';
import { Type } from 'class-transformer';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

// ── DTOs ──────────────────────────────────────────────────────────────

export class CreateMaintenanceRecordDto {
  @IsString() @IsIn(['scheduled_service', 'repair', 'part_change', 'inspection']) type: string;
  @IsDateString() date: string;
  @IsString() @IsNotEmpty() description: string;
  @IsOptional() @IsNumber() @Type(() => Number) horometerReading?: number;
  @IsOptional() @IsNumber() @Type(() => Number) odometerReading?: number;
  @IsOptional() partsUsed?: any;
  @IsOptional() @IsNumber() @Type(() => Number) laborCost?: number;
  @IsOptional() @IsNumber() @Type(() => Number) totalCost?: number;
  @IsOptional() @IsString() workshop?: string;
  @IsOptional() @IsString() mechanic?: string;
  @IsOptional() documents?: any;
  @IsOptional() @IsString() notes?: string;
}

export class UpdateMaintenanceRecordDto {
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsDateString() date?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsNumber() @Type(() => Number) horometerReading?: number;
  @IsOptional() @IsNumber() @Type(() => Number) odometerReading?: number;
  @IsOptional() partsUsed?: any;
  @IsOptional() @IsNumber() @Type(() => Number) laborCost?: number;
  @IsOptional() @IsNumber() @Type(() => Number) totalCost?: number;
  @IsOptional() @IsString() workshop?: string;
  @IsOptional() @IsString() mechanic?: string;
  @IsOptional() documents?: any;
  @IsOptional() @IsString() notes?: string;
}

export class CreatePlanDto {
  @IsArray() intervals: any[];
  @IsOptional() @IsArray() customIntervals?: any[];
}

export class UpdateAlertStatusDto {
  @IsString() @IsIn(['acknowledged', 'completed', 'dismissed']) status: string;
}

// ── Service ───────────────────────────────────────────────────────────

@Injectable()
export class MaintenanceService {
  constructor(private prisma: PrismaService) {}

  private async validateMachineOwnership(machineId: string, companyId: string) {
    const m = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { companyId: true } });
    if (!m || m.companyId !== companyId) throw new NotFoundException('Máquina no encontrada');
  }

  // ── Records ──

  async createRecord(machineId: string, companyId: string, dto: CreateMaintenanceRecordDto) {
    await this.validateMachineOwnership(machineId, companyId);

    const record = await this.prisma.maintenanceRecord.create({
      data: {
        machineId, companyId,
        type: dto.type, date: new Date(dto.date), description: dto.description,
        horometerReading: dto.horometerReading, odometerReading: dto.odometerReading,
        partsUsed: dto.partsUsed, laborCost: dto.laborCost, totalCost: dto.totalCost,
        workshop: dto.workshop, mechanic: dto.mechanic, documents: dto.documents, notes: dto.notes,
      },
    });

    // Update machine horometer if reading is higher
    if (dto.horometerReading != null) {
      const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { currentHorometer: true } });
      if (!machine.currentHorometer || dto.horometerReading > machine.currentHorometer) {
        await this.prisma.machine.update({ where: { id: machineId }, data: { currentHorometer: dto.horometerReading } });
      }
    }

    // Recalculate alerts
    await this.recalculateAlerts(machineId, companyId);

    return record;
  }

  async listRecords(machineId: string, companyId: string, type?: string, from?: string, to?: string) {
    await this.validateMachineOwnership(machineId, companyId);
    const where: any = { machineId };
    if (type) where.type = type;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }
    return this.prisma.maintenanceRecord.findMany({ where, orderBy: { date: 'desc' } });
  }

  async getRecord(id: string, companyId: string) {
    const r = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!r || r.companyId !== companyId) throw new NotFoundException('Registro no encontrado');
    return r;
  }

  async updateRecord(id: string, companyId: string, dto: UpdateMaintenanceRecordDto) {
    const r = await this.prisma.maintenanceRecord.findUnique({ where: { id }, select: { companyId: true, machineId: true } });
    if (!r || r.companyId !== companyId) throw new NotFoundException('Registro no encontrado');
    const data: any = { ...dto };
    if (dto.date) data.date = new Date(dto.date);
    const updated = await this.prisma.maintenanceRecord.update({ where: { id }, data });
    await this.recalculateAlerts(r.machineId, companyId);
    return updated;
  }

  async deleteRecord(id: string, companyId: string) {
    const r = await this.prisma.maintenanceRecord.findUnique({ where: { id }, select: { companyId: true, machineId: true } });
    if (!r || r.companyId !== companyId) throw new NotFoundException('Registro no encontrado');
    await this.prisma.maintenanceRecord.delete({ where: { id } });
    await this.recalculateAlerts(r.machineId, companyId);
    return { ok: true };
  }

  // ── Plans ──

  async createPlan(machineId: string, companyId: string, dto: CreatePlanDto) {
    await this.validateMachineOwnership(machineId, companyId);
    return this.prisma.maintenancePlan.upsert({
      where: { machineId },
      create: { machineId, companyId, intervals: dto.intervals, customIntervals: dto.customIntervals || [] },
      update: { intervals: dto.intervals, customIntervals: dto.customIntervals },
    });
  }

  async createPlanFromTemplate(machineId: string, companyId: string) {
    await this.validateMachineOwnership(machineId, companyId);
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, include: { template: true } });
    if (!machine.template?.maintenanceIntervals) {
      throw new NotFoundException('La máquina no tiene template con intervalos de mantenimiento');
    }
    const mi = machine.template.maintenanceIntervals as Record<string, number>;
    const intervals = Object.entries(mi).map(([key, hours]) => ({
      type: key,
      label: this.intervalLabel(key),
      hours: typeof hours === 'number' ? hours : null,
      months: null,
    }));
    return this.prisma.maintenancePlan.upsert({
      where: { machineId },
      create: { machineId, companyId, intervals },
      update: { intervals },
    });
  }

  async getPlan(machineId: string, companyId: string) {
    await this.validateMachineOwnership(machineId, companyId);
    return this.prisma.maintenancePlan.findUnique({ where: { machineId } });
  }

  async updatePlan(machineId: string, companyId: string, dto: CreatePlanDto) {
    return this.createPlan(machineId, companyId, dto);
  }

  // ── Alerts ──

  async getMachineAlerts(machineId: string, companyId: string) {
    await this.validateMachineOwnership(machineId, companyId);
    await this.recalculateAlerts(machineId, companyId);
    return this.prisma.maintenanceAlert.findMany({
      where: { machineId, status: 'pending' },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }], // overdue first (alphabetically before warning)
    });
  }

  async getAllAlerts(companyId: string) {
    return this.prisma.maintenanceAlert.findMany({
      where: { companyId, status: 'pending' },
      include: { machine: { select: { id: true, brand: true, model: true } } },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
    });
  }

  async updateAlertStatus(id: string, companyId: string, status: string) {
    const a = await this.prisma.maintenanceAlert.findUnique({ where: { id }, select: { companyId: true } });
    if (!a || a.companyId !== companyId) throw new NotFoundException('Alerta no encontrada');
    return this.prisma.maintenanceAlert.update({ where: { id }, data: { status } });
  }

  // ── Alert Calculation ──

  async recalculateAlerts(machineId: string, companyId: string) {
    const plan = await this.prisma.maintenancePlan.findUnique({ where: { machineId } });
    if (!plan) return;

    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { currentHorometer: true, createdAt: true } });
    const allIntervals = [...(plan.intervals as any[] || []), ...(plan.customIntervals as any[] || [])];

    for (const interval of allIntervals) {
      if (!interval.type || !interval.hours) continue;

      // Find last maintenance of this type
      const lastRecord = await this.prisma.maintenanceRecord.findFirst({
        where: { machineId, type: { in: ['scheduled_service', 'part_change'] } },
        orderBy: { date: 'desc' },
      });

      const lastHorometer = lastRecord?.horometerReading ?? 0;
      const currentHorometer = machine.currentHorometer ?? 0;
      const hoursSinceLast = currentHorometer - lastHorometer;
      const threshold = interval.hours as number;

      let severity: string | null = null;
      if (hoursSinceLast >= threshold) severity = 'overdue';
      else if (hoursSinceLast >= threshold * 0.9) severity = 'warning';

      // Find existing pending alert for this type
      const existing = await this.prisma.maintenanceAlert.findFirst({
        where: { machineId, maintenanceType: interval.type, status: 'pending' },
      });

      if (severity) {
        const hoursLeft = Math.round(threshold - hoursSinceLast);
        const message = severity === 'overdue'
          ? `Vencido — ${Math.abs(hoursLeft)} hs de atraso`
          : `Faltan ~${hoursLeft} hs para ${interval.label || interval.type}`;

        if (existing) {
          await this.prisma.maintenanceAlert.update({
            where: { id: existing.id },
            data: { severity, message, dueHorometer: lastHorometer + threshold },
          });
        } else {
          await this.prisma.maintenanceAlert.create({
            data: {
              machineId, companyId,
              type: 'hours_based', maintenanceType: interval.type,
              label: interval.label || interval.type, message, severity,
              dueHorometer: lastHorometer + threshold,
            },
          });
        }
      } else if (existing) {
        // No longer due — remove pending alert
        await this.prisma.maintenanceAlert.delete({ where: { id: existing.id } });
      }
    }
  }

  private intervalLabel(key: string): string {
    const labels: Record<string, string> = {
      oilChange: 'Cambio de aceite', filters: 'Cambio de filtros',
      majorService: 'Service mayor', lubrication: 'Lubricación general',
      generalService: 'Service general',
    };
    return labels[key] || key;
  }
}

// ── Controller ────────────────────────────────────────────────────────

@ApiTags('Maintenance')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class MaintenanceController {
  constructor(private svc: MaintenanceService) {}

  private cid(user: any) { return user.activeCompanyId || user.companyId; }

  // ── Records ──
  @Post('machines/:machineId/maintenance-records')
  createRecord(@Param('machineId') machineId: string, @Body() dto: CreateMaintenanceRecordDto, @CurrentUser() user: any) {
    return this.svc.createRecord(machineId, this.cid(user), dto);
  }

  @Get('machines/:machineId/maintenance-records')
  listRecords(@Param('machineId') machineId: string, @CurrentUser() user: any,
    @Query('type') type?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.svc.listRecords(machineId, this.cid(user), type, from, to);
  }

  @Get('maintenance-records/:id')
  getRecord(@Param('id') id: string, @CurrentUser() user: any) {
    return this.svc.getRecord(id, this.cid(user));
  }

  @Patch('maintenance-records/:id')
  updateRecord(@Param('id') id: string, @Body() dto: UpdateMaintenanceRecordDto, @CurrentUser() user: any) {
    return this.svc.updateRecord(id, this.cid(user), dto);
  }

  // ── Plans ──
  @Post('machines/:machineId/maintenance-plan')
  createPlan(@Param('machineId') machineId: string, @Body() dto: CreatePlanDto, @CurrentUser() user: any) {
    return this.svc.createPlan(machineId, this.cid(user), dto);
  }

  @Post('machines/:machineId/maintenance-plan/from-template')
  createPlanFromTemplate(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.createPlanFromTemplate(machineId, this.cid(user));
  }

  @Get('machines/:machineId/maintenance-plan')
  getPlan(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.getPlan(machineId, this.cid(user));
  }

  @Patch('machines/:machineId/maintenance-plan')
  updatePlan(@Param('machineId') machineId: string, @Body() dto: CreatePlanDto, @CurrentUser() user: any) {
    return this.svc.updatePlan(machineId, this.cid(user), dto);
  }

  // ── Alerts ──
  @Get('machines/:machineId/alerts')
  getMachineAlerts(@Param('machineId') machineId: string, @CurrentUser() user: any) {
    return this.svc.getMachineAlerts(machineId, this.cid(user));
  }

  @Get('mechanic/alerts')
  getAllAlerts(@CurrentUser() user: any) {
    return this.svc.getAllAlerts(this.cid(user));
  }

  @Patch('maintenance-alerts/:id')
  updateAlertStatus(@Param('id') id: string, @Body() dto: UpdateAlertStatusDto, @CurrentUser() user: any) {
    return this.svc.updateAlertStatus(id, this.cid(user), dto.status);
  }
}
