import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

/**
 * Resuelve la `AgroEmpresa` activa para un usuario dentro de su Company activa.
 *
 * Convención: el frontend envía la empresa agro elegida en el header
 * `x-agro-empresa-id` (o en un query `?empresaId=`) — se valida que la empresa
 * pertenezca a la Company activa del usuario.
 *
 * Si no se envía, y la Company tiene una sola AgroEmpresa activa, se usa esa.
 * Si tiene varias, se pide explícita.
 */
@Injectable()
export class AgroScopeService {
  constructor(private prisma: PrismaService) {}

  async resolveEmpresa(
    user: { sub: string; activeCompanyId?: string; companyId?: string },
    explicitEmpresaId?: string,
  ): Promise<{ empresaId: string; companyId: string }> {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) {
      throw new BadRequestException('Sin empresa activa');
    }

    if (explicitEmpresaId) {
      const emp = await this.prisma.agroEmpresa.findFirst({
        where: { id: explicitEmpresaId, companyId, active: true },
        select: { id: true },
      });
      if (!emp) {
        throw new NotFoundException(
          'La empresa agro no existe o no pertenece a tu Company',
        );
      }
      return { empresaId: emp.id, companyId };
    }

    const empresas = await this.prisma.agroEmpresa.findMany({
      where: { companyId, active: true },
      select: { id: true },
      take: 2,
    });
    if (empresas.length === 0) {
      throw new NotFoundException(
        'No hay empresas agro creadas para esta Company. Creá una primero.',
      );
    }
    if (empresas.length > 1) {
      throw new BadRequestException(
        'Hay varias empresas agro; indicá cuál con header x-agro-empresa-id',
      );
    }
    return { empresaId: empresas[0].id, companyId };
  }

  /**
   * Extrae el id explícito de una request. Header tiene precedencia sobre query.
   */
  extractExplicitId(req: any): string | undefined {
    const header = req.headers?.['x-agro-empresa-id'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    const q = req.query?.empresaId;
    if (typeof q === 'string' && q.trim()) return q.trim();
    return undefined;
  }
}
