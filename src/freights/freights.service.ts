import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { NotificationService } from '../notifications/notification.service';
import { SseService } from '../sse/sse.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto, AssignMultiTruckDto, TruckAssignmentDto, RespondTripDto } from './freights.dto';
import { FreightStatus, AssignmentStatus, NotificationType, DocumentStep } from '@prisma/client';
import { randomInt } from 'crypto';

@Injectable()
export class FreightsService {
  private readonly logger = new Logger(FreightsService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
    private stateMachine: FreightStateMachine,
    private notifications: NotificationService,
    private sse: SseService,
    private config: ConfigService,
  ) {}

  /** Generate a unique freight code: F + year(2) + "-" + letters(3) + "." + digits(4) → e.g. F26-LCP.1822 */
  private generateFreightCode(): string {
    const year = String(new Date().getFullYear()).slice(-2);
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const letterPart = Array.from({ length: 3 }, () =>
      letters[randomInt(26)],
    ).join('');
    const numberPart = String(randomInt(10_000)).padStart(4, '0');
    return `F${year}-${letterPart}.${numberPart}`;
  }

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

  /**
   * Notify all freight participants (producer, plant, transporter(s)).
   * Deduplicates by companyId.
   * actionCompanyIds — companies that receive action buttons (Aceptar, Confirmar, etc.);
   * everyone else gets informational "Ver detalle" only.
   */
  private notifyAllParticipants(
    freight: { id: string; originCompanyId: string; destCompanyId?: string | null },
    assignments: Array<{ transportCompanyId: string }> | null,
    type: NotificationType,
    title: string,
    body: string,
    excludeUserId?: string,
    actionCompanyIds?: Set<string>,
  ) {
    const companyIds = new Set<string>();
    if (freight.originCompanyId) companyIds.add(freight.originCompanyId);
    if (freight.destCompanyId) companyIds.add(freight.destCompanyId);
    if (assignments) {
      for (const a of assignments) {
        if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
      }
    }
    for (const cid of companyIds) {
      const isAction = actionCompanyIds?.has(cid) ?? false;
      this.notifications.notifyCompany(cid, type, title, body, freight.id, excludeUserId, isAction)
        .catch(e => this.logger.error('Async side-effect failed', e.message));
    }
  }

  async create(dto: CreateFreightDto, user: any) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden crear fletes');

    if (!dto.destPlantId && !dto.customDestName) {
      throw new BadRequestException('Debe indicar planta destino o destino personalizado');
    }

    const producerCompanyId = await this.resolveProducerCompanyId(user);
    if (!producerCompanyId) throw new BadRequestException('No se encontró una empresa productora asociada a tu usuario');

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
        destLat = dto.customDestLat ?? dto.overrideDestLat ?? plant.lat;
        destLng = dto.customDestLng ?? dto.overrideDestLng ?? plant.lng;
      } else {
        // Fallback: destPlantId might be a Company ID (producers select companies as destinations)
        const company = await this.prisma.company.findFirst({
          where: { id: dto.destPlantId, type: 'plant', active: true },
        });
        if (!company) throw new BadRequestException('Planta no encontrada');
        destCompanyId = company.id;
        destPlantId = null;
        destName = dto.customDestName || company.name;
        destLat = dto.customDestLat ?? dto.overrideDestLat ?? company.lat;
        destLng = dto.customDestLng ?? dto.overrideDestLng ?? company.lng;
      }
    } else {
      destName = dto.customDestName!;
      destLat = dto.customDestLat ?? null;
      destLng = dto.customDestLng ?? null;
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
    // Use nullish coalescing — Prisma Decimal(0) is falsy with ||, so use ?? and skip 0
    const lotLat = lot?.lat != null && Number(lot.lat) !== 0 ? lot.lat : null;
    const lotLng = lot?.lng != null && Number(lot.lng) !== 0 ? lot.lng : null;
    const fieldLat = lot?.field?.lat != null && Number(lot.field.lat) !== 0 ? lot.field.lat : null;
    const fieldLng = lot?.field?.lng != null && Number(lot.field.lng) !== 0 ? lot.field.lng : null;
    const originLat = dto.overrideOriginLat ?? lotLat ?? fieldLat ?? null;
    const originLng = dto.overrideOriginLng ?? lotLng ?? fieldLng ?? null;

    // Determine useOwnFleet: explicit DTO value or infer from truckId + hasInternalFleet
    let useOwnFleet: boolean | null = null;
    const originCompany = await this.prisma.company.findUnique({
      where: { id: producerCompanyId },
      select: { hasInternalFleet: true },
    });
    if (dto.useOwnFleet != null) {
      // Only accept useOwnFleet=true if the company actually has internal fleet
      useOwnFleet = dto.useOwnFleet === true && !originCompany?.hasInternalFleet ? null : dto.useOwnFleet;
    } else if (originCompany?.hasInternalFleet) {
      useOwnFleet = !!dto.truckId;
    }

    const MAX_CODE_RETRIES = 3;
    let freight: any;
    for (let codeRetry = 0; codeRetry < MAX_CODE_RETRIES; codeRetry++) {
      try {
        freight = await this.prisma.$transaction(async (tx) => {
      // Generate unique random freight code (F + year + 3 letters + 4 digits)
      let code: string;
      let attempts = 0;
      do {
        code = this.generateFreightCode();
        const existing = await tx.freight.findUnique({ where: { code } });
        if (!existing) break;
        attempts++;
      } while (attempts < 10);
      if (attempts >= 10) {
        throw new InternalServerErrorException('No se pudo generar un código único de flete');
      }

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
          useOwnFleet,
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
          freightId: f.id,
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
              ...(isMulti ? { tripNumber: 1, tripStatus: 'pending' } : {}),
            },
          });
          // Multi-truck: stay at pending_assignment until all slots filled
          const newStatus = isMulti ? FreightStatus.pending_assignment : FreightStatus.assigned;
          await tx.freight.update({
            where: { id: f.id },
            data: { status: newStatus, assignedTruckCount: 1 } as any,
          });
        }
      }

      return f;
    });
        break; // success — exit retry loop
      } catch (err: any) {
        if (err?.code === 'P2002' && err?.meta?.target?.includes('code') && codeRetry < MAX_CODE_RETRIES - 1) {
          this.logger.warn(`Freight code collision (P2002), retry ${codeRetry + 1}/${MAX_CODE_RETRIES}`);
          continue;
        }
        throw err;
      }
    }

    // Notify all participants about new freight
    const grain = dto.items?.[0]?.grain || 'producto';
    this.notifyAllParticipants(
      freight, null, NotificationType.freight_created,
      'Nuevo flete solicitado',
      `${grain} desde ${lot?.name || originName}`,
      user.sub,
    );

    // SSE: notify all involved parties
    this.sse.broadcastFreightUpdate(freight.id, { id: freight.id, code: freight.code, status: freight.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return freight;
  }

  // ======================== LIST (multi-tenant) =======================

  async findAll(user: any, query: { status?: string; page?: number; limit?: number; company?: string; cursor?: string; dateFrom?: string; dateTo?: string; grain?: string }) {
    const limit = Math.min(query.limit || 20, 100);

    const where: any = {};

    if (user.role !== 'platform_admin') {
      const allIds = await this.resolveAllCompanyIds(user);
      const filterIds = query.company && allIds.includes(query.company)
        ? [query.company]
        : allIds;

      where.OR = [
        { originCompanyId: { in: filterIds } },
        { destCompanyId: { in: filterIds } },
        {
          assignments: {
            some: {
              transportCompanyId: { in: filterIds },
              status: { in: ['active', 'accepted'] },
            },
          },
        },
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
      if (!Object.values(FreightStatus).includes(query.status as FreightStatus)) {
        throw new BadRequestException(`Estado inválido: ${query.status}`);
      }
      where.status = query.status;
    }
    if (query.dateFrom || query.dateTo) {
      where.loadDate = {};
      if (query.dateFrom && !isNaN(new Date(query.dateFrom).getTime())) {
        where.loadDate.gte = new Date(query.dateFrom);
      }
      if (query.dateTo && !isNaN(new Date(query.dateTo + 'T23:59:59').getTime())) {
        where.loadDate.lte = new Date(query.dateTo + 'T23:59:59');
      }
      if (Object.keys(where.loadDate).length === 0) delete where.loadDate;
    }
    if (query.grain) {
      where.items = { some: { grain: { contains: query.grain, mode: 'insensitive' } } };
    }

    // Cursor-based pagination (preferred) or offset-based (legacy)
    const paginationArgs: any = { take: limit, orderBy: [{ destName: 'asc' }, { originName: 'asc' }, { createdAt: 'desc' }] };
    if (query.cursor) {
      paginationArgs.skip = 1; // skip the cursor item itself
      paginationArgs.cursor = { id: query.cursor };
    } else {
      const page = query.page || 1;
      paginationArgs.skip = (page - 1) * limit;
    }

    const [freights, total] = await Promise.all([
      this.prisma.freight.findMany({
        where,
        ...paginationArgs,
        include: {
          items: true,
          originLot: { select: { id: true, name: true } },
          field: { select: { id: true, name: true } },
          destPlant: { select: { id: true, name: true } },
          originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          requestedBy: { select: { id: true, name: true } },
          conversation: { select: { id: true } },
          assignments: {
            where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
            orderBy: { createdAt: 'asc' },
            include: {
              transportCompany: { select: { id: true, name: true } },
              driver: { select: { id: true, name: true, phone: true } },
              truck: { select: { id: true, plate: true, model: true } },
            },
          },
          documents: { orderBy: { createdAt: 'desc' }, take: 5, select: { id: true, name: true, url: true, type: true, step: true, ocrData: true } },
          pendingChanges: { where: { status: 'pending' }, select: { id: true, changeType: true, fromValue: true, toValue: true, requestedById: true, approverCompanyId: true, status: true, createdAt: true, requestedBy: { select: { name: true } } } },
        },
      }),
      this.prisma.freight.count({ where }),
    ]);

    const page = query.page || 1;
    const nextCursor = freights.length === limit ? freights[freights.length - 1]?.id : undefined;
    return { data: freights, total, page, limit, pages: Math.ceil(total / limit), nextCursor };
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
            transportCompany: { select: { id: true, name: true } },
            assignedBy: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true } },
            truck: { select: { id: true, plate: true, model: true } },
          },
        },
        documents: { orderBy: { createdAt: 'desc' }, take: 20 },
        conversation: { select: { id: true } },
        pendingChanges: { where: { status: 'pending' }, select: { id: true, changeType: true, fromValue: true, toValue: true, requestedById: true, approverCompanyId: true, status: true, createdAt: true, requestedBy: { select: { name: true } } } },
      },
    });

    if (!freight) throw new NotFoundException('Flete no encontrado');
    return freight;
  }

  // ======================== ASSIGN ===================================

  async assign(freightId: string, dto: AssignFreightDto, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) {
      throw new ForbiddenException('Solo la planta puede asignar transportista');
    }

    const allIds = await this.resolveAllCompanyIds(user);

    const transport = await this.prisma.company.findFirst({
      where: { id: dto.transportCompanyId, active: true },
      select: { id: true, type: true, types: true, hasInternalFleet: true },
    });
    if (!transport) throw new BadRequestException('Empresa transportista no encontrada');
    const tTypes = Array.isArray(transport.types) && (transport.types as string[]).length > 0
      ? (transport.types as string[]) : [transport.type];
    if (!tTypes.includes('transporter') && !transport.hasInternalFleet) throw new BadRequestException('La empresa no es transportista');

    let result: { updated: any; freight: any };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { conversation: { select: { id: true } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if (!freight.destCompanyId || !allIds.includes(freight.destCompanyId)) {
          throw new ForbiddenException('Solo la planta destino del flete puede asignar transportista');
        }
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

        this.stateMachine.validateTransition(freight.status, FreightStatus.assigned, 'plant');

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
            freightId: freightId,
            action: 'assigned',
            fromValue: freight.status,
            toValue: 'assigned',
            userId: user.sub,
            metadata: { transportCompanyId: dto.transportCompanyId, assignmentId: assignment.id },
          },
        });

        return { updated, freight };
      }, { timeout: 15000 });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assign() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new BadRequestException('Error al asignar transportista. Intente nuevamente.');
    }

    // Notify all participants about assignment (transporter gets Aceptar/Rechazar buttons)
    this.notifyAllParticipants(
      result.freight, [{ transportCompanyId: dto.transportCompanyId }],
      NotificationType.freight_assigned,
      'Transportista asignado',
      `${result.freight.code} → ${result.freight.destName || 'destino'}`,
      user.sub,
      new Set([dto.transportCompanyId]),
    );

    // Notify driver personally if assigned
    if (dto.driverId) {
      this.notifications.notify(
        dto.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${result.freight.code} → ${result.freight.destName || 'destino'}`,
        freightId,
      ).catch(e => this.logger.error('Async side-effect failed', e.message));
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: result.freight.code, status: 'assigned' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return result.updated;
  }

  // ======================== RESPOND (accept/reject) ===================

  async respond(freightId: string, dto: RespondAssignmentDto, user: any) {
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

    if (dto.action === 'rejected') {
      if (!dto.reason || dto.reason.trim().length === 0) {
        throw new BadRequestException('Motivo obligatorio para rechazar');
      }

      const result = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: 'active' } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

        const assignment = freight.assignments[0];
        if (!assignment || (!allIds.includes(assignment.transportCompanyId) && assignment.driverId !== user.sub)) {
          throw new ForbiddenException('Tu empresa no esta asignada a este flete');
        }

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
            freightId: freightId,
            action: 'rejected',
            fromValue: 'assigned',
            toValue: 'pending_assignment',
            userId: user.sub,
            reason: dto.reason,
          },
        });

        return { updated, freight };
      });

      // Notify all participants about rejection
      this.notifyAllParticipants(
        result.freight, null, NotificationType.freight_rejected,
        'Flete rechazado',
        `${result.freight.code}: ${dto.reason}`,
        user.sub,
      );

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: result.freight.code, status: 'pending_assignment' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

      return result.updated;
    }

    // Accept path — read freight INSIDE transaction to prevent TOCTOU race
    const acceptResult = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: 'active' } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

      const assignment = freight.assignments[0];
      if (!assignment || (!allIds.includes(assignment.transportCompanyId) && assignment.driverId !== user.sub)) {
        throw new ForbiddenException('Tu empresa no esta asignada a este flete');
      }

      this.stateMachine.validateTransition(freight.status, FreightStatus.accepted, 'transporter');

      const assignmentUpdate: any = { status: AssignmentStatus.accepted };

      if (dto.truckId) {
        if (!user.companyId) throw new BadRequestException('No se pudo determinar tu empresa');
        const truck = await tx.truck.findFirst({
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
        if (!user.companyId) throw new BadRequestException('No se pudo determinar tu empresa');
        const driverMembership = await tx.userCompany.findFirst({
          where: { userId: dto.driverId, companyId: user.companyId, role: 'chofer', active: true },
          include: { user: { select: { id: true, name: true } } },
        });
        if (!driverMembership) throw new BadRequestException('Chofer no encontrado en tu empresa');
        assignmentUpdate.driverId = driverMembership.user.id;
        assignmentUpdate.driverName = driverMembership.user.name;
        const maxPos: any = await (tx.freightAssignment as any).aggregate({
          _max: { queuePosition: true },
          where: { driverId: dto.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
        });
        assignmentUpdate.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
      }

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
          freightId: freightId,
          action: 'accepted',
          fromValue: freight.status,
          toValue: 'accepted',
          userId: user.sub,
          metadata: dto.truckId ? { truckId: dto.truckId } : undefined,
        },
      });

      return { updated, freight };
    });

    // Notify origin + dest companies about acceptance
    // Notify all participants about acceptance
    this.notifyAllParticipants(
      acceptResult.freight, (acceptResult.freight as any).assignments || [],
      NotificationType.freight_accepted,
      'Flete aceptado',
      `${acceptResult.freight.code} fue aceptado por el transportista`,
      user.sub,
    );

    // Notify driver personally if assigned
    if (dto.driverId) {
      this.notifications.notify(
        dto.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${acceptResult.freight.code} → ${acceptResult.freight.destName || 'destino'}`,
        freightId,
      ).catch(e => this.logger.error('Async side-effect failed', e.message));
    }

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: acceptResult.freight.code, status: 'accepted' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return acceptResult.updated;
  }

  // ======================== START =====================================

  async start(freightId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    // Verify caller's company is involved in this freight
    if (user.role !== 'chofer') {
      const allIds = await this.companyRes.resolveAllCompanyIds(user);
      const freight = await this.prisma.freight.findUnique({
        where: { id: freightId },
        select: { originCompanyId: true, destCompanyId: true,
          assignments: { select: { transportCompanyId: true } } },
      });
      if (freight) {
        const involved = [freight.originCompanyId, freight.destCompanyId,
          ...freight.assignments.map(a => a.transportCompanyId)].filter(Boolean);
        if (!allIds.some(id => involved.includes(id))) {
          throw new ForbiddenException('No tenés acceso a este flete');
        }
      }
    }

    const ct = await this.resolveCompanyType(user);

    const { updated: startResult, freight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

      const isOwnFleet = freight.assignments?.some(
        (a) => a.transportCompanyId === freight.originCompanyId,
      );
      const effectiveType = ct === 'producer' && isOwnFleet ? 'transporter' : ct;

      this.stateMachine.validateTransition(freight.status, FreightStatus.in_progress, effectiveType);

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.in_progress, startedAt: new Date() },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: 'started',
          fromValue: freight.status,
          toValue: 'in_progress',
          userId: user.sub,
        },
      });

      return { updated, freight };
    });

    // Notify origin + dest companies
    // Notify all participants about start
    this.notifyAllParticipants(
      freight, (freight as any).assignments || [],
      NotificationType.freight_started,
      'Flete en camino',
      `${freight.code} inició el viaje`,
      user.sub,
    );

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'in_progress' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return startResult;
  }

  // ======================== CONFIRM LOADED ============================

  async confirmLoaded(freightId: string, user: any, loadedTons?: number) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    let ct = await this.resolveCompanyType(user);

    if (ct === 'transporter' || ct === 'producer') {
      const loadedResult = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

        const isOwnFleet = freight.assignments?.some(
          (a) => a.transportCompanyId === freight.originCompanyId,
        );
        let effectiveCt = ct;
        if (ct === 'producer' && isOwnFleet && freight.status === FreightStatus.in_progress) {
          effectiveCt = 'transporter';
        }

        if (effectiveCt === 'transporter') {
          const callerClIds = await this.resolveAllCompanyIds(user);
          const hasActiveAssignment = freight.assignments?.some(a => callerClIds.includes(a.transportCompanyId));
          if (!hasActiveAssignment) {
            throw new ForbiddenException('No sos el transportista asignado a este flete');
          }

          if (freight.status !== FreightStatus.in_progress) {
            throw new BadRequestException(
              `Solo se puede confirmar carga en estado "in_progress". Estado actual: "${freight.status}"`,
            );
          }
          if (freight.transporterLoadedConfirmedAt) {
            throw new BadRequestException('El transportista ya confirmo la carga');
          }

          this.stateMachine.validateTransition(freight.status, FreightStatus.loaded, 'transporter');

          const updated = await tx.freight.update({
            where: { id: freightId },
            data: {
              status: FreightStatus.loaded,
              loadedAt: new Date(),
              transporterLoadedConfirmedAt: new Date(),
              ...(isOwnFleet ? { producerLoadedConfirmedAt: new Date() } : {}),
            },
          });

          if (loadedTons != null) {
            await tx.freightAssignment.updateMany({
              where: { freightId, status: { in: ['active', 'accepted'] } },
              data: { loadedTons },
            });
          }

          await tx.auditLog.create({
            data: {
              entityType: 'freight',
              entityId: freightId,
              action: 'confirm_loaded',
              fromValue: 'in_progress',
              toValue: 'loaded',
              userId: user.sub,
              metadata: { confirmedBy: 'transporter', ...(loadedTons != null ? { loadedTons } : {}) },
            },
          });

          return { updated, freight, path: 'transporter' as const };
        }

        // Producer path — verify caller is the origin company
        const callerProducerIds = await this.resolveAllCompanyIds(user);
        if (!callerProducerIds.includes(freight.originCompanyId)) {
          throw new ForbiddenException('Solo el productor de origen puede confirmar la carga');
        }
        if (freight.status !== FreightStatus.loaded) {
          throw new BadRequestException(
            `El productor solo puede confirmar carga en estado "loaded". Estado actual: "${freight.status}"`,
          );
        }
        if (freight.producerLoadedConfirmedAt) {
          throw new BadRequestException('El productor ya confirmo la carga');
        }

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

        return { updated, freight, path: 'producer' as const };
      });

      const loadedType = loadedResult.path === 'transporter' ? NotificationType.freight_loaded : NotificationType.freight_confirmed;
      const loadedBy = loadedResult.path === 'transporter' ? 'el transportista' : 'el productor';
      // When transporter confirms → producer gets "Confirmar carga" button
      const loadedActionIds = loadedResult.path === 'transporter' && loadedResult.freight.originCompanyId
        ? new Set([loadedResult.freight.originCompanyId])
        : undefined;
      this.notifyAllParticipants(
        loadedResult.freight, (loadedResult.freight as any).assignments || [],
        loadedType,
        'Carga confirmada',
        `${loadedResult.freight.code}: ${loadedBy} confirmó la carga`,
        user.sub,
        loadedActionIds,
      );

      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: loadedResult.freight.code, status: loadedResult.updated.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

      return loadedResult.updated;
    }

    throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
  }

  // ======================== CONFIRM FINISHED ==========================

  async confirmFinished(freightId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    const ct = await this.resolveCompanyType(user);

    if (ct === 'transporter') {
      const tFinishResult = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent race condition
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');
        if (freight.status !== FreightStatus.loaded) {
          throw new BadRequestException(`Solo se puede confirmar finalizacion en estado "loaded". Estado actual: "${freight.status}"`);
        }
        if (freight.transporterFinishedConfirmedAt) {
          throw new BadRequestException('El transportista ya confirmo la entrega');
        }

        const callerCfIds = await this.resolveAllCompanyIds(user);
        const hasAssignment = freight.assignments?.some(a => callerCfIds.includes(a.transportCompanyId));
        if (!hasAssignment) {
            throw new ForbiddenException('No sos el transportista asignado a este flete');
        }

        const plantAlsoConfirmed = !!freight.plantFinishedConfirmedAt;
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

        return { updated, freight, plantAlsoConfirmed };
      });

      // Notify all participants (plant gets "Confirmar entrega" if not both confirmed)
      const tFinishType = tFinishResult.plantAlsoConfirmed ? NotificationType.freight_finished : NotificationType.freight_confirmed;
      const tFinishActionIds = !tFinishResult.plantAlsoConfirmed && tFinishResult.freight.destCompanyId
        ? new Set([tFinishResult.freight.destCompanyId])
        : undefined;
      this.notifyAllParticipants(
        tFinishResult.freight, (tFinishResult.freight as any).assignments || [],
        tFinishType,
        tFinishResult.plantAlsoConfirmed ? 'Flete finalizado' : 'Entrega confirmada',
        `${tFinishResult.freight.code}: el transportista confirmó la entrega`,
        user.sub,
        tFinishActionIds,
      );

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: tFinishResult.freight.code, status: tFinishResult.plantAlsoConfirmed ? 'finished' : 'loaded' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

      return tFinishResult.updated;
    }

    if (ct === 'plant') {
      const pFinishResult = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent race condition
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');

        // Check destCompany inside transaction (was previously outside — TOCTOU fix)
        const allIdsPlant = await this.resolveAllCompanyIds(user);
        if (!freight.destCompanyId || !allIdsPlant.includes(freight.destCompanyId)) {
          throw new ForbiddenException('Solo la planta destino puede confirmar la recepción');
        }

        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');
        if (freight.status !== FreightStatus.loaded) {
          throw new BadRequestException(`Solo se puede confirmar finalizacion en estado "loaded". Estado actual: "${freight.status}"`);
        }
        if (freight.plantFinishedConfirmedAt) {
          throw new BadRequestException('La planta ya confirmo la recepcion');
        }

        const transporterAlsoConfirmed = !!freight.transporterFinishedConfirmedAt;
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

        return { updated, freight, transporterAlsoConfirmed };
      });

      // Notify all participants (transporter gets "Confirmar entrega" if not both confirmed)
      const pFinishType = pFinishResult.transporterAlsoConfirmed ? NotificationType.freight_finished : NotificationType.freight_confirmed;
      const pFinishActionIds = !pFinishResult.transporterAlsoConfirmed
        ? new Set<string>(((pFinishResult.freight as any).assignments || []).map((a: any) => a.transportCompanyId).filter(Boolean))
        : undefined;
      this.notifyAllParticipants(
        pFinishResult.freight, (pFinishResult.freight as any).assignments || [],
        pFinishType,
        pFinishResult.transporterAlsoConfirmed ? 'Flete finalizado' : 'Recepción confirmada',
        `${pFinishResult.freight.code}: la planta confirmó la recepción`,
        user.sub,
        pFinishActionIds,
      );

      // SSE
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: pFinishResult.freight.code, status: pFinishResult.transporterAlsoConfirmed ? 'finished' : 'loaded' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

      return pFinishResult.updated;
    }

    throw new ForbiddenException('Solo transportista o planta pueden confirmar finalizacion');
  }

  // ======================== CANCEL ====================================

  async cancel(freightId: string, dto: CancelFreightDto, user: any) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden cancelar fletes');

    const cancelCt = await this.resolveCompanyType(user);

    const callerIds = await this.resolveAllCompanyIds(user);

    const cancelResult = await this.prisma.$transaction(async (tx) => {
      // Read freight INSIDE transaction to prevent TOCTOU race
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      const isParticipant = callerIds.includes(freight.originCompanyId) || (freight.destCompanyId && callerIds.includes(freight.destCompanyId));
      if (!isParticipant) throw new ForbiddenException('Solo participantes del flete pueden cancelarlo');

      if (freight.status === FreightStatus.in_progress || freight.status === FreightStatus.loaded) {
        throw new BadRequestException('No se puede cancelar un flete en curso o cargado');
      }

      this.stateMachine.validateTransition(
        freight.status,
        FreightStatus.canceled,
        cancelCt,
        dto.reason,
      );

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
          freightId: freightId,
          action: 'canceled',
          fromValue: freight.status,
          toValue: 'canceled',
          userId: user.sub,
          reason: dto.reason,
        },
      });

      return { updated, freight };
    });

    // Notify all participants about cancellation
    this.notifyAllParticipants(
      cancelResult.freight, (cancelResult.freight as any).assignments || [],
      NotificationType.freight_canceled,
      'Flete cancelado',
      `${cancelResult.freight.code}: ${dto.reason}`,
      user.sub,
    );

    // SSE
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: cancelResult.freight.code, status: 'canceled' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return cancelResult.updated;
  }

  // ======================== AUTHORIZE (plant approves own fleet) =======

  async authorize(freightId: string, user: any) {
    const isPlantAuth = await this.hasCompanyType(user, 'plant');
    if (!isPlantAuth) {
      throw new ForbiddenException('Solo la planta puede autorizar');
    }

    const allIdsAuth = await this.resolveAllCompanyIds(user);

    const { updated, freight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: {
          assignments: {
            where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
            select: { transportCompanyId: true },
          },
        },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!freight.destCompanyId || !allIdsAuth.includes(freight.destCompanyId)) {
        throw new ForbiddenException('Solo la planta destino puede autorizar este flete');
      }
      if (freight.status !== FreightStatus.assigned) {
        throw new BadRequestException('El flete no esta en estado asignado');
      }

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: FreightStatus.accepted },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: 'authorized',
          fromValue: 'assigned',
          toValue: 'accepted',
          userId: user.sub,
        },
      });

      return { updated, freight };
    });

    // Notify all participants about authorization
    this.notifyAllParticipants(
      freight, freight.assignments,
      NotificationType.freight_accepted,
      `Flete ${freight.code} autorizado`,
      `El flete ha sido autorizado por la planta`,
      user.sub,
    );

    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: 'accepted' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));

    return updated;
  }

  // ======================== UPDATE FREIGHT ==============================

  private readonly FREIGHT_INCLUDE = {
    items: true,
    originLot: { select: { id: true, name: true } },
    destPlant: { select: { id: true, name: true } },
    originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
    destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
    requestedBy: { select: { id: true, name: true } },
    conversation: { select: { id: true } },
    assignments: {
      where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
      include: {
        transportCompany: { select: { id: true, name: true } },
        driver: { select: { id: true, name: true, phone: true } },
        truck: { select: { id: true, plate: true, model: true } },
      },
    },
    pendingChanges: {
      where: { status: 'pending' },
      select: { id: true, changeType: true, fromValue: true, toValue: true, requestedById: true, approverCompanyId: true, status: true, createdAt: true, requestedBy: { select: { name: true } } },
    },
  };

  async updateFreight(
    freightId: string,
    dto: { loadDate?: string; loadTime?: string; notes?: string; useOwnFleet?: boolean; destPlantId?: string; truckId?: string; driverId?: string; customDestName?: string; customDestLat?: number; customDestLng?: number },
    user: any,
  ) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden editar fletes');

    const allIds = await this.resolveAllCompanyIds(user);

    try {
    return await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (['finished', 'canceled'].includes(freight.status)) {
        throw new BadRequestException('No se puede editar un flete finalizado o cancelado');
      }
      if (freight.requestedById !== user.sub) {
        if (!allIds.includes(freight.originCompanyId) && (!freight.destCompanyId || !allIds.includes(freight.destCompanyId))) {
          throw new ForbiddenException('Solo el solicitante o su empresa pueden editar');
        }
      }

      const data: any = {};
      let pendingChangeCreated = false;

      // --- loadDate / loadTime / notes: only in pending_assignment ---
      if (dto.loadDate || dto.loadTime !== undefined || dto.notes !== undefined) {
        if (freight.status !== FreightStatus.pending_assignment) {
          if (dto.loadDate || dto.loadTime !== undefined || dto.notes !== undefined) {
            throw new BadRequestException('Fecha, hora y notas solo se pueden editar en estado pendiente de asignación');
          }
        }
        if (dto.loadDate) {
          const parsedLoadDate = new Date(dto.loadDate);
          if (isNaN(parsedLoadDate.getTime())) {
            throw new BadRequestException('Fecha de carga inválida');
          }
          data.loadDate = parsedLoadDate;
          data.scheduledAt = new Date(`${dto.loadDate}T${dto.loadTime || freight.loadTime || '08:00'}:00`);
        }
        if (dto.loadTime !== undefined) data.loadTime = dto.loadTime;
        if (dto.notes !== undefined) data.notes = dto.notes;
      }

      // --- useOwnFleet ---
      if (dto.useOwnFleet !== undefined && dto.useOwnFleet !== freight.useOwnFleet) {
        const hasActiveAssignments = freight.assignments.length > 0;
        if (!hasActiveAssignments) {
          data.useOwnFleet = dto.useOwnFleet;
        } else {
          // Invalidate existing pending changes of same type
          await tx.freightPendingChange.updateMany({
            where: { freightId, changeType: 'useOwnFleet', status: 'pending' },
            data: { status: 'rejected', resolvedAt: new Date() },
          });
          await tx.freightPendingChange.create({
            data: {
              freightId,
              changeType: 'useOwnFleet',
              fromValue: { useOwnFleet: freight.useOwnFleet },
              toValue: { useOwnFleet: dto.useOwnFleet },
              requestedById: user.sub,
              // Approver should be the OTHER party; if no dest company, auto-apply since no counter-party
              approverCompanyId: freight.destCompanyId || freight.originCompanyId,
            },
          });
          pendingChangeCreated = true;
          // Notify approver company
          const approverCompanyId = freight.destCompanyId || freight.originCompanyId;
          this.notifications.notifyCompany(
            approverCompanyId,
            NotificationType.freight_updated,
            'Cambio pendiente de aprobación',
            `Se solicitó cambiar flota propia en el flete ${freight.code}`,
            freight.id,
            user.sub,
          ).catch(e => this.logger.warn(`Notify error: ${e.message}`));
        }
      }

      // --- truckId (assign own fleet truck) ---
      const effectiveOwnFleet = data.useOwnFleet !== undefined ? data.useOwnFleet : freight.useOwnFleet;
      if (dto.truckId && effectiveOwnFleet) {
        const truck = await tx.truck.findFirst({
          where: { id: dto.truckId, companyId: freight.originCompanyId, active: true },
          include: { assignedUser: { select: { id: true, name: true, phone: true } } },
        });
        if (truck) {
          // Resolve driver: explicit driverId > truck's assignedUser > null
          let assignDriverId: string | null = null;
          let assignDriverName: string | null = null;
          if (dto.driverId) {
            // Validate driver belongs to the origin company (own fleet)
            const driverMembership = await tx.userCompany.findFirst({
              where: { userId: dto.driverId, companyId: freight.originCompanyId, active: true },
              include: { user: { select: { id: true, name: true } } },
            });
            if (driverMembership) { assignDriverId = driverMembership.user.id; assignDriverName = driverMembership.user.name; }
          } else if (truck.assignedUser) {
            assignDriverId = truck.assignedUser.id;
            assignDriverName = truck.assignedUser.name;
          }

          // Cancel any existing assignments
          if (freight.assignments.length > 0) {
            await tx.freightAssignment.updateMany({
              where: { freightId, status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
              data: { status: AssignmentStatus.canceled, reason: 'Cambio a flota propia' },
            });
          }
          // Create new assignment with own fleet truck
          await tx.freightAssignment.create({
            data: {
              freightId,
              transportCompanyId: freight.originCompanyId,
              status: AssignmentStatus.accepted,
              assignedById: user.sub,
              truckId: truck.id,
              plate: truck.plate,
              driverId: assignDriverId,
              driverName: assignDriverName,
            } as any,
          });
          data.status = FreightStatus.assigned;
          data.assignedTruckCount = 1;
        }
      }

      // --- destPlantId (may be a Plant ID or Company ID from catalog) ---
      if (dto.destPlantId && dto.destPlantId !== freight.destPlantId && dto.destPlantId !== freight.destCompanyId) {
        // Try Plant table first, then Company table (producers select companies as destinations)
        let resolvedDest: { plantId: string | null; companyId: string; name: string; lat: any; lng: any };
        const plant = await tx.plant.findFirst({
          where: { id: dto.destPlantId, active: true },
          include: { company: { select: { id: true, name: true } } },
        });
        if (plant) {
          resolvedDest = { plantId: plant.id, companyId: plant.companyId, name: plant.name, lat: plant.lat, lng: plant.lng };
        } else {
          const company = await tx.company.findFirst({
            where: { id: dto.destPlantId, active: true },
          });
          if (!company) throw new BadRequestException('Planta destino no encontrada');
          resolvedDest = { plantId: null, companyId: company.id, name: company.name, lat: company.lat, lng: company.lng };
        }

        const hasActiveAssignments = freight.assignments.length > 0;
        const isStarted = ['in_progress', 'loaded'].includes(freight.status);
        const needsApproval = hasActiveAssignments && !isStarted;

        // Branch overrides (customDest* from branch selection)
        const finalName = dto.customDestName || resolvedDest.name;
        const finalLat = dto.customDestLat ?? resolvedDest.lat;
        const finalLng = dto.customDestLng ?? resolvedDest.lng;

        if (!needsApproval) {
          // Direct update
          data.destPlantId = resolvedDest.plantId;
          data.destCompanyId = resolvedDest.companyId;
          data.destName = finalName;
          data.destLat = finalLat;
          data.destLng = finalLng;
        } else {
          // Determine approver: if user is origin → plant approves, if user is dest → producer approves
          const isOriginUser = allIds.includes(freight.originCompanyId);
          const approverCompanyId = isOriginUser
            ? (freight.destCompanyId || freight.originCompanyId)
            : freight.originCompanyId;

          // Invalidate existing pending changes of same type
          await tx.freightPendingChange.updateMany({
            where: { freightId, changeType: 'destPlant', status: 'pending' },
            data: { status: 'rejected', resolvedAt: new Date() },
          });
          await tx.freightPendingChange.create({
            data: {
              freightId,
              changeType: 'destPlant',
              fromValue: { destPlantId: freight.destPlantId, destCompanyId: freight.destCompanyId, destName: freight.destName },
              toValue: { destPlantId: resolvedDest.plantId, destCompanyId: resolvedDest.companyId, destName: finalName, destLat: finalLat ? Number(finalLat) : null, destLng: finalLng ? Number(finalLng) : null },
              requestedById: user.sub,
              approverCompanyId,
            },
          });
          pendingChangeCreated = true;
          this.notifications.notifyCompany(
            approverCompanyId,
            NotificationType.freight_updated,
            'Cambio pendiente de aprobación',
            `Se solicitó cambiar planta destino del flete ${freight.code} a ${finalName}`,
            freight.id,
            user.sub,
          ).catch(e => this.logger.warn(`Notify error: ${e.message}`));
        }
      }

      // Only update freight if there are direct changes
      if (Object.keys(data).length > 0) {
        const updated = await tx.freight.update({
          where: { id: freightId },
          data,
          include: this.FREIGHT_INCLUDE,
        });
        // Audit log
        await tx.auditLog.create({
          data: { entityType: 'freight', entityId: freightId, action: 'updated', userId: user.sub, freightId, metadata: data },
        }).catch(e => this.logger.warn('Audit log failed: ' + e.message));
        this.sse.broadcastFreightUpdate(freightId, { id: updated.id, code: updated.code, status: updated.status }).catch(() => {});
        return { ...updated, pendingChangeCreated };
      }

      // No direct changes but maybe a pending change was created
      const result = await tx.freight.findUnique({ where: { id: freightId }, include: this.FREIGHT_INCLUDE });
      return { ...result, pendingChangeCreated };
    }, { timeout: 15000 });
    } catch (err) {
      // Rethrow known HTTP exceptions
      if (err instanceof BadRequestException || err instanceof NotFoundException || err instanceof ForbiddenException) throw err;
      this.logger.error(`updateFreight FAILED freight=${freightId} dto=${JSON.stringify(dto)} error=${err.message}`, err.stack);
      throw new InternalServerErrorException('Error al actualizar el flete');
    }
  }

  // ======================== PENDING CHANGES ==============================

  async approvePendingChange(freightId: string, changeId: string, user: any) {
    const allIds = await this.resolveAllCompanyIds(user);

    return this.prisma.$transaction(async (tx) => {
      const change = await tx.freightPendingChange.findFirst({
        where: { id: changeId, freightId, status: 'pending' },
      });
      if (!change) throw new NotFoundException('Cambio pendiente no encontrado');
      if (!allIds.includes(change.approverCompanyId)) {
        throw new ForbiddenException('No tiene permisos para aprobar este cambio');
      }

      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');

      const toValue = change.toValue as any;
      const data: any = {};

      if (change.changeType === 'useOwnFleet') {
        data.useOwnFleet = toValue.useOwnFleet;
        // Cancel conflicting assignments
        if (freight.assignments.length > 0) {
          await tx.freightAssignment.updateMany({
            where: { freightId, status: { in: ['active', 'accepted'] } },
            data: { status: 'canceled' as any, reason: 'Cambio de flota aprobado' },
          });
          // Reset freight status to pending_assignment if it was assigned/accepted
          if (['assigned', 'accepted'].includes(freight.status)) {
            data.status = FreightStatus.pending_assignment;
            data.assignedTruckCount = 0;
          }
        }
      } else if (change.changeType === 'destPlant') {
        data.destPlantId = toValue.destPlantId;
        data.destCompanyId = toValue.destCompanyId;
        data.destName = toValue.destName;
        if (toValue.destLat != null) data.destLat = toValue.destLat;
        if (toValue.destLng != null) data.destLng = toValue.destLng;
      }

      // Apply changes
      const updated = await tx.freight.update({ where: { id: freightId }, data, include: this.FREIGHT_INCLUDE });

      // Mark change as approved
      await tx.freightPendingChange.update({
        where: { id: changeId },
        data: { status: 'approved', resolvedAt: new Date(), resolvedById: user.sub },
      });

      // Audit log
      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, action: 'change_approved', userId: user.sub, freightId, metadata: { changeType: change.changeType, toValue } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      // Notify all participants
      this.notifyAllParticipants(
        freight, freight.assignments || [],
        NotificationType.freight_updated,
        'Cambio aprobado',
        `El cambio de ${change.changeType === 'useOwnFleet' ? 'flota propia' : 'planta destino'} en el flete ${freight.code} fue aprobado`,
        user.sub,
      );

      this.sse.broadcastFreightUpdate(freightId, { id: updated.id, code: updated.code, status: updated.status }).catch(() => {});
      return updated;
    });
  }

  async rejectPendingChange(freightId: string, changeId: string, user: any, reason?: string) {
    const allIds = await this.resolveAllCompanyIds(user);

    return this.prisma.$transaction(async (tx) => {
      const change = await tx.freightPendingChange.findFirst({
        where: { id: changeId, freightId, status: 'pending' },
      });
      if (!change) throw new NotFoundException('Cambio pendiente no encontrado');
      if (!allIds.includes(change.approverCompanyId)) {
        throw new ForbiddenException('No tiene permisos para rechazar este cambio');
      }

      await tx.freightPendingChange.update({
        where: { id: changeId },
        data: { status: 'rejected', resolvedAt: new Date(), resolvedById: user.sub },
      });

      // Audit log
      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, action: 'change_rejected', userId: user.sub, freightId, metadata: { changeType: change.changeType, reason } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      const freight = await tx.freight.findUnique({ where: { id: freightId }, select: { code: true, originCompanyId: true, destCompanyId: true } });

      // Notify requester (use requestedById to find their company accurately)
      if (freight) {
        const requester = await tx.user.findUnique({ where: { id: change.requestedById }, select: { companyId: true, activeCompanyId: true } });
        const requesterCompanyId = requester?.activeCompanyId || requester?.companyId
          || (change.approverCompanyId === freight.originCompanyId ? freight.destCompanyId : freight.originCompanyId);
        if (!requesterCompanyId) return { ok: true };
        this.notifications.notifyCompany(
          requesterCompanyId,
          NotificationType.freight_updated,
          'Cambio rechazado',
          `El cambio de ${change.changeType === 'useOwnFleet' ? 'flota propia' : 'planta destino'} en el flete ${freight.code} fue rechazado${reason ? `: ${reason}` : ''}`,
          freightId,
          user.sub,
        ).catch(e => this.logger.warn(`Notify error: ${e.message}`));
      }

      return { ok: true };
    });
  }

  // ======================== AVAILABLE DRIVERS ===========================

  async getAvailableDrivers(companyId: string, user?: any) {
    // Validate caller has access to this company
    if (user) {
      const callerCompanies = await this.companyRes.resolveAllCompanyIds(user);
      if (!callerCompanies.includes(companyId)) {
        throw new ForbiddenException('No tiene acceso a los choferes de esta empresa');
      }
    }

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

  async getDriverQueue(driverId: string, user?: any) {
    // Validate caller has access to the driver's company
    if (user) {
      const driverMembership = await this.prisma.userCompany.findFirst({
        where: { userId: driverId, active: true },
        select: { companyId: true },
      });
      if (!driverMembership) {
        throw new NotFoundException('Chofer no encontrado');
      }
      const callerCompanies = await this.companyRes.resolveAllCompanyIds(user);
      if (!callerCompanies.includes(driverMembership.companyId)) {
        throw new ForbiddenException('No tiene acceso a la cola de este chofer');
      }
    }

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

    // Verify caller has a business relationship with this driver
    if (!isAdmin) {
      const callerIds = await this.resolveAllCompanyIds(user);
      const hasRelation = await this.prisma.freightAssignment.findFirst({
        where: {
          driverId,
          status: { in: ['active', 'accepted'] },
          freight: { OR: [{ originCompanyId: { in: callerIds } }, { destCompanyId: { in: callerIds } }] },
        },
        select: { id: true },
      });
      if (!hasRelation) throw new ForbiddenException('No tiene acceso a este chofer');
    }

    // Scope: only allow reordering freights where caller is origin or dest company
    const callerIds = isAdmin ? null : await this.resolveAllCompanyIds(user);

    await this.prisma.$transaction(async (tx) => {
      for (let i = 0; i < orderedFreightIds.length; i++) {
        const where: any = {
          driverId,
          freightId: orderedFreightIds[i],
          status: { in: ['active', 'accepted'] },
        };
        // Non-admin: only reorder freights belonging to caller's companies
        if (callerIds) {
          where.freight = { OR: [{ originCompanyId: { in: callerIds } }, { destCompanyId: { in: callerIds } }] };
        }
        await (tx.freightAssignment as any).updateMany({ where, data: { queuePosition: i + 1 } });
      }
    });

    return { ok: true };
  }

  // ======================== MULTI-TRUCK (v6.0) ==========================

  private async deriveFreightStatus(tx: any, freightId: string): Promise<FreightStatus> {
    const freight: any = await tx.freight.findUnique({ where: { id: freightId }, select: { truckCount: true, status: true, assignedTruckCount: true } });
    const truckCount = freight?.truckCount || 1;

    // Monotonic guard helper: never regress freight status below current
    // Exception: allow regression to pending_assignment when all assignments are removed
    const freightStatusOrder: Record<string, number> = {
      draft: 0, pending_assignment: 1, assigned: 2, accepted: 3,
      in_progress: 4, loaded: 5, finished: 6, canceled: 7,
    };
    const applyMonotonicGuard = (derived: FreightStatus, allowRegression = false): FreightStatus => {
      if (allowRegression) return derived;
      const currentRank = freightStatusOrder[freight.status] ?? 0;
      const derivedRank = freightStatusOrder[derived] ?? 0;
      return derivedRank >= currentRank ? derived : (freight.status as FreightStatus);
    };

    const assignments = await (tx.freightAssignment as any).findMany({
      where: { freightId, status: { in: ['active', 'accepted'] } },
      select: { tripStatus: true },
    });
    // When all assignments are removed, allow regression to pending_assignment
    if (assignments.length === 0) return applyMonotonicGuard(FreightStatus.pending_assignment, true);

    // If not all truck slots are filled, stay at pending_assignment (but respect monotonic guard)
    if (assignments.length < truckCount) return applyMonotonicGuard(FreightStatus.pending_assignment);

    // All slots filled — derive status from the MINIMUM tripStatus across all assignments
    // Status hierarchy: pending < accepted < in_progress < loaded < finished
    const statusOrder: Record<string, number> = { pending: 0, accepted: 1, in_progress: 2, loaded: 3, finished: 4 };
    const statusFromRank: Record<number, FreightStatus> = {
      0: FreightStatus.assigned,    // all assigned but pending acceptance
      1: FreightStatus.accepted,
      2: FreightStatus.in_progress,
      3: FreightStatus.loaded,
      4: FreightStatus.finished,
    };
    const minRank = Math.min(...assignments.map((a: any) => statusOrder[a.tripStatus] ?? 0));
    const derived = statusFromRank[minRank] ?? FreightStatus.assigned;

    return applyMonotonicGuard(derived);
  }

  async assignMulti(freightId: string, dto: AssignMultiTruckDto, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) throw new ForbiddenException('Solo la planta puede asignar transportistas');

    const allIdsAm = await this.resolveAllCompanyIds(user);

    let result: { updated: any; freight: any };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { conversation: { select: { id: true } }, items: { select: { tons: true } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if (!freight.destCompanyId || !allIdsAm.includes(freight.destCompanyId)) {
          throw new ForbiddenException('Solo la planta destino del flete puede asignar transportistas');
        }

        if (!['pending_assignment', 'assigned'].includes(freight.status)) {
          throw new BadRequestException('Solo se puede asignar en estado pending_assignment o assigned');
        }

        const existingAssignments = await (tx.freightAssignment as any).findMany({
          where: { freightId, status: { in: ['active', 'accepted'] } },
          select: { tons: true },
        });
        const existingCount = existingAssignments.length;

        // Validate truckCount limit
        if (freight.isMultiTruck && freight.truckCount && existingCount + dto.trucks.length > freight.truckCount) {
          throw new BadRequestException(
            `El flete permite ${freight.truckCount} camiones, ya tiene ${existingCount} asignados. Solo puede agregar ${freight.truckCount - existingCount} mas.`,
          );
        }

        // Validate total tonnage does not exceed freight total
        const freightTotalTons = (freight as any).items?.reduce((sum: number, i: any) => sum + (Number(i.tons) || 0), 0) || 0;
        if (freightTotalTons > 0) {
          const existingTons = existingAssignments.reduce((sum: number, a: any) => sum + (Number(a.tons) || 0), 0);
          const newTons = dto.trucks.reduce((sum: number, t: any) => sum + (Number(t.tons) || 0), 0);
          if (newTons > 0 && existingTons + newTons > freightTotalTons) {
            throw new BadRequestException(
              `El tonelaje total asignado (${existingTons + newTons}) excede el total del flete (${freightTotalTons}).`,
            );
          }
        }

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
        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: newStatus, assignedTruckCount: newCount, isMultiTruck: true } as any,
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'assigned_multi',
            fromValue: freight.status,
            toValue: newStatus,
            userId: user.sub,
            metadata: { trucksAssigned: dto.trucks.length, totalAssigned: newCount },
          },
        });

        return { updated, freight };
      }, { timeout: 15000 });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assignMulti() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new BadRequestException('Error al asignar camiones. Intente nuevamente.');
    }

    // Notify all participants about multi-truck assignment (transporters get Aceptar/Rechazar)
    const assignmentsList = dto.trucks.map(t => ({ transportCompanyId: t.transportCompanyId }));
    const multiActionIds = new Set(dto.trucks.map(t => t.transportCompanyId));
    this.notifyAllParticipants(
      result.freight, assignmentsList,
      NotificationType.freight_assigned,
      'Camiones asignados',
      `${result.freight.code} → ${result.freight.destName || 'destino'}`,
      user.sub,
      multiActionIds,
    );
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: result.freight.code, status: 'assigned' }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return result.updated;
  }

  async assignTruck(freightId: string, dto: TruckAssignmentDto, user: any) {
    return this.assignMulti(freightId, { trucks: [dto] }, user);
  }

  async cancelAssignment(freightId: string, assignmentId: string, reason: string, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) throw new ForbiddenException('Solo la planta puede cancelar asignaciones');

    const allIdsCa = await this.resolveAllCompanyIds(user);

    const { result, freight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!freight.destCompanyId || !allIdsCa.includes(freight.destCompanyId)) {
        throw new ForbiddenException('Solo la planta destino puede cancelar asignaciones');
      }
      if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint cancel');

      const assignment = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada o ya cancelada');

      await (tx.freightAssignment as any).update({
        where: { id: assignmentId },
        data: { status: AssignmentStatus.canceled, reason: reason || 'Cancelado por planta', tripStatus: 'canceled' },
      });

      // Compute actual count from DB to avoid race conditions
      const activeCount = await (tx.freightAssignment as any).count({
        where: { freightId, status: { in: ['active', 'accepted'] } },
      });
      const newStatus = await this.deriveFreightStatus(tx, freightId);
      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: newStatus, assignedTruckCount: activeCount } as any,
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: 'assignment_canceled',
          fromValue: freight.status,
          toValue: newStatus,
          userId: user.sub,
          metadata: { assignmentId, reason },
        },
      });

      return { result: updated, freight };
    });

    // Notify transporter about canceled assignment
    if (freight.destCompanyId) {
      const canceledAssignment = await this.prisma.freightAssignment.findUnique({ where: { id: assignmentId }, select: { transportCompanyId: true } });
      if (canceledAssignment) {
        this.notifications.notifyCompany(
          canceledAssignment.transportCompanyId,
          NotificationType.freight_canceled,
          'Asignación cancelada',
          `${freight.code}: ${reason || 'Cancelado por planta'}`,
          freightId,
          user.sub,
        ).catch(e => this.logger.error('Async side-effect failed', e.message));
      }
    }

    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return result;
  }

  async updateAssignment(freightId: string, assignmentId: string, dto: any, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    if (!isPlant) throw new ForbiddenException('Solo la planta puede editar asignaciones');

    const allIdsUa = await this.resolveAllCompanyIds(user);

    const { updated, freight: freshFreight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!freight.destCompanyId || !allIdsUa.includes(freight.destCompanyId)) {
        throw new ForbiddenException('Solo la planta destino puede editar asignaciones');
      }

      const assignment: any = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada');

      if (assignment.tripStatus && !['pending', 'accepted'].includes(assignment.tripStatus)) {
        throw new BadRequestException('Solo se pueden editar viajes que no hayan iniciado');
      }

      const updateData: any = {};

      if (dto.transportCompanyId && dto.transportCompanyId !== assignment.transportCompanyId) {
        const transport = await tx.company.findFirst({
            where: { id: dto.transportCompanyId, active: true },
            select: { id: true, type: true, types: true, hasInternalFleet: true },
        });
        if (!transport) throw new BadRequestException('Empresa transportista no encontrada o inactiva');
        const tTypes = Array.isArray(transport.types) && (transport.types as string[]).length > 0
            ? (transport.types as string[]) : [transport.type];
        if (!tTypes.includes('transporter') && !transport.hasInternalFleet)
            throw new BadRequestException('La empresa no es transportista');
        updateData.transportCompanyId = dto.transportCompanyId;
        updateData.truckId = null;
        updateData.plate = null;
        updateData.driverId = null;
        updateData.driverName = null;
      }

      if (dto.truckId) {
        const companyId = dto.transportCompanyId || assignment.transportCompanyId;
        const truck = await tx.truck.findFirst({
          where: { id: dto.truckId, companyId, active: true },
          include: { assignedUser: { select: { id: true, name: true } } },
        });
        if (!truck) throw new NotFoundException('Camión no encontrado');
        updateData.truckId = truck.id;
        updateData.plate = truck.plate;
        if (!dto.driverId && (truck as any).assignedUser) {
          updateData.driverId = (truck as any).assignedUser.id;
          updateData.driverName = (truck as any).assignedUser.name;
        }
      } else if (dto.truckId === null) {
        updateData.truckId = null;
        updateData.plate = null;
      }

      if (dto.driverId) {
        const companyId = dto.transportCompanyId || assignment.transportCompanyId;
        const dm = await (tx as any).userCompany.findFirst({
          where: { userId: dto.driverId, companyId, role: 'chofer', active: true },
          include: { user: { select: { id: true, name: true } } },
        });
        if (!dm) throw new BadRequestException('Chofer no encontrado en la empresa transportista');
        updateData.driverId = dm.user.id;
        updateData.driverName = dm.user.name;
      } else if (dto.driverId === null) {
        updateData.driverId = null;
        updateData.driverName = null;
      }

      if (dto.tons !== undefined) {
        updateData.tons = dto.tons;
      }

      if (Object.keys(updateData).length === 0) {
        throw new BadRequestException('No hay cambios para aplicar');
      }

      const result = await (tx.freightAssignment as any).update({
        where: { id: assignmentId },
        data: updateData,
        include: { transportCompany: { select: { id: true, name: true } }, truck: true, driver: { select: { id: true, name: true, phone: true } } },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: 'assignment_updated',
          userId: user.sub,
          metadata: { assignmentId, changes: updateData },
        },
      });

      return { updated: result, freight };
    });

    // Notify transporter about assignment update
    if (updated.transportCompanyId) {
      this.notifications.notifyCompany(
        updated.transportCompanyId,
        NotificationType.freight_updated,
        'Asignación actualizada',
        `${freshFreight.code}: se actualizó tu asignación`,
        freightId,
        user.sub,
      ).catch(e => this.logger.error('Async side-effect failed', e.message));
    }

    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freshFreight.code, status: freshFreight.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return updated;
  }

  async respondTrip(freightId: string, assignmentId: string, dto: RespondTripDto, user: any) {
    let _rtCallerIds: string[] | undefined;
    let _rtIsPlantOnly = false;
    let _rtIsTransporter = false;

    if (user.role === 'chofer') {
      const a = await this.prisma.freightAssignment.findFirst({
        where: { id: assignmentId, freightId, driverId: user.sub, status: { in: ['active', 'accepted'] } },
      });
      if (!a) throw new ForbiddenException('No sos el chofer asignado o la asignación ya no está activa');
    } else {
      const isTransporter = await this.hasCompanyType(user, 'transporter');
      const isPlant = await this.hasCompanyType(user, 'plant');
      if (!isTransporter && !isPlant) throw new ForbiddenException('Solo el transportista o la planta pueden responder');
      _rtCallerIds = await this.resolveAllCompanyIds(user);
      _rtIsPlantOnly = isPlant && !isTransporter;
      _rtIsTransporter = isTransporter;
    }

    if (dto.action === 'rejected') {
      if (!dto.reason?.trim()) throw new BadRequestException('Motivo obligatorio para rechazar');

      const { result, freight: rejectFreight } = await this.prisma.$transaction(async (tx) => {
        // Read freight + assignment INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint respond');
        // Ownership checks inside transaction (TOCTOU-safe)
        if (_rtIsPlantOnly && (!freight.destCompanyId || !_rtCallerIds.includes(freight.destCompanyId))) {
          throw new ForbiddenException('Solo la planta destino puede responder asignaciones');
        }

        const assignment: any = await (tx.freightAssignment as any).findFirst({
          where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
        });
        if (!assignment) throw new NotFoundException('Asignación no encontrada o no activa');
        if (_rtIsTransporter && !_rtCallerIds.includes(assignment.transportCompanyId)) {
          throw new ForbiddenException('No sos el transportista asignado a este viaje');
        }

        await (tx.freightAssignment as any).update({
          where: { id: assignmentId },
          data: { status: AssignmentStatus.rejected, reason: dto.reason, tripStatus: 'canceled' },
        });

        // Compute actual count from DB to avoid race conditions
        const activeCount = await (tx.freightAssignment as any).count({
          where: { freightId, status: { in: ['active', 'accepted'] } },
        });
        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: newStatus, assignedTruckCount: activeCount } as any,
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

        return { result: updated, freight };
      });

      // Notify all participants about trip rejection
      this.notifyAllParticipants(
        rejectFreight, (rejectFreight as any).assignments || [],
        NotificationType.freight_rejected,
        'Camión rechazado',
        `${rejectFreight.code}: ${dto.reason}`,
        user.sub,
      );
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: rejectFreight.code, status: result.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
      return result;
    }

    // Accept — all reads inside transaction
    const { result, freight: acceptFreight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint respond');
      // Ownership checks inside transaction (TOCTOU-safe)
      if (_rtIsPlantOnly && (!freight.destCompanyId || !_rtCallerIds.includes(freight.destCompanyId))) {
        throw new ForbiddenException('Solo la planta destino puede responder asignaciones');
      }

      const assignment: any = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada o no activa');
      if (_rtIsTransporter && !_rtCallerIds.includes(assignment.transportCompanyId)) {
        throw new ForbiddenException('No sos el transportista asignado a este viaje');
      }

      this.stateMachine.validateTripTransition(assignment.tripStatus as any, 'accepted' as any);

      const acceptData: any = { status: AssignmentStatus.accepted, tripStatus: 'accepted' };

      if (dto.truckId) {
        const truck = await tx.truck.findFirst({
          where: { id: dto.truckId, companyId: assignment.transportCompanyId, active: true },
        });
        if (!truck) throw new BadRequestException('Camión no encontrado');
        acceptData.truckId = truck.id;
        acceptData.plate = truck.plate;
        if (truck.assignedUserId && !dto.driverId) acceptData.driverId = truck.assignedUserId;
      }

      if (dto.driverId) {
        const dm = await tx.userCompany.findFirst({
          where: { userId: dto.driverId, companyId: assignment.transportCompanyId, role: 'chofer', active: true },
          include: { user: { select: { id: true, name: true } } },
        });
        if (!dm) throw new BadRequestException('Chofer no encontrado');
        acceptData.driverId = dm.user.id;
        acceptData.driverName = dm.user.name;
        const maxPos: any = await (tx.freightAssignment as any).aggregate({
          _max: { queuePosition: true },
          where: { driverId: dto.driverId, status: { in: ['active', 'accepted'] }, freight: { status: { in: ['assigned', 'accepted', 'in_progress', 'loaded'] } } },
        });
        acceptData.queuePosition = (maxPos._max.queuePosition ?? 0) + 1;
      }

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
          freightId: freightId,
          action: 'trip_accepted',
          fromValue: assignment.tripStatus,
          toValue: 'accepted',
          userId: user.sub,
          metadata: { assignmentId, tripNumber: assignment.tripNumber },
        },
      });

      return { result: updated, freight };
    });

    // Notify all participants about trip acceptance
    this.notifyAllParticipants(
      acceptFreight, (acceptFreight as any).assignments || [],
      NotificationType.freight_accepted,
      'Camión aceptado',
      `${acceptFreight.code} fue aceptado por el transportista`,
      user.sub,
    );
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: acceptFreight.code, status: result.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return result;
  }

  async startTrip(freightId: string, assignmentId: string, user: any) {
    if (user.role === 'chofer') {
      const a = await this.prisma.freightAssignment.findFirst({
        where: { id: assignmentId, freightId, driverId: user.sub },
      });
      if (!a) throw new ForbiddenException('No sos el chofer asignado');
    }

    const { result, freight, assignment } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint start');

      const assignment: any = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada');

      const callerStIds = await this.resolveAllCompanyIds(user);
      if (!callerStIds.includes(assignment.transportCompanyId)) {
        throw new ForbiddenException('No sos el transportista asignado a este viaje');
      }

      this.stateMachine.validateTripTransition(assignment.tripStatus as any, 'in_progress' as any);

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
          freightId: freightId,
          action: 'trip_started',
          fromValue: assignment.tripStatus,
          toValue: 'in_progress',
          userId: user.sub,
          metadata: { assignmentId, tripNumber: assignment.tripNumber },
        },
      });

      return { result: updated, freight, assignment };
    });

    // Notify all participants about trip start
    this.notifyAllParticipants(
      freight, (freight as any).assignments || [],
      NotificationType.freight_started,
      'Camión en camino',
      `${freight.code} — Camión #${assignment.tripNumber} inició viaje`,
      user.sub,
    );
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return result;
  }

  async confirmTripLoaded(freightId: string, assignmentId: string, user: any, loadedTons?: number) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    let ct = await this.resolveCompanyType(user);

    if (ct === 'transporter' || ct === 'producer' || ct === 'plant') {
      const result = await this.prisma.$transaction(async (tx) => {
        // Read INSIDE transaction to prevent race condition
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint confirm-loaded');

        const assignment: any = freight.assignments.find((a: any) => a.id === assignmentId);
        if (!assignment) throw new NotFoundException('Asignación no encontrada');

        const isOwnFleet = assignment.transportCompanyId === freight.originCompanyId;
        // Own fleet promotion: producer OR plant acting as transporter
        if ((ct === 'producer' || ct === 'plant') && isOwnFleet) ct = 'transporter';

        if (ct === 'transporter') {
          const callerCtlIds = await this.resolveAllCompanyIds(user);
          if (!callerCtlIds.includes(assignment.transportCompanyId)) {
            throw new ForbiddenException('No sos el transportista asignado a este viaje');
          }

          if (assignment.tripStatus !== 'in_progress' && assignment.tripStatus !== 'loaded') {
            throw new BadRequestException(`El camión debe estar en viaje para confirmar carga. Estado actual: ${assignment.tripStatus}`);
          }
          if (assignment.transporterLoadedConfirmedAt) throw new BadRequestException('El transportista ya confirmó la carga de este camión');

          const updateData: any = { transporterLoadedConfirmedAt: new Date() };
          if (isOwnFleet) updateData.producerLoadedConfirmedAt = new Date();
          if (assignment.tripStatus === 'in_progress') {
            updateData.tripStatus = 'loaded';
            updateData.loadedAt = new Date();
          }
          if (loadedTons != null) updateData.loadedTons = loadedTons;
          await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: updateData });

          const newStatus = await this.deriveFreightStatus(tx, freightId);
          const freightData: any = { status: newStatus };
          if (newStatus === FreightStatus.loaded && !freight.loadedAt) freightData.loadedAt = new Date();
          const updated = await tx.freight.update({ where: { id: freightId }, data: freightData });

          await tx.auditLog.create({
            data: {
              entityType: 'freight', entityId: freightId, freightId: freightId, action: 'trip_confirm_loaded',
              fromValue: assignment.tripStatus, toValue: 'loaded', userId: user.sub,
              metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'transporter', ...(loadedTons != null ? { loadedTons } : {}) },
            },
          });
          return updated;
        }

        if (ct === 'producer') {
          // Verify caller is the origin company
          const callerProdIds = await this.resolveAllCompanyIds(user);
          if (!callerProdIds.includes(freight.originCompanyId)) {
            throw new ForbiddenException('Solo el productor de origen puede confirmar la carga');
          }
          if (assignment.tripStatus !== 'loaded') throw new BadRequestException('El camión debe estar cargado para que el productor confirme');
          if (assignment.producerLoadedConfirmedAt) throw new BadRequestException('El productor ya confirmó la carga');

          await (tx.freightAssignment as any).update({ where: { id: assignmentId }, data: { producerLoadedConfirmedAt: new Date() } });
          await tx.auditLog.create({
            data: {
              entityType: 'freight', entityId: freightId, freightId: freightId, action: 'trip_confirm_loaded',
              fromValue: 'loaded', toValue: 'loaded', userId: user.sub,
              metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'producer' },
            },
          });
          return freight;
        }

        throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
      });

      // Notify all participants about trip loaded
      const tripLoadedBy = ct === 'transporter' ? 'el transportista' : 'el productor';
      const tripLoadedActionIds = ct === 'transporter' && (result as any).originCompanyId
        ? new Set([(result as any).originCompanyId])
        : undefined;
      this.notifyAllParticipants(
        result as any, ((result as any).assignments || []),
        NotificationType.freight_loaded,
        'Carga confirmada',
        `${(result as any).code}: ${tripLoadedBy} confirmó la carga`,
        user.sub,
        tripLoadedActionIds,
      );
      this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: (result as any).code, status: (result as any).status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
      return result;
    }

    throw new ForbiddenException('Solo transportista o productor pueden confirmar carga');
  }

  async confirmTripFinished(freightId: string, assignmentId: string, user: any) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    let ct = await this.resolveCompanyType(user);

    const { result, freight: txFreight, bothConfirmed, confirmedBy } = await this.prisma.$transaction(async (tx) => {
      // Read INSIDE transaction to prevent race condition — load ALL active assignments for notification
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint confirm-finished');

      const assignment: any = freight.assignments.find((a: any) => a.id === assignmentId);
      if (!assignment) throw new NotFoundException('Asignación no encontrada');

      if (assignment.tripStatus !== 'loaded') {
        throw new BadRequestException(`Solo se puede finalizar un camión cargado. Estado actual: ${assignment.tripStatus}`);
      }

      // Own fleet promotion: producer OR plant acting as transporter
      const isOwnFleet = assignment.transportCompanyId === freight.originCompanyId;
      if ((ct === 'producer' || ct === 'plant') && isOwnFleet) ct = 'transporter';

      if (ct === 'transporter') {
        const callerCtfIds = await this.resolveAllCompanyIds(user);
        if (!callerCtfIds.includes(assignment.transportCompanyId)) {
          throw new ForbiddenException('No sos el transportista asignado a este viaje');
        }
        if (assignment.transporterFinishedConfirmedAt) throw new BadRequestException('El transportista ya confirmó la entrega');
        const plantAlsoConfirmed = !!assignment.plantFinishedConfirmedAt;

        const updateData: any = { transporterFinishedConfirmedAt: new Date() };
        if (isOwnFleet) updateData.plantFinishedConfirmedAt = new Date();
        const bothConfirmed = plantAlsoConfirmed || isOwnFleet;
        if (bothConfirmed) {
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
            entityType: 'freight', entityId: freightId, freightId: freightId,
            action: bothConfirmed ? 'trip_finished' : 'trip_confirm_finished',
            fromValue: 'loaded', toValue: bothConfirmed ? 'finished' : 'loaded', userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'transporter', bothConfirmed },
          },
        });
        return { result: updated, freight, bothConfirmed, confirmedBy: 'transporter' as const };
      }

      if (ct === 'plant') {
        const allIdsCtf = await this.resolveAllCompanyIds(user);
        if (!freight.destCompanyId || !allIdsCtf.includes(freight.destCompanyId)) {
          throw new ForbiddenException('Solo la planta destino puede confirmar la recepción del viaje');
        }

        if (assignment.plantFinishedConfirmedAt) throw new BadRequestException('La planta ya confirmó la recepción');
        const transporterAlsoConfirmed = !!assignment.transporterFinishedConfirmedAt;

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
            entityType: 'freight', entityId: freightId, freightId: freightId,
            action: transporterAlsoConfirmed ? 'trip_finished' : 'trip_confirm_finished',
            fromValue: 'loaded', toValue: transporterAlsoConfirmed ? 'finished' : 'loaded', userId: user.sub,
            metadata: { assignmentId, tripNumber: assignment.tripNumber, confirmedBy: 'plant', bothConfirmed: transporterAlsoConfirmed },
          },
        });
        return { result: updated, freight, bothConfirmed: transporterAlsoConfirmed, confirmedBy: 'plant' as const };
      }

      throw new ForbiddenException('Solo transportista o planta pueden confirmar finalización');
    });

    // Notify all participants about trip finish confirmation
    const confirmerLabel = confirmedBy === 'transporter' ? 'el transportista' : 'la planta';
    const tripTitle = bothConfirmed ? 'Entrega confirmada' : 'Confirmación de entrega';
    const tripBody = bothConfirmed
      ? `${txFreight.code}: entrega confirmada por ambas partes`
      : `${txFreight.code}: ${confirmerLabel} confirmó la entrega`;
    // If only one side confirmed, the other side gets action buttons
    let tripActionIds: Set<string> | undefined;
    if (!bothConfirmed) {
      if (confirmedBy === 'transporter' && txFreight.destCompanyId) {
        tripActionIds = new Set<string>([txFreight.destCompanyId]);
      } else if (confirmedBy === 'plant') {
        const transporterIds = txFreight.assignments
          .filter((a: any) => a.transportCompanyId)
          .map((a: any) => a.transportCompanyId);
        if (transporterIds.length > 0) tripActionIds = new Set<string>(transporterIds);
      }
    }
    this.notifyAllParticipants(
      txFreight, txFreight.assignments || [],
      bothConfirmed ? NotificationType.freight_finished : NotificationType.freight_confirmed,
      tripTitle, tripBody, user.sub, tripActionIds,
    );
    this.sse.broadcastFreightUpdate(freightId, { id: freightId, code: (result as any).code, status: (result as any).status }, user.sub).catch(e => this.logger.error('Async side-effect failed', e.message));
    return result;
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
    // Validate coordinate bounds
    if (typeof body.lat !== 'number' || typeof body.lng !== 'number' ||
        body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180 ||
        !isFinite(body.lat) || !isFinite(body.lng)) {
      throw new BadRequestException('Coordenadas inválidas (lat: -90..90, lng: -180..180)');
    }

    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId }, select: { status: true } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (freight.status !== FreightStatus.in_progress && freight.status !== FreightStatus.loaded) {
        throw new BadRequestException('Solo se puede trackear un flete en curso o cargado');
      }

      return tx.freightTracking.create({
        data: {
          freightId,
          lat: body.lat,
          lng: body.lng,
          speed: body.speed ?? null,
          heading: body.heading ?? null,
          userId: user.sub,
        },
      });
    });
  }

  async getTrackingPoints(freightId: string) {
    // Fetch most recent 500 points (desc) then reverse for chronological order
    const points = await this.prisma.freightTracking.findMany({
      where: { freightId },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: { id: true, userId: true, lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
    return points.reverse();
  }

  async getLastPosition(freightId: string) {
    return this.prisma.freightTracking.findFirst({
      where: { freightId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, userId: true, lat: true, lng: true, speed: true, heading: true, createdAt: true },
    });
  }

  /** Latest position per participant (for map pins) */
  async getParticipantPositions(freightId: string) {
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT DISTINCT ON (t.user_id)
        t.id, t.user_id AS "userId",
        CAST(t.lat AS double precision) AS lat,
        CAST(t.lng AS double precision) AS lng,
        CAST(t.speed AS double precision) AS speed,
        CAST(t.heading AS double precision) AS heading,
        t.created_at AS "createdAt",
        u.name AS "userName",
        CASE
          WHEN EXISTS (SELECT 1 FROM freight_assignments fa WHERE fa.freight_id = t.freight_id AND fa.driver_id = t.user_id) THEN 'chofer'
          WHEN u.company_id = f.origin_company_id THEN 'producer'
          WHEN u.company_id = f.dest_company_id THEN 'plant'
          WHEN EXISTS (SELECT 1 FROM freight_assignments fa WHERE fa.freight_id = t.freight_id AND fa.transport_company_id = u.company_id) THEN 'transporter'
          ELSE 'other'
        END AS "participantType"
      FROM freight_tracking t
      LEFT JOIN users u ON u.id = t.user_id
      LEFT JOIN freights f ON f.id = t.freight_id
      WHERE t.freight_id = ${freightId} AND t.user_id IS NOT NULL
      ORDER BY t.user_id, t.created_at DESC
    `;
    return rows;
  }

  // ======================== ADD DOCUMENT ================================

  private static readonly MAX_DOCS_PER_FREIGHT = 50;
  private static readonly VALID_DOC_STEPS = ['request', 'assignment', 'load_confirmation', 'delivery_confirmation', 'cancellation'];

  async addDocument(
    freightId: string,
    body: { name: string; url: string; type?: string; step?: string },
    user: any,
  ) {
    // Resolve company IDs outside tx (doesn't change concurrently)
    const allIds = user.role !== 'platform_admin' ? await this.resolveAllCompanyIds(user) : [];

    // Validate step if provided
    if (body.step && !FreightsService.VALID_DOC_STEPS.includes(body.step)) {
      throw new BadRequestException(`Paso inválido. Valores permitidos: ${FreightsService.VALID_DOC_STEPS.join(', ')}`);
    }

    // Validate URL hostname matches Supabase (SSRF protection)
    const supabaseUrl = this.config.get<string>('SUPABASE_URL');
    if (supabaseUrl) {
      try {
        const docOrigin = new URL(body.url).origin;
        const expectedOrigin = new URL(supabaseUrl).origin;
        if (docOrigin !== expectedOrigin) throw new BadRequestException('URL no permitida');
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        throw new BadRequestException('URL inválida');
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        select: {
          id: true, code: true, originCompanyId: true, destCompanyId: true,
          assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true, driverId: true } },
        },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');

      if (user.role !== 'platform_admin') {
        const freightCompanies = [freight.originCompanyId, freight.destCompanyId,
          ...freight.assignments.map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = freight.assignments.some(a => a.driverId === user.sub);
        const hasAccess = isDriver || allIds.some(id => freightCompanies.includes(id));
        if (!hasAccess) throw new ForbiddenException('No tiene acceso a este flete');
      }

      // Enforce document limit per freight
      const docCount = await tx.freightDocument.count({ where: { freightId } });
      if (docCount >= FreightsService.MAX_DOCS_PER_FREIGHT) {
        throw new BadRequestException(`Límite de ${FreightsService.MAX_DOCS_PER_FREIGHT} documentos por flete alcanzado`);
      }

      const doc = await tx.freightDocument.create({
        data: {
          freightId,
          name: body.name || 'foto',
          url: body.url,
          type: body.type || 'photo',
          step: (body.step as DocumentStep) || null,
          uploadedById: user.sub,
        },
      });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'document_added', userId: user.sub, metadata: { docId: doc.id, name: body.name, type: body.type } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return doc;
    });
  }

  // ======================== DELETE DOCUMENT ==============================

  async deleteDocument(freightId: string, docId: string, user: any) {
    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (freight.status === 'finished' || freight.status === 'canceled') {
        throw new ForbiddenException('No se pueden eliminar archivos de un flete finalizado o cancelado');
      }

      const doc = await tx.freightDocument.findFirst({
        where: { id: docId, freightId },
      });
      if (!doc) throw new NotFoundException('Documento no encontrado');

      if (doc.uploadedById !== user.sub && user.role !== 'platform_admin') {
        throw new ForbiddenException('Solo quien subió el documento puede eliminarlo');
      }

      await tx.freightDocument.delete({ where: { id: docId } });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'document_deleted', userId: user.sub, metadata: { docId, name: doc.name, type: doc.type } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return { ok: true };
    });
  }

  // ======================== SAVE OCR DATA ================================

  async saveOcrData(freightId: string, docId: string, ocrData: any, user: any) {
    // Validate ocrData shape and size
    if (!ocrData || typeof ocrData !== 'object' || Array.isArray(ocrData)) {
      throw new BadRequestException('ocrData debe ser un objeto JSON');
    }
    if (Object.keys(ocrData).length > 100) {
      throw new BadRequestException('ocrData tiene demasiados campos (máx 100)');
    }
    // Depth check to prevent stack overflow from deeply nested objects
    const checkDepth = (obj: any, depth: number): boolean => {
      if (depth > 10) return false;
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) {
          if (!checkDepth(v, depth + 1)) return false;
        }
      }
      return true;
    };
    if (!checkDepth(ocrData, 0)) {
      throw new BadRequestException('ocrData demasiado anidado (máx 10 niveles)');
    }
    const serialized = JSON.stringify(ocrData);
    if (serialized.length > 50_000) {
      throw new BadRequestException('ocrData demasiado grande (máx 50KB)');
    }

    const allIds = user.role !== 'platform_admin' ? await this.resolveAllCompanyIds(user) : [];

    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        select: {
          id: true, originCompanyId: true, destCompanyId: true,
          assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true, driverId: true } },
        },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');

      if (user.role !== 'platform_admin') {
        const freightCompanies = [freight.originCompanyId, freight.destCompanyId,
          ...freight.assignments.map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = freight.assignments.some(a => a.driverId === user.sub);
        const hasAccess = isDriver || allIds.some(id => freightCompanies.includes(id));
        if (!hasAccess) throw new ForbiddenException('No tiene acceso a este flete');
      }

      const doc = await tx.freightDocument.findFirst({ where: { id: docId, freightId } });
      if (!doc) throw new NotFoundException('Documento no encontrado');

      await tx.freightDocument.update({
        where: { id: docId },
        data: { ocrData },
      });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'ocr_data_saved', userId: user.sub, metadata: { docId, docName: doc.name } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return { ok: true };
    });
  }
}
