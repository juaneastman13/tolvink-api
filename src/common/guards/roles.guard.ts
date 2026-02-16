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

    // Quick check: JWT role or companyType
    const hasRole = requiredRoles.some(
      (role) => user.role === role || user.companyType === role,
    );
    if (hasRole) return true;

    // Fallback: check userTypes from DB (multi-company users)
    if (user.sub) {
      const dbUser = await this.prisma.user.findUnique({
        where: { id: user.sub },
        select: { userTypes: true },
      });
      const types = (dbUser?.userTypes as string[]) || [];
      const hasType = requiredRoles.some((role) => types.includes(role));
      if (hasType) return true;
    }

    throw new ForbiddenException('Sin permisos para esta acción');
  }
}
