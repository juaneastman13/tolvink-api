import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CreateFieldDto, UpdateFieldDto, CreateLotDto, UpdateLotDto } from './fields.dto';

@Injectable()
export class FieldsService {
  constructor(private prisma: PrismaService) {}

  async getFields(user: any) {
    return this.prisma.field.findMany({
      where: { companyId: user.companyId, active: true },
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
    return this.prisma.field.create({
      data: {
        name: dto.name,
        companyId: user.companyId,
        address: dto.address || null,
        lat: dto.lat || null,
        lng: dto.lng || null,
      },
    });
  }

  async updateField(user: any, fieldId: string, dto: UpdateFieldDto) {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId, active: true },
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
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    return this.prisma.lot.findMany({
      where: { fieldId, active: true },
      select: { id: true, name: true, hectares: true, lat: true, lng: true },
      orderBy: { name: 'asc' },
    });
  }

  async createLot(user: any, fieldId: string, dto: CreateLotDto) {
    const field = await this.prisma.field.findFirst({
      where: { id: fieldId, companyId: user.companyId, active: true },
    });
    if (!field) throw new NotFoundException('Campo no encontrado');

    // Use field location as default if lot doesn't have its own
    const lat = dto.lat ?? field.lat;
    const lng = dto.lng ?? field.lng;

    return this.prisma.lot.create({
      data: {
        name: dto.name,
        companyId: user.companyId,
        fieldId: fieldId,
        hectares: dto.hectares || null,
        lat: lat || 0,
        lng: lng || 0,
      },
    });
  }

  async updateLot(user: any, fieldId: string, lotId: string, dto: UpdateLotDto) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, fieldId, companyId: user.companyId, active: true },
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
