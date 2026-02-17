import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';

export const ROLES_KEY = 'roles';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Inject(PrismaService) private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) return true;

    const { user } = context.switchToHttp().getRequest();
    if (!user) throw new ForbiddenException('No autenticado');

    // Platform admin passes all checks
    if (user.role === 'platform_admin') return true;

    // Quick check: JWT companyType matches a required role (type-based: plant, producer, transporter)
    const hasType = requiredRoles.some(
      (role) => user.companyType === role,
    );
    if (hasType) return true;

    // Fallback: check all memberships from DB
    if (user.sub) {
      const memberships = await (this.prisma as any).userCompany.findMany({
        where: { userId: user.sub, active: true },
        include: { company: { select: { type: true } } },
      });
      const types = memberships.map((m: any) => m.company?.type).filter(Boolean);
      const hasDbType = requiredRoles.some((role) => types.includes(role));
      if (hasDbType) return true;
    }

    throw new ForbiddenException('Sin permisos para esta acción');
  }
}
