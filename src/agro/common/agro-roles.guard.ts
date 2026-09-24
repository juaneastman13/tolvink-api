import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

export const AGRO_ROLES = ['agro_admin', 'agro_socio', 'agro_carga'] as const;
export type AgroRole = (typeof AGRO_ROLES)[number];

export const AGRO_ROLES_KEY = 'agroRoles';
export const AgroRoles = (...roles: AgroRole[]) =>
  SetMetadata(AGRO_ROLES_KEY, roles);

/**
 * Requiere que `user.moduleRole` (seteado por ModuleAccessGuard('agro'))
 * esté dentro de los roles agro permitidos por el handler.
 *
 * Uso:
 *   @UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'), AgroRolesGuard)
 *   @AgroRoles('agro_admin')
 *
 * Un platform_admin pasa siempre.
 * Si no hay @AgroRoles(...) declarado, deja pasar (basta con acceso al módulo).
 */
@Injectable()
export class AgroRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AgroRole[]>(
      AGRO_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('No autenticado');
    if (user.role === 'platform_admin') return true;

    const role: string | undefined = user.moduleRole;
    if (!role || !required.includes(role as AgroRole)) {
      throw new ForbiddenException(
        `Rol insuficiente. Requerido: ${required.join(' | ')}`,
      );
    }
    return true;
  }
}
