// =====================================================================
// TOLVINK — Public Freight Tracking Controller
// Public endpoints (no JWT) for real-time freight tracking via share link
// =====================================================================

import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { PrismaService } from '../database/prisma.service';

@SkipThrottle()
@Controller('track')
export class FreightTrackingController {
  constructor(private prisma: PrismaService) {}

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
}
