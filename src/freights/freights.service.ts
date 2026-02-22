import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { NotificationService } from '../notifications/notification.service';
import { SseService } from '../sse/sse.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto, AssignMultiTruckDto, TruckAssignmentDto, RespondTripDto } from './freights.dto';
import { FreightStatus, AssignmentStatus, NotificationType } from '@prisma/client';

@Injectable()
export class FreightsService {
  private readonly logger = new Logger(FreightsService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
    private stateMachine: FreightStateMachine,
    private notifications: NotificationService,
    private sse: SseService,
  ) {}

  // Delegate to shared CompanyResolutionService
  private resolveProducerCompanyId(user: any) { return this.companyRes.resolveProducerCompanyId(user); }
  private resolveCompanyType(user: any) { return this.companyRes.resolveCompanyType(user); }
  private hasCompanyType(user: any, type: string) { return this.companyRes.hasCompanyType(user, type); }
  private resolveAllCompanyIds(user: any) { return this.companyRes.resolveAllCompanyIds(user); }

  // Helper: verify a chofer is the assigned driver for a freight
  private async assertDriverAccess(freightId: string, userId: string) {
    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { freightId, driverId: userId, status: { in: ['active', 'accepted'] } },
    });
    if (!assignment) throw new ForbiddenException('No sos el chofer asignado a este flete');
  }

  async create(dto: CreateFreightDto, user: any) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden crear fletes');

    if (!dto.destPlantId && !dto.customDestName) {
      throw new BadRequestException('Debe indicar planta destino o destino personalizado');
    }

    const producerCompanyId = await this.resolveProducerCompanyId(user);

    let lot: any = null;
    if (dto.originLotId) {
      lot = await this.prisma.lot.findFirst({
        where: { id: dto.originLotId, companyId: producerCompanyId, active: true },
        include: { field: true },
      });
      if (!lot) throw new BadRequestException('Lote no encontrado o no pertenece a tu empresa');
    } else if (!dto.overrideOriginLat || !dto.overrideOriginLng) {
      throw new BadRequestException('Debe indicar un lote de origen o una ubicación en el mapa');
    }

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
      if (plant) {
        destCompanyId = plant.companyId;
        destPlantId = plant.id;
        // If customDestName also provided (branch mode) → use branch info for display
        destName = dto.customDestName || plant.name;
        destLat = dto.customDestLat || dto.overrideDestLat || plant.lat;
        destLng = dto.customDestLng || dto.overrideDestLng || plant.lng;
      } else {
        // Fallback: destPlantId might be a Company ID (producers select companies as destinations)
        const company = await this.prisma.company.findFirst({
          where: { id: dto.destPlantId, type: 'plant', active: true },
        });
        if (!company) throw new BadRequestException('Planta no encontrada');
        destCompanyId = company.id;
        destPlantId = null;
        destName = dto.customDestName || company.name;
        destLat = dto.customDestLat || dto.overrideDestLat || company.lat;
        destLng = dto.customDestLng || dto.overrideDestLng || company.lng;
      }
    } else {
      destName = dto.customDestName!;
      destLat = dto.customDestLat || null;
      destLng = dto.customDestLng || null;
      // Allow explicit destCompanyId for custom dests linked to a company
      if (dto.destCompanyId) {
        const co = await this.prisma.company.findFirst({ where: { id: dto.destCompanyId, active: true } });
        if (co) destCompanyId = co.id;
      }
    }

    const fieldId = dto.fieldId || lot?.fieldId || null;

    let scheduledAt: Date | null = null;
    try {
      scheduledAt = new Date(`${dto.loadDate}T${dto.loadTime}:00`);
      if (isNaN(scheduledAt.getTime())) scheduledAt = null;
    } catch { scheduledAt = null; }

    const participants: { companyId: string }[] = [{ companyId: producerCompanyId }];
    if (destCompanyId) participants.push({ companyId: destCompanyId });

    const originName = lot ? lot.name : (dto.customOriginName || 'Origen personalizado');
    const originLat = dto.overrideOriginLat || lot?.lat || null;
    const originLng = dto.overrideOriginLng || lot?.lng || null;

    const freight = await this.prisma.$transaction(async (tx) => {
      // Generate code inside transaction (fixes race condition)
      const lastFreight = await tx.freight.findFirst({
        orderBy: { code: 'desc' },
        select: { code: true },
      });
      const lastNum = lastFreight?.code
        ? parseInt(lastFreight.code.replace('FLT-', ''), 10) || 0
        : 0;
      const code = `FLT-${String(lastNum + 1).padStart(4, '0')}`;

      const f = await tx.freight.create({
        data: {
          code,
          status: FreightStatus.pending_assignment,
          originCompanyId: producerCompanyId,
          originLotId: lot?.id || null,
          fieldId,
          originName,
          originLat,
          originLng,
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
          truckCount: dto.truckCount || 1,
          assignedTruckCount: 0,
          isMultiTruck: (dto.truckCount || 1) > 1,
          items: {
            create: dto.items.map((i) => ({
              grain: i.grain,
              tons: i.tons,
              notes: i.notes,
            })),
          },
          conversation: {
            create: {
              participants: { create: participants },
            },
          },
        } as any,
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
          include: { assignedUser: { select: { id: true, name: true } } },
        });
        if (truck) {
          const isMulti = (dto.truckCount || 1) > 1;
          await tx.freightAssignment.create({
            data: {
              freightId: f.id,
              transportCompanyId: producerCompanyId,
              status: AssignmentStatus.accepted,
              assignedById: user.sub,
              truckId: truck.id,
              plate: truck.plate,
              driverId: truck.assignedUserId || null,
              driverName: (truck as any).assignedUser?.name || null,
              ...(isMulti ? { tripNumber: 1, tripStatus: 'accepted' } : {}),
            },
          });
          await tx.freight.update({
            where: { id: f.id },
            data: { status: FreightStatus.assigned, assignedTruckCount: 1 } as any,
          });
        }
      }

      return f;
    });

    // Notify dest company about new freight
    if (destCompanyId) {
      const grain = dto.items?.[0]?.grain || 'producto';
      this.notifications.notifyCompany(
        destCompanyId, NotificationType.freight_created,
        'Nuevo flete solicitado',
        `${grain} desde ${lot?.name || originName}`,
        freight.id, user.sub,
      ).catch(() => {});
    }

    // SSE: notify all involved parties
    this.sse.broadcastFreightUpdate(freight.id, { id: freight.id, code: freight.code, status: freight.status }, user.sub).catch(() => {});

    return freight;
  }

  // ======================== LIST (multi-tenant) =======================

  async findAll(user: any, query: { status?: string; page?: number; limit?: number }) {
    const page = query.page || 1;
    const limit = Math.min(query.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};

    if (user.role !== 'platform_admin') {
      const allIds = await this.resolveAllCompanyIds(user);
      where.OR = [
        { originCompanyId: { in: allIds } },
        { destCompanyId: { in: allIds } },
        {
          assignments: {
            some: {
              transportCompanyId: { in: allIds },
              status: { in: ['active', 'accepted'] },
            },
          },
        },
        // Chofer: can also see freights assigned directly to them
        {
          assignments: {
            some: {
              driverId: user.sub,
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
          originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          requestedBy: { select: { id: true, name: true } },
          conversation: { select: { id: true } },
          assignments: {
            where: { status: { in: ['active', 'accepted'] } },
            orderBy: { createdAt: 'asc' },
            include: {
              transportCompany: { select: { id: true, name: true } },
              driver: { select: { id: true, name: true, phone: true } },
              truck: { select: { id: true, plate: true, model: true } },
            },
          },
          documents: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, url: true, type: true, step: true } },
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
        originCompany: { select: { id: true, name: true, type: true, hasInternalFleet: true, types: true } },
        destCompany: { select: { id: true, name: true, type: true, hasInternalFleet: true, types: true } },
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
        documents: { orderBy: { createdAt: 'desc' }, take: 20 },
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
    if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) {
      throw new ForbiddenException('Solo la planta puede asignar transportista');
    }

    this.stateMachine.validateTransition(freight.status, FreightStatus.assigned, 'plant');

    const transport = await this.prisma.company.findFirst({
      where: { id: dto.transportCompanyId, active: true },
      select: { id: true, type: true, types: true, hasInternalFleet: true },
    });
    if (!transport) throw new BadRequestException('Empresa transportista no encontrada');
    const tTypes = Array.isArray(transport.types) && (transport.types as string[]).length > 0
      ? (transport.types as string[]) : [transport.type];
    if (!tTypes.includes('transporter') && !transport.hasInternalFleet) throw new BadRequestException('La empresa no es transportista');

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await tx.freightAssignment.updateMany({
          where: { freightId, status: { in: ['active', 'accepted'] } },
          data: { status: AssignmentStatus.canceled, reason: 'Reasignado' },
        });

        const assignData: any = {
          freightId,
          transportCompanyId: dto.transportCompanyId,
          status: AssignmentStatus.active,
          assignedById: user.sub,
        };
        if (dto.truckId) {
          const truck = await tx.truck.findFirst({ where: { id: dto.truckId, companyId: dto.transportCompanyId, active: true } });
          if (truck) {
            assignData.truckId = truck.id;
            assignData.plate = truck.plate;
          }
        }
        if (dto.driverId) {
          const driverMembership = await tx.userCompany.findFirst({
            where: { userId: dto.driverId, companyId: dto.transportCompanyId, role: 'chofer', active: true },
            include: { user: { select: { id: true, name: true } } },
          });
          if (!driverMembership) throw new BadRequestException('Chofer no encontrado en la empresa');
          assignData.driverId = driverMembership.user.id;
          assignData.driverName = driverMembership.user.name;
          // Auto queue position: next in driver's queue
          const maxPos: any = await (tx.freightAssignment as any).aggregate({
            _max: { queuePosition: true },
            where: { driverId: dto.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
          });
          assignData.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
        }
        const assignment = await tx.freightAssignment.create({ data: assignData });

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
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assign() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new BadRequestException(`Error al asignar transportista: ${err.message}`);
    }

    // Notify transporter about assignment
    this.notifications.notifyCompany(
      dto.transportCompanyId, NotificationType.freight_assigned,
      'Te asignaron un flete',
      `${freight.code} → ${freight.destName || 'destino'}`,
      freightId, user.sub,
    ).catch(() => {});

    // Notify driver personally if assigned
    if (dto.driverId) {
      this.notifications.notify(
        dto.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${freight.code} → ${freight.destName || 'destino'}`,
        freightId,
      ).catch(() => {});
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'assigned' }, user.sub).catch(() => {});

    return result;
  }

  // ======================== RESPOND (accept/reject) ===================

  async respond(freightId: string, dto: RespondAssignmentDto, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: 'active' } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

    // Chofer can only respond to their own assigned freights
    if (user.role === 'chofer') {
      await this.assertDriverAccess(freightId, user.sub);
    } else {
      const isTransporter = await this.hasCompanyType(user, 'transporter');
      if (!isTransporter) {
        throw new ForbiddenException('Solo el transportista puede responder');
      }
    }

    const allIds = await this.resolveAllCompanyIds(user);
    const assignment = freight.assignments[0];
    if (!assignment || (!allIds.includes(assignment.transportCompanyId) && assignment.driverId !== user.sub)) {
      throw new ForbiddenException('Tu empresa no esta asignada a este flete');
    }

    if (dto.action === 'rejected') {
      if (!dto.reason || dto.reason.trim().length === 0) {
        throw new BadRequestException('Motivo obligatorio para rechazar');
      }

      const result = await this.prisma.$transaction(async (tx) => {
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

      // Notify origin company about rejection
      if (freight.originCompanyId) {
        this.notifications.notifyCompany(
          freight.originCompanyId, NotificationType.freight_rejected,
          'Flete rechazado',
          `${freight.code}: ${dto.reason}`,
          freightId, user.sub,
        ).catch(() => {});
      }

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'pending_assignment' }, user.sub).catch(() => {});

      return result;
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
      if (truck.assignedUserId && !dto.driverId) {
        assignmentUpdate.driverId = truck.assignedUserId;
      }
    }

    if (dto.driverId) {
      const driverMembership = await this.prisma.userCompany.findFirst({
        where: { userId: dto.driverId, companyId: user.companyId, role: 'chofer', active: true },
        include: { user: { select: { id: true, name: true } } },
      });
      if (!driverMembership) throw new BadRequestException('Chofer no encontrado en tu empresa');
      assignmentUpdate.driverId = driverMembership.user.id;
      assignmentUpdate.driverName = driverMembership.user.name;
      // Auto queue position: next in driver's queue
      const maxPos: any = await (this.prisma.freightAssignment as any).aggregate({
        _max: { queuePosition: true },
        where: { driverId: dto.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
      });
      assignmentUpdate.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
    }

    const acceptResult = await this.prisma.$transaction(async (tx) => {
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

    // Notify origin + dest companies about acceptance
    const notifyIds = [freight.originCompanyId, freight.destCompanyId].filter(Boolean) as string[];
    for (const cid of notifyIds) {
      this.notifications.notifyCompany(
        cid, NotificationType.freight_accepted,
        'Flete aceptado',
        `${freight.code} fue aceptado por el transportista`,
        freightId, user.sub,
      ).catch(() => {});
    }

    // Notify driver personally if assigned
    if (dto.driverId) {
      this.notifications.notify(
        dto.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${freight.code} → ${freight.destName || 'destino'}`,
        freightId,
      ).catch(() => {});
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'accepted' }, user.sub).catch(() => {});

    return acceptResult;
  }

  // ======================== START =====================================

  async start(freightId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

    const isOwnFleet = freight.assignments?.some(
      (a) => a.transportCompanyId === freight.originCompanyId,
    );
    const ct = await this.resolveCompanyType(user);
    const effectiveType = ct === 'producer' && isOwnFleet ? 'transporter' : ct;

    this.stateMachine.validateTransition(freight.status, FreightStatus.in_progress, effectiveType);

    const startResult = await this.prisma.$transaction(async (tx) => {
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

    // Notify origin + dest companies
    const startNotifyIds = [freight.originCompanyId, freight.destCompanyId].filter(Boolean) as string[];
    for (const cid of startNotifyIds) {
      this.notifications.notifyCompany(
        cid, NotificationType.freight_started,
        'Flete en camino',
        `${freight.code} inició el viaje`,
        freightId, user.sub,
      ).catch(() => {});
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'in_progress' }, user.sub).catch(() => {});

    return startResult;
  }

  // ======================== CONFIRM LOADED ============================

  async confirmLoaded(freightId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

    let ct = await this.resolveCompanyType(user);
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

      const loadedResult = await this.prisma.$transaction(async (tx) => {
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

      // Notify origin company (producer) to confirm load
      if (freight.originCompanyId) {
        this.notifications.notifyCompany(
          freight.originCompanyId, NotificationType.freight_loaded,
          'Carga confirmada',
          `${freight.code}: el transportista confirmó la carga`,
          freightId, user.sub,
        ).catch(() => {});
      }

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'loaded' }, user.sub).catch(() => {});

      return loadedResult;
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

      const prodLoadResult = await this.prisma.$transaction(async (tx) => {
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

      // Notify dest company
      if (freight.destCompanyId) {
        this.notifications.notifyCompany(
          freight.destCompanyId, NotificationType.freight_confirmed,
          'Carga confirmada',
          `${freight.code}: el productor confirmó la carga`,
          freightId, user.sub,
        ).catch(() => {});
      }

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'loaded' }, user.sub).catch(() => {});

      return prodLoadResult;
    }

    throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
  }

  // ======================== CONFIRM FINISHED ==========================

  async confirmFinished(freightId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

    if (freight.status !== FreightStatus.loaded) {
      throw new BadRequestException(
        `Solo se puede confirmar finalizacion en estado "loaded". Estado actual: "${freight.status}"`,
      );
    }

    const ct = await this.resolveCompanyType(user);

    if (ct === 'transporter') {
      if (freight.transporterFinishedConfirmedAt) {
        throw new BadRequestException('El transportista ya confirmo la entrega');
      }

      const plantAlsoConfirmed = !!freight.plantFinishedConfirmedAt;

      const tFinishResult = await this.prisma.$transaction(async (tx) => {
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

      // Notify dest company (plant)
      if (freight.destCompanyId) {
        const nType = plantAlsoConfirmed ? NotificationType.freight_finished : NotificationType.freight_confirmed;
        this.notifications.notifyCompany(
          freight.destCompanyId, nType,
          plantAlsoConfirmed ? 'Flete finalizado' : 'Entrega confirmada',
          `${freight.code}: el transportista confirmó la entrega`,
          freightId, user.sub,
        ).catch(() => {});
      }

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: plantAlsoConfirmed ? 'finished' : 'loaded' }, user.sub).catch(() => {});

      return tFinishResult;
    }

    if (ct === 'plant') {
      if (freight.plantFinishedConfirmedAt) {
        throw new BadRequestException('La planta ya confirmo la recepcion');
      }

      const transporterAlsoConfirmed = !!freight.transporterFinishedConfirmedAt;

      const pFinishResult = await this.prisma.$transaction(async (tx) => {
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

      // Notify origin company + transporter
      const finishNotifyIds = [freight.originCompanyId].filter(Boolean) as string[];
      // Also get transporter company from assignment
      const activeAssignment = await this.prisma.freightAssignment.findFirst({
        where: { freightId, status: { in: ['active', 'accepted'] } },
      });
      if (activeAssignment?.transportCompanyId) finishNotifyIds.push(activeAssignment.transportCompanyId);
      const nType = transporterAlsoConfirmed ? NotificationType.freight_finished : NotificationType.freight_confirmed;
      for (const cid of finishNotifyIds) {
        this.notifications.notifyCompany(
          cid, nType,
          transporterAlsoConfirmed ? 'Flete finalizado' : 'Recepción confirmada',
          `${freight.code}: la planta confirmó la recepción`,
          freightId, user.sub,
        ).catch(() => {});
      }

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: transporterAlsoConfirmed ? 'finished' : 'loaded' }, user.sub).catch(() => {});

      return pFinishResult;
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

    const finishCt = await this.resolveCompanyType(user);
    this.stateMachine.validateTransition(freight.status, FreightStatus.finished, finishCt);

    const finishResult = await this.prisma.$transaction(async (tx) => {
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

    // Notify all parties
    const fNotifyIds = [freight.originCompanyId, freight.destCompanyId].filter(Boolean) as string[];
    for (const cid of fNotifyIds) {
      this.notifications.notifyCompany(
        cid, NotificationType.freight_finished,
        'Flete finalizado',
        `${freight.code} fue marcado como finalizado`,
        freightId, user.sub,
      ).catch(() => {});
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'finished' }, user.sub).catch(() => {});

    return finishResult;
  }

  // ======================== CANCEL ====================================

  async cancel(freightId: string, dto: CancelFreightDto, user: any) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden cancelar fletes');

    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    if (freight.status === FreightStatus.in_progress || freight.status === FreightStatus.loaded) {
      throw new BadRequestException('No se puede cancelar un flete en curso o cargado');
    }

    const cancelCt = await this.resolveCompanyType(user);
    this.stateMachine.validateTransition(
      freight.status,
      FreightStatus.canceled,
      cancelCt,
      dto.reason,
    );

    const cancelResult = await this.prisma.$transaction(async (tx) => {
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

    // Notify all parties about cancellation
    const cancelNotifyIds = new Set<string>();
    if (freight.originCompanyId) cancelNotifyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) cancelNotifyIds.add(freight.destCompanyId);
    for (const a of (freight as any).assignments || []) {
      if (a.transportCompanyId) cancelNotifyIds.add(a.transportCompanyId);
    }
    for (const cid of cancelNotifyIds) {
      this.notifications.notifyCompany(
        cid, NotificationType.freight_canceled,
        'Flete cancelado',
        `${freight.code}: ${dto.reason}`,
        freightId, user.sub,
      ).catch(() => {});
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'canceled' }, user.sub).catch(() => {});

    return cancelResult;
  }

  // ======================== AUTHORIZE (plant approves own fleet) =======

  async authorize(freightId: string, user: any) {
    const isPlantAuth = await this.hasCompanyType(user, 'plant');
    if (!isPlantAuth) {
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
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden editar fletes');

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
        originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
        destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
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

  // ======================== AVAILABLE DRIVERS ===========================

  async getAvailableDrivers(companyId: string) {
    const memberships = await this.prisma.userCompany.findMany({
      where: { companyId, role: 'chofer', active: true },
      include: { user: { select: { id: true, name: true, phone: true, active: true } } },
    });

    const drivers = memberships.filter(m => m.user.active).map(m => m.user);

    // Get all active assignments for these drivers (queue support)
    // Cast to any: queuePosition field added to schema but Prisma client not regenerated locally
    const activeAssignments: any[] = await (this.prisma.freightAssignment as any).findMany({
      where: {
        driverId: { in: drivers.map(d => d.id) },
        status: { in: ['active', 'accepted'] },
        freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } },
      },
      select: { driverId: true, queuePosition: true, freight: { select: { id: true, code: true, status: true, destName: true } } },
      orderBy: { queuePosition: 'asc' },
    });

    const driverFreightsMap = new Map<string, any[]>();
    for (const a of activeAssignments) {
      if (!a.driverId) continue;
      if (!driverFreightsMap.has(a.driverId)) driverFreightsMap.set(a.driverId, []);
      driverFreightsMap.get(a.driverId)!.push({
        id: a.freight.id,
        code: a.freight.code,
        status: a.freight.status,
        destName: a.freight.destName,
        queuePosition: a.queuePosition,
      });
    }

    return drivers.map(d => {
      const af = driverFreightsMap.get(d.id) || [];
      return {
        id: d.id,
        name: d.name,
        phone: d.phone,
        busy: af.length > 0,
        currentFreightCode: af[0]?.code || null,
        activeFreights: af,
      };
    });
  }

  // ======================== DRIVER QUEUE ================================

  async getDriverQueue(driverId: string) {
    // Cast to any: queuePosition field added to schema but Prisma client not regenerated locally
    const assignments: any[] = await (this.prisma.freightAssignment as any).findMany({
      where: {
        driverId,
        status: { in: ['active', 'accepted'] },
        freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } },
      },
      include: {
        freight: {
          select: { id: true, code: true, status: true, destName: true, items: { select: { grain: true, tons: true }, take: 1 } },
        },
      },
      orderBy: { queuePosition: 'asc' },
    });

    return assignments.map((a: any) => ({
      freightId: a.freight.id,
      assignmentId: a.id,
      code: a.freight.code,
      status: a.freight.status,
      destName: a.freight.destName,
      grain: a.freight.items?.[0]?.grain || '',
      tons: a.freight.items?.[0]?.tons || 0,
      queuePosition: a.queuePosition,
    }));
  }

  async reorderDriverQueue(driverId: string, orderedFreightIds: string[], user: any) {
    // Only plant gerente can reorder
    const isPlant = await this.hasCompanyType(user, 'plant');
    const isAdmin = user.role === 'platform_admin';
    if (!isPlant && !isAdmin) throw new ForbiddenException('Solo la planta puede reordenar la cola');

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < orderedFreightIds.length; i++) {
        await (tx.freightAssignment as any).updateMany({
          where: {
            driverId,
            freightId: orderedFreightIds[i],
            status: { in: ['active', 'accepted'] },
          },
          data: { queuePosition: i + 1 },
        });
      }
    });

    return { ok: true };
  }

  // ======================== MULTI-TRUCK (v6.0) ==========================

  private async deriveFreightStatus(tx: any, freightId: string): Promise<FreightStatus> {
    const assignments = await (tx.freightAssignment as any).findMany({
      where: { freightId, status: { in: ['active', 'accepted'] } },
      select: { tripStatus: true },
    });
    if (assignments.length === 0) return FreightStatus.pending_assignment;
    const ss = assignments.map((a: any) => a.tripStatus);
    if (ss.every((s: string) => s === 'finished')) return FreightStatus.finished;
    if (ss.some((s: string) => s === 'loaded')) return FreightStatus.loaded;
    if (ss.some((s: string) => s === 'in_progress')) return FreightStatus.in_progress;
    if (ss.some((s: string) => s === 'accepted')) return FreightStatus.accepted;
    return FreightStatus.assigned;
  }

  async assignMulti(freightId: string, dto: AssignMultiTruckDto, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { conversation: { select: { id: true } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');

    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) throw new ForbiddenException('Solo la planta puede asignar transportistas');

    if (!['pending_assignment', 'assigned'].includes(freight.status)) {
      throw new BadRequestException('Solo se puede asignar en estado pending_assignment o assigned');
    }

    let result;
    try {
      result = await this.prisma.$transaction(async (tx) => {
        const existingCount = await tx.freightAssignment.count({
          where: { freightId, status: { in: ['active', 'accepted'] } },
        });
        let tripNumber = existingCount;

        for (const truck of dto.trucks) {
          const transport = await tx.company.findFirst({
            where: { id: truck.transportCompanyId, active: true },
            select: { id: true, type: true, types: true, hasInternalFleet: true },
          });
          if (!transport) throw new BadRequestException(`Empresa transportista ${truck.transportCompanyId} no encontrada`);
          const tTypes = Array.isArray(transport.types) && (transport.types as string[]).length > 0
            ? (transport.types as string[]) : [transport.type];
          if (!tTypes.includes('transporter') && !transport.hasInternalFleet) {
            throw new BadRequestException('La empresa no es transportista');
          }

          tripNumber++;
          const assignData: any = {
            freightId,
            transportCompanyId: truck.transportCompanyId,
            status: AssignmentStatus.active,
            assignedById: user.sub,
            tripNumber,
            tripStatus: 'pending',
          };

          if (truck.tons) assignData.tons = truck.tons;
          if (truck.truckId) {
            const t = await tx.truck.findFirst({ where: { id: truck.truckId, companyId: truck.transportCompanyId, active: true } });
            if (t) { assignData.truckId = t.id; assignData.plate = t.plate; }
          }

          if (truck.driverId) {
            const dm = await tx.userCompany.findFirst({
              where: { userId: truck.driverId, companyId: truck.transportCompanyId, role: 'chofer', active: true },
              include: { user: { select: { id: true, name: true } } },
            });
            if (!dm) throw new BadRequestException('Chofer no encontrado en la empresa');
            assignData.driverId = dm.user.id;
            assignData.driverName = dm.user.name;
            const maxPos: any = await (tx.freightAssignment as any).aggregate({
              _max: { queuePosition: true },
              where: { driverId: truck.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
            });
            assignData.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
          }

          await tx.freightAssignment.create({ data: assignData });

          if (freight.conversation?.id) {
            await tx.conversationParticipant.upsert({
              where: { conversationId_companyId: { conversationId: freight.conversation.id, companyId: truck.transportCompanyId } },
              create: { conversationId: freight.conversation.id, companyId: truck.transportCompanyId },
              update: {},
            });
          }
        }

        const newCount = existingCount + dto.trucks.length;
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: FreightStatus.assigned, assignedTruckCount: newCount, isMultiTruck: true } as any,
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'assigned_multi',
            fromValue: freight.status,
            toValue: 'assigned',
            userId: user.sub,
            metadata: { trucksAssigned: dto.trucks.length, totalAssigned: newCount },
          },
        });

        return updated;
      });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assignMulti() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new BadRequestException(`Error al asignar camiones: ${err.message}`);
    }

    const notifiedCompanies = new Set<string>();
    for (const truck of dto.trucks) {
      if (!notifiedCompanies.has(truck.transportCompanyId)) {
        notifiedCompanies.add(truck.transportCompanyId);
        this.notifications.notifyCompany(
          truck.transportCompanyId, NotificationType.freight_assigned,
          'Te asignaron camiones',
          `${freight.code} → ${(freight as any).destName || 'destino'}`,
          freightId, user.sub,
        ).catch(() => {});
      }
    }
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'assigned' }, user.sub).catch(() => {});
    return result;
  }

  async assignTruck(freightId: string, dto: TruckAssignmentDto, user: any) {
    return this.assignMulti(freightId, { trucks: [dto] }, user);
  }

  async cancelAssignment(freightId: string, assignmentId: string, reason: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint cancel');

    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) throw new ForbiddenException('Solo la planta puede cancelar asignaciones');

    const assignment = await this.prisma.freightAssignment.findFirst({
      where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
    });
    if (!assignment) throw new NotFoundException('Asignación no encontrada o ya cancelada');

    const result = await this.prisma.$transaction(async (tx) => {
      await (tx.freightAssignment as any).update({
        where: { id: assignmentId },
        data: { status: AssignmentStatus.canceled, reason: reason || 'Cancelado por planta', tripStatus: 'canceled' },
      });

      const newCount = Math.max(0, ((freight as any).assignedTruckCount || 1) - 1);
      const newStatus = await this.deriveFreightStatus(tx, freightId);
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: newStatus, assignedTruckCount: newCount } as any,
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'assignment_canceled',
          fromValue: freight.status,
          toValue: newStatus,
          userId: user.sub,
          metadata: { assignmentId, reason },
        },
      });

      return updated;
    });

    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
    return result;
  }

  async respondTrip(freightId: string, assignmentId: string, dto: RespondTripDto, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint respond');

    if (user.role === 'chofer') {
      const a = await this.prisma.freightAssignment.findFirst({
        where: { id: assignmentId, freightId, driverId: user.sub },
      });
      if (!a) throw new ForbiddenException('No sos el chofer asignado');
    } else {
      const isTransporter = await this.hasCompanyType(user, 'transporter');
      if (!isTransporter) throw new ForbiddenException('Solo el transportista puede responder');
    }

    const assignment: any = await (this.prisma.freightAssignment as any).findFirst({
      where: { id: assignmentId, freightId, status: 'active' },
    });
    if (!assignment) throw new NotFoundException('Asignación no encontrada o no activa');

    if (dto.action === 'rejected') {
      if (!dto.reason?.trim()) throw new BadRequestException('Motivo obligatorio para rechazar');

      const result = await this.prisma.$transaction(async (tx) => {
        await (tx.freightAssignment as any).update({
          where: { id: assignmentId },
          data: { status: AssignmentStatus.rejected, reason: dto.reason, tripStatus: 'canceled' },
        });

        const newCount = Math.max(0, ((freight as any).assignedTruckCount || 1) - 1);
        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: newStatus, assignedTruckCount: newCount } as any,
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'trip_rejected',
            fromValue: assignment.tripStatus,
            toValue: 'canceled',
            userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, reason: dto.reason },
          },
        });

        return updated;
      });

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
      return result;
    }

    // Accept
    this.stateMachine.validateTripTransition(assignment.tripStatus as any, 'accepted' as any);

    const acceptData: any = { status: AssignmentStatus.accepted, tripStatus: 'accepted' };

    if (dto.truckId) {
      const truck = await this.prisma.truck.findFirst({
        where: { id: dto.truckId, companyId: assignment.transportCompanyId, active: true },
      });
      if (!truck) throw new BadRequestException('Camión no encontrado');
      acceptData.truckId = truck.id;
      acceptData.plate = truck.plate;
      if (truck.assignedUserId && !dto.driverId) acceptData.driverId = truck.assignedUserId;
    }

    if (dto.driverId) {
      const dm = await this.prisma.userCompany.findFirst({
        where: { userId: dto.driverId, companyId: assignment.transportCompanyId, role: 'chofer', active: true },
        include: { user: { select: { id: true, name: true } } },
      });
      if (!dm) throw new BadRequestException('Chofer no encontrado');
      acceptData.driverId = dm.user.id;
      acceptData.driverName = dm.user.name;
      const maxPos: any = await (this.prisma.freightAssignment as any).aggregate({
        _max: { queuePosition: true },
        where: { driverId: dto.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
      });
      acceptData.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: acceptData });
      const newStatus = await this.deriveFreightStatus(tx, freightId);
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: newStatus },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'trip_accepted',
          fromValue: assignment.tripStatus,
          toValue: 'accepted',
          userId: user.sub,
          metadata: { assignmentId, tripNumber: assignment.tripNumber },
        },
      });

      return updated;
    });

    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
    return result;
  }

  async startTrip(freightId: string, assignmentId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint start');

    if (user.role === 'chofer') {
      const a = await this.prisma.freightAssignment.findFirst({
        where: { id: assignmentId, freightId, driverId: user.sub },
      });
      if (!a) throw new ForbiddenException('No sos el chofer asignado');
    }

    const assignment: any = await (this.prisma.freightAssignment as any).findFirst({
      where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
    });
    if (!assignment) throw new NotFoundException('Asignación no encontrada');

    this.stateMachine.validateTripTransition(assignment.tripStatus as any, 'in_progress' as any);

    const result = await this.prisma.$transaction(async (tx) => {
      await (tx.freightAssignment as any).update({
        where: { id: assignmentId },
        data: { tripStatus: 'in_progress', startedAt: new Date() },
      });

      const newStatus = await this.deriveFreightStatus(tx, freightId);
      const freightData: any = { status: newStatus };
      if (newStatus === FreightStatus.in_progress && !freight.startedAt) freightData.startedAt = new Date();
      const updated = await tx.freight.update({ where: { id: freightId }, data: freightData });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          action: 'trip_started',
          fromValue: assignment.tripStatus,
          toValue: 'in_progress',
          userId: user.sub,
          metadata: { assignmentId, tripNumber: assignment.tripNumber },
        },
      });

      return updated;
    });

    const notifyIds = [freight.originCompanyId, freight.destCompanyId].filter(Boolean) as string[];
    for (const cid of notifyIds) {
      this.notifications.notifyCompany(
        cid, NotificationType.freight_started,
        'Camión en camino',
        `${freight.code} — Camión #${assignment.tripNumber} inició viaje`,
        freightId, user.sub,
      ).catch(() => {});
    }
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
    return result;
  }

  async confirmTripLoaded(freightId: string, assignmentId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { id: assignmentId, status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint confirm-loaded');

    const assignment: any = freight.assignments[0];
    if (!assignment) throw new NotFoundException('Asignación no encontrada');

    if (user.role === 'chofer') {
      if (assignment.driverId !== user.sub) throw new ForbiddenException('No sos el chofer asignado');
    }

    let ct = await this.resolveCompanyType(user);
    const isOwnFleet = assignment.transportCompanyId === freight.originCompanyId;
    if (ct === 'producer' && isOwnFleet) ct = 'transporter';

    if (ct === 'transporter') {
      if (assignment.tripStatus !== 'in_progress' && assignment.tripStatus !== 'loaded') {
        throw new BadRequestException(`El camión debe estar en viaje para confirmar carga. Estado actual: ${assignment.tripStatus}`);
      }
      if (assignment.transporterLoadedConfirmedAt) throw new BadRequestException('El transportista ya confirmó la carga de este camión');

      const result = await this.prisma.$transaction(async (tx) => {
        const updateData: any = { transporterLoadedConfirmedAt: new Date() };
        if (assignment.tripStatus === 'in_progress') {
          updateData.tripStatus = 'loaded';
          updateData.loadedAt = new Date();
        }
        await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: updateData });

        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const freightData: any = { status: newStatus };
        if (newStatus === FreightStatus.loaded && !freight.loadedAt) freightData.loadedAt = new Date();
        const updated = await tx.freight.update({ where: { id: freightId }, data: freightData });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'trip_confirm_loaded',
            fromValue: assignment.tripStatus,
            toValue: 'loaded',
            userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'transporter' },
          },
        });

        return updated;
      });

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
      return result;
    }

    if (ct === 'producer') {
      if (assignment.tripStatus !== 'loaded') {
        throw new BadRequestException('El camión debe estar cargado para que el productor confirme');
      }
      if (assignment.producerLoadedConfirmedAt) throw new BadRequestException('El productor ya confirmó la carga');

      const result = await this.prisma.$transaction(async (tx) => {
        await (tx.freightAssignment as any).update({
          where: { id: assignmentId },
          data: { producerLoadedConfirmedAt: new Date() },
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'trip_confirm_loaded',
            fromValue: 'loaded',
            toValue: 'loaded',
            userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'producer' },
          },
        });

        return freight;
      });

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: freight.status }, user.sub).catch(() => {});
      return result;
    }

    throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
  }

  async confirmTripFinished(freightId: string, assignmentId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: { assignments: { where: { id: assignmentId, status: { in: ['active', 'accepted'] } } } },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint confirm-finished');

    const assignment: any = freight.assignments[0];
    if (!assignment) throw new NotFoundException('Asignación no encontrada');

    if (user.role === 'chofer') {
      if (assignment.driverId !== user.sub) throw new ForbiddenException('No sos el chofer asignado');
    }

    if (assignment.tripStatus !== 'loaded') {
      throw new BadRequestException(`Solo se puede finalizar un camión cargado. Estado actual: ${assignment.tripStatus}`);
    }

    const ct = await this.resolveCompanyType(user);

    if (ct === 'transporter') {
      if (assignment.transporterFinishedConfirmedAt) throw new BadRequestException('El transportista ya confirmó la entrega');
      const plantAlsoConfirmed = !!assignment.plantFinishedConfirmedAt;

      const result = await this.prisma.$transaction(async (tx) => {
        const updateData: any = { transporterFinishedConfirmedAt: new Date() };
        if (plantAlsoConfirmed) {
          updateData.tripStatus = 'finished';
          updateData.finishedAt = new Date();
        }
        await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: updateData });

        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const freightData: any = { status: newStatus };
        if (newStatus === FreightStatus.finished && !freight.finishedAt) freightData.finishedAt = new Date();
        const updated = await tx.freight.update({ where: { id: freightId }, data: freightData });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: plantAlsoConfirmed ? 'trip_finished' : 'trip_confirm_finished',
            fromValue: 'loaded',
            toValue: plantAlsoConfirmed ? 'finished' : 'loaded',
            userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'transporter', bothConfirmed: plantAlsoConfirmed },
          },
        });

        return updated;
      });

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
      return result;
    }

    if (ct === 'plant') {
      if (assignment.plantFinishedConfirmedAt) throw new BadRequestException('La planta ya confirmó la recepción');
      const transporterAlsoConfirmed = !!assignment.transporterFinishedConfirmedAt;

      const result = await this.prisma.$transaction(async (tx) => {
        const updateData: any = { plantFinishedConfirmedAt: new Date() };
        if (transporterAlsoConfirmed) {
          updateData.tripStatus = 'finished';
          updateData.finishedAt = new Date();
        }
        await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: updateData });

        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const freightData: any = { status: newStatus };
        if (newStatus === FreightStatus.finished && !freight.finishedAt) freightData.finishedAt = new Date();
        const updated = await tx.freight.update({ where: { id: freightId }, data: freightData });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: transporterAlsoConfirmed ? 'trip_finished' : 'trip_confirm_finished',
            fromValue: 'loaded',
            toValue: transporterAlsoConfirmed ? 'finished' : 'loaded',
            userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'plant', bothConfirmed: transporterAlsoConfirmed },
          },
        });

        return updated;
      });

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(() => {});
      return result;
    }

    throw new ForbiddenException('Solo transportista o planta pueden confirmar finalización');
  }

  // ======================== AUDIT LOG ==================================

  async getAuditLog(freightId: string) {
    return this.prisma.auditLog.findMany({
      where: { entityType: 'freight', entityId: freightId },
      orderBy: { createdAt: 'asc' },
      take: 200,
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
    // Fetch most recent 500 points (desc) then reverse for chronological order
    const points = await this.prisma.freightTracking.findMany({
      where: { freightId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
    return points.reverse();
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

  // ======================== DELETE DOCUMENT ==============================

  async deleteDocument(freightId: string, docId: string, user: any) {
    const freight = await this.prisma.freight.findUnique({ where: { id: freightId } });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    if (freight.status === 'finished') {
      throw new ForbiddenException('No se pueden eliminar archivos de un flete finalizado');
    }

    const doc = await this.prisma.freightDocument.findFirst({
      where: { id: docId, freightId },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    await this.prisma.freightDocument.delete({ where: { id: docId } });
    return { ok: true };
  }
}
