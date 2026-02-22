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

    // Quick check: JWT companyType or companyTypes[] matches a required role
    const hasType = requiredRoles.some(
      (role) => user.companyType === role || (Array.isArray(user.companyTypes) && user.companyTypes.includes(role)),
    );
    if (hasType) return true;

    // Fallback: check all memberships from DB (both type and types[] for multi-type support)
    if (user.sub) {
      const memberships = await (this.prisma as any).userCompany.findMany({
        where: { userId: user.sub, active: true },
        include: { company: { select: { type: true, types: true } } },
      });
      const allTypes = new Set<string>();
      for (const m of memberships) {
        if (m.company?.type) allTypes.add(m.company.type);
        const arr = m.company?.types;
        if (Array.isArray(arr)) arr.forEach((t: string) => allTypes.add(t));
      }
      const hasDbType = requiredRoles.some((role) => allTypes.has(role));
      if (hasDbType) return true;
    }

    throw new ForbiddenException('Sin permisos para esta acción');
  }
}
