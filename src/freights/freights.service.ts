import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto } from './freights.dto';
import { FreightStatus, AssignmentStatus } from '@prisma/client';

@Injectable()
export class FreightsService {
  constructor(
    private prisma: PrismaService,
    private stateMachine: FreightStateMachine,
  ) {}

  // ======================== CREATE ====================================

  async create(dto: CreateFreightDto, user: any) {
    // Validate lot belongs to user's company
    const lot = await this.prisma.lot.findFirst({
      where: { id: dto.originLotId, companyId: user.companyId, active: true },
    });
    if (!lot) throw new BadRequestException('Lote no encontrado o no pertenece a tu empresa');

    // Validate plant exists
    const plant = await this.prisma.plant.findFirst({
      where: { id: dto.destPlantId, active: true },
      include: { company: true },
    });
    if (!plant) throw new BadRequestException('Planta no encontrada');

    // Generate code
    const count = await this.prisma.freight.count();
    const code = `FLT-${String(count + 1).padStart(4, '0')}`;

    const freight = await this.prisma.$transaction(async (tx) => {
      const f = await tx.freight.create({
        data: {
          code,
          status: FreightStatus.pending_assignment,
          originCompanyId: user.companyId,
          originLotId: lot.id,
          originName: lot.name,
          originLat: lot.lat,
          originLng: lot.lng,
          destCompanyId: plant.companyId,
          destPlantId: plant.id,
          destName: plant.name,
          destLat: plant.lat,
          destLng: plant.lng,
          loadDate: new Date(dto.loadDate),
          loadTime: dto.loadTime,
          requestedById: user.sub,
          notes: dto.notes,
          items: {
            create: dto.items.map(i => ({ grain: i.grain as any, tons: i.tons, notes: i.notes })),
          },
          conversation: { create: {} },
        },
        include: { items: true },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: f.id,
          action: 'created', toValue: 'pending_assignment',
          userId: user.sub,
        },
      });

      return f;
    });

    return freight;
  }

  // ======================== LIST (multi-tenant) =======================

  async findAll(user: any, query: { status?: string; page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};

    // Multi-tenant filter
    if (user.role !== 'platform_admin') {
      where.OR = [
        { originCompanyId: user.companyId },
        { destCompanyId: user.companyId },
        { assignments: { some: { transportCompanyId: user.companyId, status: { in: ['active', 'accepted'] } } } },
      ];
    }

    if (query.status) {
      where.status = query.status;
    }

    const [freights, total] = await Promise.all([
      this.prisma.freight.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          items: true,
          originLot: { select: { id: true, name: true } },
          destPlant: { select: { id: true, name: true } },
          originCompany: { select: { id: true, name: true } },
          destCompany: { select: { id: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          assignments: {
            where: { status: { in: ['active', 'accepted'] } },
            include: {
              transportCompany: { select: { id: true, name: true } },
              driver: { select: { id: true, name: true } },
            },
          },
        },
      }),
      this.prisma.freight.count({ where }),
    ]);

    return { data: freights, total, page, limit, pages: Math.ceil(total / limit) };
  }

  // ======================== FIND ONE =================================

  async findOne(id: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { id },
      include: {
        items: true,
        originLot: true,
        destPlant: true,
        originCompany: { select: { id: true, name: true, type: true } },
        destCompany: { select: { id: true, name: true, type: true } },
        requestedBy: { select: { id: true, name: true } },
        assignments: {
          orderBy: { createdAt: 'desc' },
          include: {
            transportCompany: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true } },
          },
        },
        documents: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!freight) throw new NotFoundException('Flete no encontrado');
    return freight;
  }

  // ======================== ASSIGN ===================================

  async assign(freightId: string, dto: AssignFreightDto, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    // Only plant can assign
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo la planta puede asignar transportista');
    }

    // Validate state
    this.stateMachine.validateTransition(freight.status, FreightStatus.assigned, 'plant');

    // Validate transport company exists and is transporter
    const transport = await this.prisma.company.findFirst({
      where: { id: dto.transportCompanyId, type: 'transporter', active: true },
    });
    if (!transport) throw new BadRequestException('Empresa transportista no encontrada');

    const result = await this.prisma.$transaction(async (tx) => {
      // Deactivate any previous active assignment
      await tx.freightAssignment.updateMany({
        where: { freightId, status: { in: ['active', 'accepted'] } },
        data: { status: AssignmentStatus.canceled, reason: 'Reasignado' },
      });

      // Create new assignment
      const assignment = await tx.freightAssignment.create({
        data: {
          freightId,
          transportCompanyId: dto.transportCompanyId,
          status: AssignmentStatus.active,
          assignedById: user.sub,
        },
      });

      // Update freight status
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.assigned },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: freightId,
          action: 'assigned',
          fromValue: freight.status,
          toValue: 'assigned',
          userId: user.sub,
          metadata: { transportCompanyId: dto.transportCompanyId, assignmentId: assignment.id },
        },
      });

      return updated;
    });

    return result;
  }

  // ======================== RESPOND (accept/reject) ===================

  async respond(freightId: string, dto: RespondAssignmentDto, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: 'active' } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    // Only assigned transporter can respond
    if (user.companyType !== 'transporter') {
      throw new ForbiddenException('Solo el transportista puede responder');
    }

    const assignment = freight.assignments[0];
    if (!assignment || assignment.transportCompanyId !== user.companyId) {
      throw new ForbiddenException('Tu empresa no está asignada a este flete');
    }

    // Validate reason if rejecting
    if (dto.action === 'rejected') {
      if (!dto.reason || dto.reason.trim().length === 0) {
        throw new BadRequestException('Motivo obligatorio para rechazar');
      }

      return this.prisma.$transaction(async (tx) => {
        await tx.freightAssignment.update({
          where: { id: assignment.id },
          data: { status: AssignmentStatus.rejected, reason: dto.reason },
        });

        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: FreightStatus.pending_assignment },
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight', entityId: freightId,
            action: 'rejected',
            fromValue: 'assigned', toValue: 'pending_assignment',
            userId: user.sub, reason: dto.reason,
          },
        });

        return updated;
      });
    }

    // Accept
    this.stateMachine.validateTransition(freight.status, FreightStatus.accepted, 'transporter');

    return this.prisma.$transaction(async (tx) => {
      await tx.freightAssignment.update({
        where: { id: assignment.id },
        data: { status: AssignmentStatus.accepted },
      });

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.accepted },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: freightId,
          action: 'accepted',
          fromValue: 'assigned', toValue: 'accepted',
          userId: user.sub,
        },
      });

      return updated;
    });
  }

  // ======================== START =====================================

  async start(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    this.stateMachine.validateTransition(freight.status, FreightStatus.in_progress, user.companyType);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.in_progress, startedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: freightId,
          action: 'started',
          fromValue: 'accepted', toValue: 'in_progress',
          userId: user.sub,
        },
      });

      return updated;
    });
  }

  // ======================== FINISH ====================================

  async finish(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    this.stateMachine.validateTransition(freight.status, FreightStatus.finished, user.companyType);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.finished, finishedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: freightId,
          action: 'finished',
          fromValue: 'in_progress', toValue: 'finished',
          userId: user.sub,
        },
      });

      return updated;
    });
  }

  // ======================== CANCEL ====================================

  async cancel(freightId: string, dto: CancelFreightDto, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    // Cannot cancel if in_progress
    if (freight.status === FreightStatus.in_progress) {
      throw new BadRequestException('No se puede cancelar un flete en curso');
    }

    this.stateMachine.validateTransition(freight.status, FreightStatus.canceled, user.companyType, dto.reason);

    return this.prisma.$transaction(async (tx) => {
      // Cancel active assignments too
      await tx.freightAssignment.updateMany({
        where: { freightId, status: { in: ['active', 'accepted'] } },
        data: { status: AssignmentStatus.canceled, reason: 'Flete cancelado' },
      });

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.canceled, cancelReason: dto.reason },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight', entityId: freightId,
          action: 'canceled',
          fromValue: freight.status, toValue: 'canceled',
          userId: user.sub, reason: dto.reason,
        },
      });

      return updated;
    });
  }
}
