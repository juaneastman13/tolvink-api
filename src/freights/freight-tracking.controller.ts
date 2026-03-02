// =====================================================================
// TOLVINK — Public Freight Tracking Controller
// Public endpoints (no JWT) for real-time freight tracking via share link
// =====================================================================

import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from './freights.service';

@Throttle({ default: { ttl: 60000, limit: 60 } })
@Controller('track')
export class FreightTrackingController {
  constructor(private prisma: PrismaService, private freightsService: FreightsService) {}

  /** Get freight info by public share token (no auth) */
  @Get(':token')
  async getFreightByToken(@Param('token') token: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: {
        code: true,
        status: true,
        originName: true,
        destName: true,
        originLat: true,
        originLng: true,
        destLat: true,
        destLng: true,
        items: {
          select: { grain: true, tons: true },
          take: 1,
        },
      },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no valido');
    }

    return {
      code: freight.code,
      status: freight.status,
      grain: freight.items[0]?.grain || null,
      tons: freight.items[0]?.tons ? Number(freight.items[0].tons) : null,
      originName: freight.originName,
      destName: freight.destName,
      originLat: freight.originLat ? Number(freight.originLat) : null,
      originLng: freight.originLng ? Number(freight.originLng) : null,
      destLat: freight.destLat ? Number(freight.destLat) : null,
      destLng: freight.destLng ? Number(freight.destLng) : null,
    };
  }

  /** Get last truck position by public share token (no auth) */
  @Get(':token/position')
  async getLastPositionByToken(@Param('token') token: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: { id: true, status: true },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no valido');
    }

    if (['finished', 'canceled'].includes(freight.status)) {
      return null;
    }

    return this.prisma.freightTracking.findFirst({
      where: { freightId: freight.id },
      orderBy: { createdAt: 'desc' },
      select: { lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
  }

  /** Get participant positions by public share token (no auth) */
  @Get(':token/participants')
  async getParticipantsByToken(@Param('token') token: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: { id: true },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no válido');
    }

    return this.freightsService.getParticipantPositions(freight.id);
  }

  /** Get full freight data for PDF report generation (no auth) */
  @Get(':token/report-data')
  async getReportDataByToken(@Param('token') token: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: {
        id: true,
        code: true,
        status: true,
        originCompanyId: true,
        originName: true,
        originLat: true,
        originLng: true,
        destName: true,
        destLat: true,
        destLng: true,
        loadDate: true,
        loadTime: true,
        startedAt: true,
        loadedAt: true,
        finishedAt: true,
        notes: true,
        originCompany: { select: { name: true, hasInternalFleet: true } },
        field: { select: { name: true } },
        requestedBy: { select: { name: true } },
        items: {
          select: { grain: true, tons: true },
          take: 1,
        },
        assignments: {
          where: { status: { not: 'rejected' as any } },
          orderBy: { createdAt: 'desc' as const },
          take: 1,
          select: {
            transportCompanyId: true,
            transportCompany: { select: { name: true } },
            driver: { select: { name: true } },
            driverName: true,
            truck: { select: { plate: true, model: true } },
            plate: true,
          },
        },
        documents: {
          orderBy: { createdAt: 'desc' as const },
          take: 20,
          select: { name: true, type: true, step: true, createdAt: true },
        },
      },
    });

    if (!freight) {
      throw new NotFoundException('Link de informe no valido');
    }

    // Fetch audit log
    const auditLog = await this.prisma.auditLog.findMany({
      where: { entityType: 'freight', entityId: freight.id },
      orderBy: { createdAt: 'asc' },
      take: 200,
      select: {
        action: true,
        reason: true,
        createdAt: true,
        user: {
          select: {
            name: true,
            company: { select: { name: true } },
          },
        },
      },
    });

    const item = freight.items[0];
    const a = freight.assignments[0];
    const isOwnFleet = !!(a && freight.originCompany?.hasInternalFleet && a.transportCompanyId === freight.originCompanyId);

    return {
      code: freight.code,
      status: freight.status,
      grain: item?.grain || null,
      tons: item?.tons ? Number(item.tons) : null,
      unit: 'toneladas',
      originCompanyName: freight.originCompany?.name || null,
      fieldName: freight.field?.name || null,
      originName: freight.originName,
      destName: freight.destName,
      loadDate: freight.loadDate ? freight.loadDate.toISOString().split('T')[0] : null,
      loadTime: freight.loadTime,
      requestedByName: freight.requestedBy?.name || null,
      transporterName: a?.transportCompany?.name || null,
      truckPlate: a?.truck?.plate || a?.plate || null,
      truckModel: a?.truck?.model || null,
      driverName: a?.driver?.name || a?.driverName || null,
      isOwnFleet,
      notes: freight.notes,
      originLat: freight.originLat ? Number(freight.originLat) : null,
      originLng: freight.originLng ? Number(freight.originLng) : null,
      destLat: freight.destLat ? Number(freight.destLat) : null,
      destLng: freight.destLng ? Number(freight.destLng) : null,
      startedAt: freight.startedAt,
      loadedAt: freight.loadedAt,
      finishedAt: freight.finishedAt,
      documents: freight.documents.map(d => ({
        name: d.name,
        type: d.type,
        step: d.step,
        createdAt: d.createdAt,
      })),
      auditLog: auditLog.map(log => ({
        action: log.action,
        createdAt: log.createdAt,
        actorCompany: log.user?.company?.name || null,
      })),
    };
  }
}
