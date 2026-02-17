import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto } from './fields.dto';

@Injectable()
export class FieldsService {
  constructor(private prisma: PrismaService) {}

  /** Resolve ALL producer company IDs the user belongs to */
  private async resolveAllProducerCompanyIds(user: any): Promise<string[]> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { companyId: true, companyByType: true, role: true },
    });
    if (!dbUser) throw new ForbiddenException('Usuario no encontrado');

    const ids = new Set<string>();
    const cbt = (dbUser.companyByType as any) || {};
    const isAdmin = dbUser.role === 'admin' || user.role === 'admin';

    // Add producer company from companyByType
    if (cbt.producer) ids.add(cbt.producer);

    // Add primary companyId — always for admin, only if producer type otherwise
    if (dbUser.companyId) {
      if (isAdmin) {
        ids.add(dbUser.companyId);
      } else {
        const company = await this.prisma.company.findUnique({
          where: { id: dbUser.companyId },
          select: { type: true },
        });
        if (company?.type === 'producer') ids.add(dbUser.companyId);
      }
    }

    // Also check all values in companyByType that are producer-type companies
    for (const compId of Object.values(cbt)) {
      if (compId && typeof compId === 'string' && !ids.has(compId)) {
        if (isAdmin) {
          ids.add(compId);
        } else {
          const co = await this.prisma.company.findUnique({
            where: { id: compId },
            select: { type: true },
          });
          if (co?.type === 'producer') ids.add(compId);
        }
      }
    }

    return Array.from(ids);
  }

  private async resolveProducerCompanyId(user: any): Promise<string> {
    const ids = await this.resolveAllProducerCompanyIds(user);
    if (ids.length === 0) throw new ForbiddenException('No tenés empresa productora asociada');
    return ids[0];
  }

  async getFields(user: any) {
    const companyIds = await this.resolveAllProducerCompanyIds(user);
    if (companyIds.length === 0) return [];
    return this.prisma.field.findMany({
      where: { companyId: { in: companyIds }, active: true },
      include: {
        company: { select: { id: true, name: true } },
        lots: {
          where: { active: true },
          select: { id: true, name: true, hectares: true, lat: true, lng: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: [{ companyId: 'asc' }, { name: 'asc' }],
    });
  }

  async createField(user: any, dto: CreateFieldDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    return this.prisma.field.create({
      data: {
        name: dto.name,
        companyId,
        address: dto.address || null,
        lat: dto.lat || null,
        lng: dto.lng || null,
      },
    });
  }

  async updateField(user: any, fieldId: string, dto: UpdateFieldDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    const data: any = {};
    if (dto.address !== undefined) data.address = dto.address;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.field.update({
      where: { id: fieldId },
      data,
    });
  }

  async getLots(user: any, fieldId: string) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.lot.findMany({
      where: { fieldId, active: true },
      select: { id: true, name: true, hectares: true, lat: true, lng: true },
      orderBy: { name: 'asc' },
    });
  }

  async createLot(user: any, fieldId: string, dto: CreateLotDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    const lat = dto.lat ?? field.lat;
    const lng = dto.lng ?? field.lng;

    return this.prisma.lot.create({
      data: {
        name: dto.name,
        companyId,
        fieldId: fieldId,
        hectares: dto.hectares || null,
        lat: lat || 0,
        lng: lng || 0,
      },
    });
  }

  async updateLot(user: any, fieldId: string, lotId: string, dto: UpdateLotDto) {
    const companyId = await this.resolveProducerCompanyId(user);
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, fieldId, companyId, active: true },
    });
    if (!lot) throw new NotFoundException('Lote no encontrado');

    const data: any = {};
    if (dto.hectares !== undefined) data.hectares = dto.hectares;
    if (dto.lat !== undefined) data.lat = dto.lat;
    if (dto.lng !== undefined) data.lng = dto.lng;

    return this.prisma.lot.update({
      where: { id: lotId },
      data,
    });
  }
}
