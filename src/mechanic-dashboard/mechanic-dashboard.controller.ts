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
        diagnosticSessions: { where: { status: 'open' }, select: { id: true } },
        maintenanceRecords: { orderBy: { date: 'desc' }, take: 1, select: { type: true, date: true, horometerReading: true } },
        maintenancePlan: { select: { intervals: true, customIntervals: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    let upToDate = 0, alertCount = 0, openIssues = 0;

    const machineList = machines.map(m => {
      const alerts = m.maintenanceAlerts || [];
      const openDiags = m.diagnosticSessions?.length || 0;
      const hasOverdue = alerts.some(a => a.severity === 'overdue');
      const hasWarning = alerts.some(a => a.severity === 'warning');

      let status: string;
      if (openDiags > 0) { status = 'open_issue'; openIssues++; }
      else if (hasOverdue) { status = 'overdue'; alertCount++; }
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
        openDiagnosticsCount: openDiags,
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

    // Recent open diagnostics (top 5)
    const recentDiagnostics = await this.prisma.diagnosticSession.findMany({
      where: { companyId, status: 'open' },
      select: {
        id: true, machineId: true, title: true, status: true, createdAt: true, messages: true,
        machine: { select: { id: true, brand: true, model: true } },
      },
      orderBy: { createdAt: 'desc' },
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
      recentDiagnostics: recentDiagnostics.map(d => ({
        id: d.id, machineId: d.machineId,
        machineBrand: d.machine.brand, machineModel: d.machine.model,
        title: d.title, status: d.status, createdAt: d.createdAt,
        messagesCount: Array.isArray(d.messages) ? (d.messages as any[]).length : 0,
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
