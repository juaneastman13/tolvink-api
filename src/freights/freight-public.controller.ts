// =====================================================================
// TOLVINK — Public Freight Endpoints by Code (clean URLs)
// Public endpoints (no JWT) — resolves freight by code instead of token
// Requires freight to have been shared (shareToken !== null)
// =====================================================================

import {
  Controller,
  Get,
  Param,
  Query,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';
import { FreightsService } from './freights.service';

@Throttle({ default: { ttl: 60000, limit: 60 } })
@Controller('f')
export class FreightPublicController {
  constructor(private prisma: PrismaService, private freightsService: FreightsService) {}

  private validateCode(code: string): string {
    const normalized = code.toUpperCase();
    if (!/^(FLT-\d{4,}|F\d{2}-[A-Z]{3}\.\d{4})$/.test(normalized)) {
      throw new BadRequestException('Código de flete inválido');
    }
    return normalized;
  }

  private async findSharedFreight(code: string, shareToken: string | undefined, select: Record<string, any>): Promise<any> {
    // shareToken is required — code-only access is not allowed
    if (!shareToken) {
      throw new BadRequestException('Token de compartir requerido');
    }
    const freight = await this.prisma.freight.findFirst({
      where: { code, shareToken },
      select,
    });
    if (!freight) {
      throw new NotFoundException('Flete no encontrado');
    }
    return freight;
  }

  /** Get freight info by code (clean URL) */
  @Get(':code')
  async getFreightByCode(@Param('code') code: string, @Query('s') shareToken?: string) {
    const normalized = this.validateCode(code);
    const freight = await this.findSharedFreight(normalized, shareToken, {
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
    });

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

  /** Get last truck position by code (clean URL) */
  @Get(':code/position')
  async getLastPositionByCode(@Param('code') code: string, @Query('s') shareToken?: string) {
    const normalized = this.validateCode(code);
    const freight = await this.findSharedFreight(normalized, shareToken, {
      id: true,
      status: true,
    });

    if (['finished', 'canceled'].includes(freight.status)) {
      return null;
    }

    return this.prisma.freightTracking.findFirst({
      where: { freightId: freight.id },
      orderBy: { createdAt: 'desc' },
      select: {
        lat: true,
        lng: true,
        speed: true,
        heading: true,
        createdAt: true,
      },
    });
  }

  /** Get participant positions by code (clean URL) */
  @Get(':code/participants')
  async getParticipantsByCode(@Param('code') code: string, @Query('s') shareToken?: string) {
    const normalized = this.validateCode(code);
    const freight = await this.findSharedFreight(normalized, shareToken, {
      id: true,
    });
    return this.freightsService.getParticipantPositions(freight.id);
  }

  /** Get full freight data for PDF report (clean URL) */
  @Get(':code/report')
  async getReportDataByCode(@Param('code') code: string, @Query('s') shareToken?: string) {
    const normalized = this.validateCode(code);
    const freight = await this.findSharedFreight(normalized, shareToken, {
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
    });

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
    const isOwnFleet = !!(
      a &&
      freight.originCompany?.hasInternalFleet &&
      a.transportCompanyId === freight.originCompanyId
    );

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
      loadDate: freight.loadDate
        ? freight.loadDate.toISOString().split('T')[0]
        : null,
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
      documents: freight.documents.map((d) => ({
        name: d.name,
        type: d.type,
        step: d.step,
        createdAt: d.createdAt,
      })),
      auditLog: auditLog.map((log) => ({
        action: log.action,
        createdAt: log.createdAt,
        actorCompany: log.user?.company?.name || null,
      })),
    };
  }
}
