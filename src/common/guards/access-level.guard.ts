// =====================================================================
// AccessGuard — Checks CompanyAccess level between plant and user's company
// Usage: @AccessGuard({ minLevel: 'READONLY' }) or @AccessGuard({ minLevel: 'OPERATOR' })
// =====================================================================

import { Injectable, CanActivate, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';

export const ACCESS_LEVEL_KEY = 'accessLevel';

/**
 * Decorator: sets the minimum access level required for the endpoint.
 */
export function AccessGuard(opts: { minLevel: 'READONLY' | 'OPERATOR' }) {
  return SetMetadata(ACCESS_LEVEL_KEY, opts.minLevel);
}

const LEVEL_ORDER = { NONE: 0, READONLY: 1, OPERATOR: 2 };

@Injectable()
export class AccessLevelGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const minLevel = this.reflector.getAllAndOverride<string>(ACCESS_LEVEL_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @AccessGuard decorator → allow
    if (!minLevel) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('No autenticado');

    const activeCompanyId = user.activeCompanyId;
    if (!activeCompanyId) throw new ForbiddenException('Sin empresa activa');

    // Check if user's company IS the plant (grantor) — always allow
    // We need to find which plant context this request is about.
    // Strategy: check if there's a freight in the request, or use the company from param
    const freightId = req.params?.freightId || req.params?.id;
    let grantorId: string | null = null;

    if (freightId) {
      // Get freight's dest company (plant) as grantor
      const freight = await this.prisma.freight.findUnique({
        where: { id: freightId },
        select: { destCompanyId: true, originCompanyId: true },
      });
      if (freight?.destCompanyId) grantorId = freight.destCompanyId;
    }

    // If user IS the plant → always allow
    if (grantorId && grantorId === activeCompanyId) return true;

    // If no grantor context found, try to find any access link
    if (!grantorId) {
      // Check if user's company has any access received
      const anyAccess = await this.prisma.companyAccess.findFirst({
        where: { granteeCompanyId: activeCompanyId, isActive: true },
        select: { accessLevel: true },
      });
      if (!anyAccess) return true; // No access relationship = not plant-centric context, allow
      const userLevel = LEVEL_ORDER[anyAccess.accessLevel] ?? 0;
      const required = LEVEL_ORDER[minLevel] ?? 0;
      if (userLevel < required) throw new ForbiddenException('Nivel de acceso insuficiente (CONSULTA)');
      return true;
    }

    // Check CompanyAccess
    const access = await this.prisma.companyAccess.findUnique({
      where: {
        grantorCompanyId_granteeCompanyId: {
          grantorCompanyId: grantorId,
          granteeCompanyId: activeCompanyId,
        },
      },
      select: { accessLevel: true, isActive: true },
    });

    if (!access || !access.isActive) {
      // No relationship → let other guards handle (legacy flow)
      return true;
    }

    const userLevel = LEVEL_ORDER[access.accessLevel] ?? 0;
    const required = LEVEL_ORDER[minLevel] ?? 0;

    if (userLevel < required) {
      throw new ForbiddenException('Nivel de acceso insuficiente (CONSULTA)');
    }

    return true;
  }
}
