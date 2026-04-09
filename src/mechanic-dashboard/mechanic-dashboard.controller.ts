import { Controller, Get, UseGuards, Injectable } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class MechanicDashboardService {
  constructor(private prisma: PrismaService) {}

  async getDashboard(companyId: string) {
    // Fetch all active machines with related counts
    const machines = await this.prisma.machine.findMany({
      where: { companyId, status: { not: 'inactive' } },
      include: {
        maintenanceAlerts: { where: { status: 'pending' } },
        maintenanceRecords: { orderBy: { date: 'desc' }, take: 1, select: { type: true, date: true, horometerReading: true } },
        maintenancePlan: { select: { intervals: true, customIntervals: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    let upToDate = 0, alertCount = 0, openIssues = 0;

    const machineList = machines.map(m => {
      const alerts = m.maintenanceAlerts || [];
      const hasOverdue = alerts.some(a => a.severity === 'overdue');
      const hasWarning = alerts.some(a => a.severity === 'warning');

      let status: string;
      if (hasOverdue) { status = 'overdue'; alertCount++; }
      else if (hasWarning) { status = 'alert'; alertCount++; }
      else { status = 'up_to_date'; upToDate++; }

      // Next maintenance estimate
      let nextMaintenance: any = null;
      const plan = m.maintenancePlan;
      if (plan) {
        const allIntervals = [...(plan.intervals as any[] || []), ...(plan.customIntervals as any[] || [])];
        const firstInterval = allIntervals[0];
        if (firstInterval?.hours && m.currentHorometer != null) {
          const lastRecord = m.maintenanceRecords?.[0];
          const lastHoro = lastRecord?.horometerReading ?? 0;
          const nextHoro = lastHoro + (firstInterval.hours as number);
          nextMaintenance = { type: firstInterval.label || firstInterval.type, estimatedAt: `~${Math.round(nextHoro)} hs` };
        }
      }

      const lastMaint = m.maintenanceRecords?.[0];

      return {
        id: m.id, brand: m.brand, model: m.model, machineType: m.machineType,
        year: m.year, serialNumber: m.serialNumber, currentHorometer: m.currentHorometer,
        photoUrl: (m.photos as any[])?.[0] || null,
        status,
        alertsCount: alerts.length,
        nextMaintenance,
        lastMaintenance: lastMaint ? {
          type: lastMaint.type,
          date: lastMaint.date,
          horometerReading: lastMaint.horometerReading,
        } : null,
      };
    });

    // Recent alerts (top 5)
    const recentAlerts = await this.prisma.maintenanceAlert.findMany({
      where: { companyId, status: 'pending' },
      include: { machine: { select: { id: true, brand: true, model: true } } },
      orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }],
      take: 5,
    });

    return {
      summary: {
        totalMachines: machines.length,
        activeMachines: machines.length,
        upToDate, alertsPending: alertCount, openIssues,
      },
      machines: machineList,
      recentAlerts: recentAlerts.map(a => ({
        id: a.id, machineId: a.machineId,
        machineBrand: a.machine.brand, machineModel: a.machine.model,
        label: a.label, message: a.message, severity: a.severity, status: a.status,
      })),
    };
  }
}

@ApiTags('Mechanic Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('mechanic')
export class MechanicDashboardController {
  constructor(private svc: MechanicDashboardService) {}

  @Get('dashboard')
  getDashboard(@CurrentUser() user: any) {
    return this.svc.getDashboard(user.activeCompanyId || user.companyId);
  }
}
