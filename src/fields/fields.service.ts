import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto } from './fields.dto';

@Injectable()
export class FieldsService {
  constructor(private prisma: PrismaService) {}

  private async resolveProducerCompanyId(user: any): Promise<string> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { companyId: true, companyByType: true },
    });
    if (!dbUser) throw new ForbiddenException('Usuario no encontrado');

    const cbt = (dbUser.companyByType as any) || {};
    if (cbt.producer) return cbt.producer;

    if (dbUser.companyId) {
      const company = await this.prisma.company.findUnique({
        where: { id: dbUser.companyId },
        select: { type: true },
      });
      if (company?.type === 'producer') return dbUser.companyId;
    }

    throw new ForbiddenException('No tenés empresa productora asociada');
  }

  async getFields(user: any) {
    const companyId = await this.resolveProducerCompanyId(user);
    return this.prisma.field.findMany({
      where: { companyId, active: true },
      include: {
        lots: {
          where: { active: true },
          select: { id: true, name: true, hectares: true, lat: true, lng: true },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
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
