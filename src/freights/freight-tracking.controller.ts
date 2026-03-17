// =====================================================================
// TOLVINK — Public Freight Tracking Controller
// Public endpoints (no JWT) for real-time freight tracking via share link
// =====================================================================

import { Controller, Get, Param, NotFoundException, BadRequestException, GoneException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from './freights.service';

@Throttle({ default: { ttl: 60000, limit: 60 } })
@Controller('track')
export class FreightTrackingController {
  constructor(private prisma: PrismaService, private freightsService: FreightsService) {}

  private validateToken(token: string) {
    // Security: share tokens should be at least 16 chars to prevent brute-force enumeration
    if (!token || token.length < 16 || token.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(token)) {
      throw new BadRequestException('Token inválido');
    }
  }

  private checkTokenExpiry(freight: { shareTokenExpiresAt?: Date | null }) {
    if (freight.shareTokenExpiresAt && new Date(freight.shareTokenExpiresAt) < new Date()) {
      throw new GoneException('El enlace de seguimiento ha expirado');
    }
  }

  /** Get freight info by public share token (no auth) */
  @Get(':token')
  async getFreightByToken(@Param('token') token: string) {
    this.validateToken(token);
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
        shareTokenExpiresAt: true,
        items: {
          select: { grain: true, tons: true },
          take: 1,
        },
      },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no válido');
    }
    this.checkTokenExpiry(freight);

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
    this.validateToken(token);
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: { id: true, status: true, shareTokenExpiresAt: true },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no válido');
    }
    this.checkTokenExpiry(freight);

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
    this.validateToken(token);
    const freight = await this.prisma.freight.findUnique({
      where: { shareToken: token },
      select: { id: true, status: true, shareTokenExpiresAt: true },
    });

    if (!freight) {
      throw new NotFoundException('Link de seguimiento no válido');
    }
    this.checkTokenExpiry(freight);

    // Don't expose historical GPS data for completed/canceled freights
    if (['finished', 'canceled'].includes(freight.status)) {
      return [];
    }

    return this.freightsService.getParticipantPositions(freight.id);
  }

  /** Get full freight data for PDF report generation (no auth) */
  @Get(':token/report-data')
  async getReportDataByToken(@Param('token') token: string) {
    this.validateToken(token);
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
        shareTokenExpiresAt: true,
        originCompany: { select: { name: true, hasInternalFleet: true } },
        field: { select: { name: true } },
        requestedBy: { select: { name: true } },
        items: {
          select: { grain: true, tons: true },
          take: 1,
        },
        assignments: {
          where: { status: { not: 'rejected' } },
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
      throw new NotFoundException('Link de informe no válido');
    }
    this.checkTokenExpiry(freight);

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

    // PII redaction helper: full name → initials (e.g. "Juan Pérez" → "J.P.")
    const toInitials = (name: string | null | undefined): string | null => {
      if (!name) return null;
      return name.split(' ').map(w => w[0]).join('.') + '.';
    };

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
      requestedByName: toInitials(freight.requestedBy?.name),
      transporterName: a?.transportCompany?.name || null,
      truckPlate: a?.truck?.plate || a?.plate || null,
      truckModel: a?.truck?.model || null,
      driverName: toInitials(a?.driver?.name || a?.driverName),
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
        reason: log.reason ? log.reason.slice(0, 50) : null,
        createdAt: log.createdAt,
        actorCompany: log.user?.company?.name || null,
      })),
    };
  }
}
