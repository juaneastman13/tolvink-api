import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CompanyResolutionService } from '../../common/services/company-resolution.service';
import { AgentExecutionContext } from '../contracts/agent.types';
import { AgentMemoryService } from '../memory/agent-memory.service';

@Injectable()
export class LogisticsEntityReferenceService {
  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
    private memory: AgentMemoryService,
  ) {}

  async resolvePlant(context: AgentExecutionContext, ref?: string) {
    const value = (ref || '').trim();
    const state = (context.session?.flowState as any) || {};
    const ids = await this.getAccessiblePlantCompanyIds(context);

    if (!value || this.isContextual(value)) {
      if (state._lastPlantId) {
        const remembered = await this.prisma.company.findFirst({
          where: { id: state._lastPlantId, active: true, OR: [{ type: 'plant' }, { types: { array_contains: 'plant' as any } }] },
          select: { id: true, name: true },
        });
        if (remembered) return remembered;
      }
      throw new BadRequestException('Necesito que me digas la planta de destino.');
    }

    const matches = await this.prisma.company.findMany({
      where: {
        id: { in: ids },
        active: true,
        OR: [
          { name: { contains: value, mode: 'insensitive' } },
          { address: { contains: value, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true },
      take: 5,
      orderBy: { name: 'asc' },
    });

    const selected = this.pickSingle(value, matches, 'plantas');
    await this.memory.rememberEntities(context.session.id, { plant: selected });
    return selected;
  }

  async resolveField(context: AgentExecutionContext, ref?: string) {
    const value = (ref || '').trim();
    const state = (context.session?.flowState as any) || {};
    const companyIds = await this.getAccessibleFieldCompanyIds(context);

    if (!value || this.isContextual(value)) {
      if (state._lastFieldId) {
        const remembered = await this.prisma.field.findFirst({
          where: { id: state._lastFieldId, active: true },
          select: { id: true, name: true },
        });
        if (remembered) return remembered;
      }
      throw new BadRequestException('Necesito que me digas el campo.');
    }

    const matches = await this.prisma.field.findMany({
      where: {
        active: true,
        OR: [
          { companyId: { in: companyIds } },
          { ownerCompanyId: { in: companyIds } },
        ],
        name: { contains: value, mode: 'insensitive' },
      },
      select: { id: true, name: true, companyId: true },
      take: 5,
      orderBy: { name: 'asc' },
    });

    const selected = this.pickSingle(value, matches, 'campos');
    await this.memory.rememberEntities(context.session.id, { field: selected });
    return selected;
  }

  async resolveLot(context: AgentExecutionContext, ref?: string, fieldId?: string) {
    const value = (ref || '').trim();
    const state = (context.session?.flowState as any) || {};
    const companyIds = await this.getAccessibleFieldCompanyIds(context);

    if (!value || this.isContextual(value)) {
      if (state._lastLotId) {
        const remembered = await this.prisma.lot.findFirst({
          where: { id: state._lastLotId, active: true },
          select: { id: true, name: true, fieldId: true },
        });
        if (remembered) return remembered;
      }
      throw new BadRequestException('Necesito que me digas el lote.');
    }

    const matches = await this.prisma.lot.findMany({
      where: {
        active: true,
        companyId: { in: companyIds },
        ...(fieldId ? { fieldId } : {}),
        name: { contains: value, mode: 'insensitive' },
      },
      select: { id: true, name: true, fieldId: true },
      take: 5,
      orderBy: { name: 'asc' },
    });

    const selected = this.pickSingle(value, matches, 'lotes');
    await this.memory.rememberEntities(context.session.id, { lot: selected });
    return selected;
  }

  async resolveTruck(context: AgentExecutionContext, ref?: string) {
    const value = (ref || '').trim();
    const state = (context.session?.flowState as any) || {};
    const companyIds = await this.companyRes.resolveAllCompanyIds({
      ...context.user,
      companyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.companyId,
    });

    if (!value || this.isContextual(value)) {
      if (state._lastTruckId) {
        const remembered = await this.prisma.truck.findFirst({
          where: { id: state._lastTruckId, active: true },
          select: { id: true, plate: true },
        });
        if (remembered) return remembered;
      }
      throw new BadRequestException('Necesito que me digas el camión o la matrícula.');
    }

    const normalized = value.replace(/\s+/g, '').toUpperCase();
    const matches = await this.prisma.truck.findMany({
      where: {
        active: true,
        OR: [
          { companyId: { in: companyIds } },
          { ownerCompanyId: { in: companyIds } },
        ],
        plate: { contains: normalized, mode: 'insensitive' },
      },
      select: { id: true, plate: true },
      take: 5,
      orderBy: { plate: 'asc' },
    });

    const selected = this.pickSingle(normalized, matches, 'camiones');
    await this.memory.rememberEntities(context.session.id, { truck: selected });
    return selected;
  }

  async resolveDriver(context: AgentExecutionContext, ref?: string) {
    const value = (ref || '').trim();
    const state = (context.session?.flowState as any) || {};
    const companyIds = await this.companyRes.resolveAllCompanyIds({
      ...context.user,
      companyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.companyId,
    });

    if (!value || this.isContextual(value)) {
      if (state._lastDriverId) {
        const remembered = await this.prisma.user.findFirst({
          where: { id: state._lastDriverId, active: true },
          select: { id: true, name: true },
        });
        if (remembered) return remembered;
      }
      throw new BadRequestException('Necesito que me digas el chofer.');
    }

    const memberships = await this.prisma.userCompany.findMany({
      where: {
        companyId: { in: companyIds },
        role: 'chofer',
        active: true,
        user: {
          active: true,
          name: { contains: value, mode: 'insensitive' },
        },
      },
      include: {
        user: { select: { id: true, name: true } },
      },
      take: 5,
    });

    const matches = memberships.map((item) => item.user);
    const selected = this.pickSingle(value, matches, 'choferes');
    await this.memory.rememberEntities(context.session.id, { driver: selected });
    return selected;
  }

  async rememberResolved(context: AgentExecutionContext, entities: {
    plant?: { id: string; name?: string | null } | null;
    field?: { id: string; name?: string | null } | null;
    lot?: { id: string; name?: string | null } | null;
    truck?: { id: string; plate?: string | null } | null;
    driver?: { id: string; name?: string | null } | null;
  }) {
    if (!context.session?.id) return;
    await this.memory.rememberEntities(context.session.id, entities);
  }

  private async getAccessiblePlantCompanyIds(context: AgentExecutionContext): Promise<string[]> {
    const user = {
      ...context.user,
      companyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.companyId,
      activeCompanyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.activeCompanyId,
    };

    const isProducer = await this.companyRes.hasCompanyType(user, 'producer');
    const isPlant = await this.companyRes.hasCompanyType(user, 'plant');
    const ids = new Set<string>();

    if (isProducer) {
      const producerCompanyIds = await this.companyRes.resolveAllProducerCompanyIds(user);
      const accesses = await this.prisma.companyAccess.findMany({
        where: {
          granteeCompanyId: { in: producerCompanyIds },
          isActive: true,
          accessLevel: 'OPERATOR',
        },
        select: { grantorCompanyId: true },
      });
      accesses.forEach((item) => ids.add(item.grantorCompanyId));
    }

    if (isPlant) {
      const allIds = await this.companyRes.resolveAllCompanyIds(user);
      const companies = await this.prisma.company.findMany({
        where: { id: { in: allIds }, active: true, OR: [{ type: 'plant' }, { types: { array_contains: 'plant' as any } }] },
        select: { id: true },
      });
      companies.forEach((item) => ids.add(item.id));
    }

    return Array.from(ids);
  }

  private async getAccessibleFieldCompanyIds(context: AgentExecutionContext): Promise<string[]> {
    const user = {
      ...context.user,
      companyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.companyId,
      activeCompanyId: (context.session?.flowState as any)?.selectedCompanyId || context.user.activeCompanyId,
    };

    const ids = new Set<string>(await this.companyRes.resolveAllProducerCompanyIds(user));
    const isPlant = await this.companyRes.hasCompanyType(user, 'plant');
    const plantId = user.activeCompanyId || user.companyId;
    if (isPlant && plantId) {
      ids.add(plantId);
      const accesses = await this.prisma.companyAccess.findMany({
        where: { grantorCompanyId: plantId, isActive: true },
        select: { granteeCompanyId: true },
      });
      accesses.forEach((item) => ids.add(item.granteeCompanyId));
    }
    return Array.from(ids);
  }

  private pickSingle<T extends { id: string } & Record<string, any>>(ref: string, matches: T[], label: string): T {
    if (matches.length === 0) {
      throw new NotFoundException(`No encontré ${label} para "${ref}"`);
    }
    if (matches.length === 1) {
      return matches[0];
    }

    const exact = matches.find((item) => {
      const name = String(item.name || item.plate || '').toLowerCase();
      return name === ref.toLowerCase();
    });
    if (exact) return exact;

    const options = matches
      .slice(0, 3)
      .map((item) => item.name || item.plate || item.id)
      .join(', ');
    throw new BadRequestException(`Encontré varias coincidencias para "${ref}": ${options}`);
  }

  private isContextual(value: string) {
    return /^(ese|esa|este|esta|el ultimo|el último|ultimo|último|el de hoy|el mismo)$/i.test(value.trim());
  }
}
