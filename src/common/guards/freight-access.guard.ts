// =====================================================================
// TOLVINK — Multi-Tenant Guard
// Validates that the user's company participates in the freight
// =====================================================================

import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class FreightAccessGuard implements CanActivate {
  constructor(private prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;
    const freightId = request.params.id;

    // Platform admin sees everything
    if (user.role === 'platform_admin') return true;

    // User must belong to a company
    if (!user.companyId) {
      throw new ForbiddenException('Usuario sin empresa asignada');
    }

    // Find freight and check company participation
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      select: {
        originCompanyId: true,
        destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { transportCompanyId: true },
        },
      },
    });

    if (!freight) {
      throw new ForbiddenException('Flete no encontrado');
    }

    const companyId = user.companyId;
    const isOrigin = freight.originCompanyId === companyId;
    const isDest = freight.destCompanyId === companyId;
    const isTransporter = freight.assignments.some(a => a.transportCompanyId === companyId);

    if (!isOrigin && !isDest && !isTransporter) {
      throw new ForbiddenException('Tu empresa no participa en este flete');
    }

    // Attach freight context to request for downstream use
    request.freightAccess = { isOrigin, isDest, isTransporter };

    return true;
  }
}
