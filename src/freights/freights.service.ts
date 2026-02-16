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

  private async resolveProducerCompanyId(user: any): Promise<string> {
    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { companyId: true, companyByType: true },
    });
    const cbt = (dbUser?.companyByType as any) || {};
    if (cbt.producer) return cbt.producer;
    if (dbUser?.companyId) {
      const company = await this.prisma.company.findUnique({ where: { id: dbUser.companyId }, select: { type: true } });
      if (company?.type === 'producer') return dbUser.companyId;
    }
    return user.companyId;
  }

  async create(dto: CreateFreightDto, user: any) {
    if (!dto.destPlantId && !dto.customDestName) {
      throw new BadRequestException('Debe indicar planta destino o destino personalizado');
    }

    const producerCompanyId = await this.resolveProducerCompanyId(user);

    const lot = await this.prisma.lot.findFirst({
      where: { id: dto.originLotId, companyId: producerCompanyId, active: true },
      include: { field: true },
    });
    if (!lot) throw new BadRequestException('Lote no encontrado o no pertenece a tu empresa');

    let destCompanyId: string | null = null;
    let destPlantId: string | null = null;
    let destName: string;
    let destLat: any;
    let destLng: any;

    if (dto.destPlantId) {
      const plant = await this.prisma.plant.findFirst({
        where: { id: dto.destPlantId, active: true },
        include: { company: true },
      });
      if (!plant) throw new BadRequestException('Planta no encontrada');
      destCompanyId = plant.companyId;
      destPlantId = plant.id;
      destName = plant.name;
      destLat = dto.overrideDestLat || plant.lat;
      destLng = dto.overrideDestLng || plant.lng;
    } else {
      destName = dto.customDestName!;
      destLat = dto.customDestLat || null;
      destLng = dto.customDestLng || null;
    }

    const fieldId = dto.fieldId || lot.fieldId || null;

    let scheduledAt: Date | null = null;
    try {
      scheduledAt = new Date(`${dto.loadDate}T${dto.loadTime}:00`);
      if (isNaN(scheduledAt.getTime())) scheduledAt = null;
    } catch { scheduledAt = null; }

    const count = await this.prisma.freight.count();
    const code = `FLT-${String(count + 1).padStart(4, '0')}`;

    const participants: { companyId: string }[] = [{ companyId: producerCompanyId }];
    if (destCompanyId) participants.push({ companyId: destCompanyId });

    const freight = await this.prisma.$transaction(async (tx) => {
      const f = await tx.freight.create({
        data: {
          code,
          status: FreightStatus.pending_assignment,
          originCompanyId: producerCompanyId,
          originLotId: lot.id,
          fieldId,
          originName: lot.name,
          originLat: dto.overrideOriginLat || lot.lat,
          originLng: dto.overrideOriginLng || lot.lng,
          destCompanyId,
          destPlantId,
          destName,
          destLat,
          destLng,
          loadDate: new Date(dto.loadDate),
          loadTime: dto.loadTime,
          scheduledAt,
          requestedById: user.sub,
          notes: dto.notes,
          items: {
            create: dto.items.map((i) => ({
              grain: i.grain as any,
              tons: i.tons,
              notes: i.notes,
            })),
          },
          conversation: {
            create: {
              participants: { create: participants },
            },
          },
        },
        include: { items: true, conversation: { select: { id: true } } },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: f.id,
          action: 'created',
          toValue: 'pending_assignment',
          userId: user.sub,
        },
      });

      if (dto.truckId) {
        const truck = await tx.truck.findFirst({
          where: { id: dto.truckId, companyId: producerCompanyId, active: true },
        });
        if (truck) {
          await tx.freightAssignment.create({
            data: {
              freightId: f.id,
              transportCompanyId: producerCompanyId,
              status: AssignmentStatus.accepted,
              assignedById: user.sub,
              truckId: truck.id,
              plate: truck.plate,
              driverId: truck.assignedUserId || null,
            },
          });
          await tx.freight.update({
            where: { id: f.id },
            data: { status: FreightStatus.assigned },
          });
        }
      }

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

    if (user.role !== 'platform_admin') {
      where.OR = [
        { originCompanyId: user.companyId },
        { destCompanyId: user.companyId },
        {
          assignments: {
            some: {
              transportCompanyId: user.companyId,
              status: { in: ['active', 'accepted'] },
            },
          },
        },
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
          conversation: { select: { id: true } },
          assignments: {
            where: { status: { in: ['active', 'accepted'] } },
            include: {
              transportCompany: { select: { id: true, name: true } },
              driver: { select: { id: true, name: true, phone: true } },
              truck: { select: { id: true, plate: true, model: true } },
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
        field: { select: { id: true, name: true } },
        originCompany: { select: { id: true, name: true, type: true } },
        destCompany: { select: { id: true, name: true, type: true } },
        requestedBy: { select: { id: true, name: true } },
        assignments: {
          orderBy: { createdAt: 'desc' },
          include: {
            transportCompany: { select: { id: true, name: true, phone: true } },
            assignedBy: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true, phone: true } },
            truck: { select: { id: true, plate: true, model: true } },
          },
        },
        documents: { orderBy: { createdAt: 'desc' } },
        conversation: { select: { id: true } },
      },
    });

    if (!freight) throw new NotFoundException('Flete no encontrado');
    return freight;
  }

  // ======================== ASSIGN ===================================

  async assign(freightId: string, dto: AssignFreightDto, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { conversation: { select: { id: true } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo la planta puede asignar transportista');
    }

    this.stateMachine.validateTransition(freight.status, FreightStatus.assigned, 'plant');

    const transport = await this.prisma.company.findFirst({
      where: { id: dto.transportCompanyId, type: 'transporter', active: true },
    });
    if (!transport) throw new BadRequestException('Empresa transportista no encontrada');

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.freightAssignment.updateMany({
        where: { freightId, status: { in: ['active', 'accepted'] } },
        data: { status: AssignmentStatus.canceled, reason: 'Reasignado' },
      });

      const assignment = await tx.freightAssignment.create({
        data: {
          freightId,
          transportCompanyId: dto.transportCompanyId,
          status: AssignmentStatus.active,
          assignedById: user.sub,
        },
      });

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.assigned },
      });

      if (freight.conversation?.id) {
        await tx.conversationParticipant.upsert({
          where: {
            conversationId_companyId: {
              conversationId: freight.conversation.id,
              companyId: dto.transportCompanyId,
            },
          },
          create: {
            conversationId: freight.conversation.id,
            companyId: dto.transportCompanyId,
          },
          update: {},
        });
      }

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
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

    if (user.companyType !== 'transporter') {
      throw new ForbiddenException('Solo el transportista puede responder');
    }

    const assignment = freight.assignments[0];
    if (!assignment || assignment.transportCompanyId !== user.companyId) {
      throw new ForbiddenException('Tu empresa no esta asignada a este flete');
    }

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
            entityType: 'freight',
            entityId: freightId,
            action: 'rejected',
            fromValue: 'assigned',
            toValue: 'pending_assignment',
            userId: user.sub,
            reason: dto.reason,
          },
        });

        return updated;
      });
    }

    this.stateMachine.validateTransition(freight.status, FreightStatus.accepted, 'transporter');

    const assignmentUpdate: any = { status: AssignmentStatus.accepted };

    if (dto.truckId) {
      const truck = await this.prisma.truck.findFirst({
        where: { id: dto.truckId, companyId: user.companyId, active: true },
      });
      if (!truck) throw new BadRequestException('Camion no encontrado o no pertenece a tu empresa');

      assignmentUpdate.truckId = truck.id;
      assignmentUpdate.plate = truck.plate;
      if (truck.assignedUserId) {
        assignmentUpdate.driverId = truck.assignedUserId;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.freightAssignment.update({
        where: { id: assignment.id },
        data: assignmentUpdate,
      });

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.accepted },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'accepted',
          fromValue: 'assigned',
          toValue: 'accepted',
          userId: user.sub,
          metadata: dto.truckId ? { truckId: dto.truckId } : undefined,
        },
      });

      return updated;
    });
  }

  // ======================== START =====================================

  async start(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    const isOwnFleet = freight.assignments?.some(
      (a) => a.transportCompanyId === freight.originCompanyId,
    );
    const effectiveType =
      user.companyType === 'producer' && isOwnFleet ? 'transporter' : user.companyType;

    this.stateMachine.validateTransition(freight.status, FreightStatus.in_progress, effectiveType);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.in_progress, startedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'started',
          fromValue: 'accepted',
          toValue: 'in_progress',
          userId: user.sub,
        },
      });

      return updated;
    });
  }

  // ======================== CONFIRM LOADED ============================

  async confirmLoaded(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    let ct = user.companyType;
    const isOwnFleet = freight.assignments?.some(
      (a) => a.transportCompanyId === freight.originCompanyId,
    );
    if (ct === 'producer' && isOwnFleet && freight.status === FreightStatus.in_progress) {
      ct = 'transporter';
    }

    if (ct === 'transporter') {
      if (freight.status !== FreightStatus.in_progress) {
        throw new BadRequestException(
          `Solo se puede confirmar carga en estado "in_progress". Estado actual: "${freight.status}"`,
        );
      }
      if (freight.transporterLoadedConfirmedAt) {
        throw new BadRequestException('El transportista ya confirmo la carga');
      }

      this.stateMachine.validateTransition(freight.status, FreightStatus.loaded, 'transporter');

      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: {
            status: FreightStatus.loaded,
            loadedAt: new Date(),
            transporterLoadedConfirmedAt: new Date(),
          },
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'confirm_loaded',
            fromValue: 'in_progress',
            toValue: 'loaded',
            userId: user.sub,
            metadata: { confirmedBy: 'transporter' },
          },
        });

        return updated;
      });
    }

    if (ct === 'producer') {
      if (freight.status !== FreightStatus.loaded) {
        throw new BadRequestException(
          `El productor solo puede confirmar carga en estado "loaded". Estado actual: "${freight.status}"`,
        );
      }
      if (freight.producerLoadedConfirmedAt) {
        throw new BadRequestException('El productor ya confirmo la carga');
      }

      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { producerLoadedConfirmedAt: new Date() },
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'confirm_loaded',
            fromValue: 'loaded',
            toValue: 'loaded',
            userId: user.sub,
            metadata: { confirmedBy: 'producer' },
          },
        });

        return updated;
      });
    }

    throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
  }

  // ======================== CONFIRM FINISHED ==========================

  async confirmFinished(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    if (freight.status !== FreightStatus.loaded) {
      throw new BadRequestException(
        `Solo se puede confirmar finalizacion en estado "loaded". Estado actual: "${freight.status}"`,
      );
    }

    const ct = user.companyType;

    if (ct === 'transporter') {
      if (freight.transporterFinishedConfirmedAt) {
        throw new BadRequestException('El transportista ya confirmo la entrega');
      }

      const plantAlsoConfirmed = !!freight.plantFinishedConfirmedAt;

      return this.prisma.$transaction(async (tx) => {
        const data: any = { transporterFinishedConfirmedAt: new Date() };
        if (plantAlsoConfirmed) {
          this.stateMachine.validateTransition(freight.status, FreightStatus.finished, 'transporter');
          data.status = FreightStatus.finished;
          data.finishedAt = new Date();
        }

        const updated = await tx.freight.update({ where: { id: freightId }, data });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: plantAlsoConfirmed ? 'finished' : 'confirm_finished',
            fromValue: 'loaded',
            toValue: plantAlsoConfirmed ? 'finished' : 'loaded',
            userId: user.sub,
            metadata: { confirmedBy: 'transporter', bothConfirmed: plantAlsoConfirmed },
          },
        });

        return updated;
      });
    }

    if (ct === 'plant') {
      if (freight.plantFinishedConfirmedAt) {
        throw new BadRequestException('La planta ya confirmo la recepcion');
      }

      const transporterAlsoConfirmed = !!freight.transporterFinishedConfirmedAt;

      return this.prisma.$transaction(async (tx) => {
        const data: any = { plantFinishedConfirmedAt: new Date() };
        if (transporterAlsoConfirmed) {
          this.stateMachine.validateTransition(freight.status, FreightStatus.finished, 'plant');
          data.status = FreightStatus.finished;
          data.finishedAt = new Date();
        }

        const updated = await tx.freight.update({ where: { id: freightId }, data });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: transporterAlsoConfirmed ? 'finished' : 'confirm_finished',
            fromValue: 'loaded',
            toValue: transporterAlsoConfirmed ? 'finished' : 'loaded',
            userId: user.sub,
            metadata: { confirmedBy: 'plant', bothConfirmed: transporterAlsoConfirmed },
          },
        });

        return updated;
      });
    }

    throw new ForbiddenException('Solo transportista o planta pueden confirmar finalizacion');
  }

  // ======================== FINISH ====================================

  async finish(freightId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    if (freight.status === FreightStatus.in_progress) {
      throw new BadRequestException(
        'No se puede finalizar directamente. Primero debe confirmarse la carga (estado loaded).',
      );
    }

    this.stateMachine.validateTransition(freight.status, FreightStatus.finished, user.companyType);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.finished, finishedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'finished',
          fromValue: freight.status,
          toValue: 'finished',
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

    if (freight.status === FreightStatus.in_progress || freight.status === FreightStatus.loaded) {
      throw new BadRequestException('No se puede cancelar un flete en curso o cargado');
    }

    this.stateMachine.validateTransition(
      freight.status,
      FreightStatus.canceled,
      user.companyType,
      dto.reason,
    );

    return this.prisma.$transaction(async (tx) => {
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
          entityType: 'freight',
          entityId: freightId,
          action: 'canceled',
          fromValue: freight.status,
          toValue: 'canceled',
          userId: user.sub,
          reason: dto.reason,
        },
      });

      return updated;
    });
  }

  // ======================== AUTHORIZE (plant approves own fleet) =======

  async authorize(freightId: string, user: any) {
    if (user.companyType !== 'plant') {
      throw new ForbiddenException('Solo la planta puede autorizar');
    }

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (freight.status !== FreightStatus.assigned) {
      throw new BadRequestException('El flete no esta en estado asignado');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.accepted },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'authorized',
          fromValue: 'assigned',
          toValue: 'accepted',
          userId: user.sub,
        },
      });

      return updated;
    });
  }

  // ======================== UPDATE FREIGHT ==============================

  async updateFreight(
    freightId: string,
    dto: { loadDate?: string; loadTime?: string; notes?: string },
    user: any,
  ) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (freight.status !== FreightStatus.pending_assignment) {
      throw new BadRequestException('Solo se puede editar un flete pendiente de asignacion');
    }
    if (freight.requestedById !== user.sub) {
      throw new ForbiddenException('Solo el solicitante puede editar');
    }

    const data: any = {};
    if (dto.loadDate) {
      data.loadDate = new Date(dto.loadDate);
      data.scheduledAt = new Date(
        `${dto.loadDate}T${dto.loadTime || freight.loadTime || '08:00'}:00`,
      );
    }
    if (dto.loadTime !== undefined) data.loadTime = dto.loadTime;
    if (dto.notes !== undefined) data.notes = dto.notes;

    return this.prisma.freight.update({
      where: { id: freightId },
      data,
      include: {
        items: true,
        originLot: { select: { id: true, name: true } },
        destPlant: { select: { id: true, name: true } },
        originCompany: { select: { id: true, name: true } },
        destCompany: { select: { id: true, name: true } },
        requestedBy: { select: { id: true, name: true } },
        conversation: { select: { id: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true, phone: true } },
            truck: { select: { id: true, plate: true, model: true } },
          },
        },
      },
    });
  }

  // ======================== AUDIT LOG ==================================

  async getAuditLog(freightId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType: 'freight', entityId: freightId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        action: true,
        fromValue: true,
        toValue: true,
        reason: true,
        metadata: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            company: { select: { name: true, type: true } },
          },
        },
      },
    });
  }

  // ======================== TRACKING ===================================

  async addTrackingPoint(
    freightId: string,
    body: { lat: number; lng: number; speed?: number; heading?: number },
    user: any,
  ) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (freight.status !== FreightStatus.in_progress) {
      throw new BadRequestException('Solo se puede trackear un flete en curso');
    }

    return this.prisma.freightTracking.create({
      data: {
        freightId,
        lat: body.lat,
        lng: body.lng,
        speed: body.speed || null,
        heading: body.heading || null,
        userId: user.sub,
      },
    });
  }

  async getTrackingPoints(freightId: string) {
    return this.prisma.freightTracking.findMany({
      where: { freightId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
  }

  async getLastPosition(freightId: string) {
    return this.prisma.freightTracking.findFirst({
      where: { freightId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
  }

  // ======================== ADD DOCUMENT ================================

  async addDocument(
    freightId: string,
    body: { name: string; url: string; type?: string; step?: string },
    user: any,
  ) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    return this.prisma.freightDocument.create({
      data: {
        freightId,
        name: body.name || 'foto',
        url: body.url,
        type: body.type || 'photo',
        step: (body.step as any) || null,
        uploadedById: user.sub,
      },
    });
  }
}
