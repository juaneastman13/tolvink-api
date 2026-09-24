import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  mixin,
  Type,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Guard factory que valida que la empresa activa del usuario tiene habilitado
 * el módulo indicado y — para módulos que definen roles propios — que el rol
 * del usuario dentro de esa empresa (`UserCompany.role`) empieza con el
 * prefijo `<modulo>_` (p.ej. `agro_admin`, `agro_socio`, `agro_carga`).
 *
 * Uso:
 *   @UseGuards(JwtAuthGuard, ModuleAccessGuard('agro'))
 *
 * Un platform_admin pasa siempre.
 */
export function ModuleAccessGuard(moduleName: string): Type<CanActivate> {
  @Injectable()
  class MixinModuleAccessGuard implements CanActivate {
    constructor(readonly prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const req = context.switchToHttp().getRequest();
      const user = req.user;
      if (!user) throw new ForbiddenException('No autenticado');
      if (user.role === 'platform_admin') return true;

      const activeCompanyId: string | undefined =
        user.activeCompanyId || user.companyId;
      if (!activeCompanyId) {
        throw new ForbiddenException(
          `Sin empresa activa para el módulo ${moduleName}`,
        );
      }

      const [company, membership] = await Promise.all([
        this.prisma.company.findUnique({
          where: { id: activeCompanyId },
          select: { enabledModules: true },
        }),
        this.prisma.userCompany.findUnique({
          where: {
            userId_companyId: { userId: user.sub, companyId: activeCompanyId },
          },
          select: { role: true, active: true },
        }),
      ]);

      if (!company || !company.enabledModules?.includes(moduleName)) {
        throw new ForbiddenException(
          `El módulo "${moduleName}" no está habilitado para esta empresa`,
        );
      }
      if (!membership || !membership.active) {
        throw new ForbiddenException('No sos miembro activo de esta empresa');
      }

      // El rol dentro de la empresa debe pertenecer al dominio del módulo.
      const role = (membership.role || '').toLowerCase();
      if (!role.startsWith(`${moduleName}_`)) {
        throw new ForbiddenException(
          `Tu rol en la empresa no tiene acceso al módulo ${moduleName}`,
        );
      }

      // Enriquezco la request con los datos ya resueltos.
      req.user = {
        ...user,
        activeCompanyId,
        moduleRole: role, // ej. agro_admin
        module: moduleName,
      };
      return true;
    }
  }

  return mixin(MixinModuleAccessGuard);
}
