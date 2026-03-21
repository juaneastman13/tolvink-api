import { Injectable, BadRequestException, NotFoundException, ForbiddenException, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { NotificationService } from '../notifications/notification.service';
import { SseService } from '../sse/sse.service';
import { CreateFreightDto, AssignFreightDto, RespondAssignmentDto, CancelFreightDto, AssignMultiTruckDto, TruckAssignmentDto, RespondTripDto } from './freights.dto';
import { Prisma, FreightStatus, AssignmentStatus, NotificationType, DocumentStep } from '@prisma/client';
import { randomInt } from 'crypto';

@Injectable()
export class FreightsService {
  private readonly logger = new Logger(FreightsService.name);

  // In-memory cache for statusCounts groupBy (30s TTL, keyed by serialized company WHERE)
  private statusCountsCache = new Map<string, { data: Record<string, number>; ts: number }>();
  private static readonly STATUS_COUNTS_TTL = 30_000; // 30 seconds

  /** Invalidate all cached status counts (called after any freight mutation) */
  invalidateStatusCounts() {
    this.statusCountsCache.clear();
  }

  private _broadcastConsecutiveErrors = 0;

  /** Broadcast freight update, invalidate status counts cache, and refresh participant IDs.
   *  TODO: Add AI conversation cache invalidation after assignment changes (assign, assignMulti, updateAssignment, respond)
   *  to prevent stale context in AI responses. */
  private broadcastAndInvalidate(freightId: string, data: any, excludeUserId?: string) {
    this.invalidateStatusCounts();
    this.refreshParticipantIds(freightId).catch(e => this.logger.error('refreshParticipantIds failed', e.message));
    this.sse.broadcastFreightUpdate(freightId, data, excludeUserId)
      .then(() => { this._broadcastConsecutiveErrors = 0; })
      .catch(e => {
        this._broadcastConsecutiveErrors++;
        this.logger.warn(`SSE broadcast failed (attempt 1) for freight ${freightId}: ${e.message}`);
        // Retry once after a short delay
        setTimeout(() => {
          this.sse.broadcastFreightUpdate(freightId, data, excludeUserId)
            .then(() => { this._broadcastConsecutiveErrors = 0; })
            .catch(retryErr => {
              this._broadcastConsecutiveErrors++;
              if (this._broadcastConsecutiveErrors >= 5) {
                this.logger.error(`broadcastAndInvalidate: ${this._broadcastConsecutiveErrors} consecutive failures — ${retryErr.message}`);
              } else {
                this.logger.warn(`SSE broadcast retry failed for freight ${freightId}: ${retryErr.message}`);
              }
            });
        }, 500);
      });
  }

  private async getCachedStatusCounts(companyWhere: any): Promise<Record<string, number>> {
    // Normalize key by sorting object keys for consistent cache hits
    const key = JSON.stringify(Object.keys(companyWhere).sort().reduce((acc, k) => { acc[k] = companyWhere[k]; return acc; }, {} as any));
    const cached = this.statusCountsCache.get(key);
    if (cached && Date.now() - cached.ts < FreightsService.STATUS_COUNTS_TTL) {
      return cached.data;
    }
    const statusGroupBy = await this.prisma.freight.groupBy({
      by: ['status'],
      where: companyWhere,
      _count: { _all: true },
    });
    const statusCounts: Record<string, number> = {};
    for (const row of statusGroupBy) { statusCounts[row.status] = row._count._all; }
    // Prevent unbounded cache growth
    if (this.statusCountsCache.size > 100) this.statusCountsCache.clear();
    this.statusCountsCache.set(key, { data: statusCounts, ts: Date.now() });
    return statusCounts;
  }

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

  /**
   * Plant-centric: check if caller is plant and transporter is CONSULTA (READONLY).
   * Returns true if plant should act on behalf of the transporter.
   */
  private async isPlantActingForConsultaTransporter(
    user: any, destCompanyId: string | null, transportCompanyId: string | null,
  ): Promise<boolean> {
    if (!destCompanyId || !transportCompanyId) return false;
    const ct = await this.resolveCompanyType(user);
    if (ct !== 'plant') return false;
    const callerIds = await this.resolveAllCompanyIds(user);
    if (!callerIds.includes(destCompanyId)) return false;
    const access = await this.prisma.companyAccess.findFirst({
      where: { grantorCompanyId: destCompanyId, granteeCompanyId: transportCompanyId, isActive: true, accessLevel: 'READONLY' },
    });
    return !!access;
  }

  /** Recompute and persist the participantCompanyIds denormalized array.
   *  Called after any mutation that changes freight participants (create, assign, cancel assignment). */
  async refreshParticipantIds(freightId: string, tx?: any) {
    const db = tx || this.prisma;
    const freight = await db.freight.findUnique({
      where: { id: freightId },
      select: {
        originCompanyId: true,
        destCompanyId: true,
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          select: { transportCompanyId: true },
        },
      },
    });
    if (!freight) return;
    const ids = new Set<string>();
    if (freight.originCompanyId) ids.add(freight.originCompanyId);
    if (freight.destCompanyId) ids.add(freight.destCompanyId);
    for (const a of freight.assignments) {
      if (a.transportCompanyId) ids.add(a.transportCompanyId);
    }
    await db.freight.update({
      where: { id: freightId },
      data: { participantCompanyIds: [...ids] },
    });
  }

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
    freight: { id: string; originCompanyId: string; destCompanyId?: string | null; producerCompanyId?: string | null },
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
    if (freight.producerCompanyId) companyIds.add(freight.producerCompanyId);
    if (assignments) {
      for (const a of assignments) {
        if (a.transportCompanyId) companyIds.add(a.transportCompanyId);
      }
    }
    for (const cid of companyIds) {
      const isAction = actionCompanyIds?.has(cid) ?? false;
      this.notifications.notifyCompany(cid, type, title, body, freight.id, excludeUserId, isAction)
        .catch(err => this.logger.error(`notifyCompany failed for ${cid}: ${err.message}`));
    }
  }

  async create(dto: CreateFreightDto, user: any) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden crear fletes');

    if (!dto.destPlantId && !dto.customDestName) {
      throw new BadRequestException('Debe indicar planta destino o destino personalizado');
    }

    // Plant-centric: when plant creates freight on behalf of producer
    let producerCompanyId: string;
    const callerIsPlant = (await this.resolveCompanyType(user)) === 'plant';

    if (callerIsPlant && dto.producerCompanyId) {
      // Plant acting on behalf of a linked producer
      const plantCompanyId = user.activeCompanyId || user.companyId;
      if (!plantCompanyId) throw new BadRequestException('No se pudo determinar tu empresa planta');
      const access = await this.prisma.companyAccess.findFirst({
        where: {
          grantorCompanyId: plantCompanyId,
          granteeCompanyId: dto.producerCompanyId,
          isActive: true,
        },
      });
      if (!access) throw new BadRequestException('No hay vinculación activa con esa empresa productora');
      // The producer's company is the origin (their field, their freight)
      producerCompanyId = dto.producerCompanyId;
    } else if (callerIsPlant) {
      // Plant creating freight without specifying producer — use plant's own company
      producerCompanyId = user.activeCompanyId || user.companyId;
      if (!producerCompanyId) throw new BadRequestException('No se pudo determinar tu empresa');
    } else {
      // Normal producer flow
      producerCompanyId = await this.resolveProducerCompanyId(user);
      if (!producerCompanyId) throw new BadRequestException('No se encontró una empresa productora asociada a tu usuario');
    }

    let lot: any = null;
    let fieldForOrigin: any = null;
    if (dto.originLotId) {
      // Allow lot owned by producer OR created by plant (companyId=plant, ownerCompanyId=producer)
      const lotCompanyIds = callerIsPlant
        ? [producerCompanyId, user.activeCompanyId || user.companyId].filter(Boolean)
        : [producerCompanyId];
      lot = await this.prisma.lot.findFirst({
        where: { id: dto.originLotId, companyId: { in: lotCompanyIds }, active: true },
        include: { field: true },
      });
      if (!lot) throw new BadRequestException('Lote no encontrado o no pertenece a tu empresa');
    } else if (dto.fieldId) {
      // "Usar ubicación del campo" — no lot selected, use field coordinates
      fieldForOrigin = await this.prisma.field.findFirst({
        where: { id: dto.fieldId, active: true },
      });
      if (!fieldForOrigin) throw new BadRequestException('Campo no encontrado');
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
          where: { id: dto.destPlantId, active: true, OR: [{ type: 'plant' }, { types: { array_contains: 'plant' } }] },
        });
        if (!company) throw new BadRequestException('Planta no encontrada');
        destCompanyId = company.id;
        destPlantId = null;
        destName = dto.customDestName || company.name;
        destLat = dto.customDestLat ?? dto.overrideDestLat ?? company.lat;
        destLng = dto.customDestLng ?? dto.overrideDestLng ?? company.lng;
      }
    } else {
      destName = dto.customDestName || 'Ubicación personalizada';
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

    // Deduplicate participants — plant can be both origin and dest
    const participantIds = [...new Set([producerCompanyId, destCompanyId, dto.producerCompanyId].filter(Boolean))];
    const participants: { companyId: string }[] = participantIds.map(id => ({ companyId: id }));

    const originName = dto.customOriginName || (lot ? lot.name : (fieldForOrigin ? fieldForOrigin.name : 'Ubicación personalizada'));
    // Use nullish coalescing — Prisma Decimal(0) is falsy with ||, so use ?? and skip 0
    const lotLat = lot?.lat != null && Number(lot.lat) !== 0 ? lot.lat : null;
    const lotLng = lot?.lng != null && Number(lot.lng) !== 0 ? lot.lng : null;
    const fieldLat = lot?.field?.lat != null && Number(lot.field.lat) !== 0 ? lot.field.lat : null;
    const fieldLng = lot?.field?.lng != null && Number(lot.field.lng) !== 0 ? lot.field.lng : null;
    // fieldForOrigin: "Usar ubicación del campo" — field selected without lot
    const directFieldLat = fieldForOrigin?.lat != null && Number(fieldForOrigin.lat) !== 0 ? fieldForOrigin.lat : null;
    const directFieldLng = fieldForOrigin?.lng != null && Number(fieldForOrigin.lng) !== 0 ? fieldForOrigin.lng : null;
    const originLat = dto.overrideOriginLat ?? lotLat ?? fieldLat ?? directFieldLat ?? null;
    const originLng = dto.overrideOriginLng ?? lotLng ?? fieldLng ?? directFieldLng ?? null;

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
          producerCompanyId: dto.producerCompanyId || null,
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
          truckCount: Math.max(1, dto.truckCount || 1),
          assignedTruckCount: 0,
          isMultiTruck: Math.max(1, dto.truckCount || 1) > 1,
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
          // Use explicit driverId from DTO if provided, otherwise fall back to truck's assigned user
          let assignDriverId = truck.assignedUserId || null;
          let assignDriverName = (truck as any).assignedUser?.name || null;
          if (dto.driverId) {
            const driverUser = await tx.user.findUnique({ where: { id: dto.driverId }, select: { id: true, name: true } });
            if (driverUser) { assignDriverId = driverUser.id; assignDriverName = driverUser.name; }
          }

          // Flow C vs D: if freight has a plant destination → needs plant approval (pending)
          // If no plant destination (custom) → direct accepted (Flow D)
          const needsPlantApproval = !!f.destCompanyId;
          const assignmentStatus = needsPlantApproval ? AssignmentStatus.active : AssignmentStatus.accepted;
          const tripStatusVal = needsPlantApproval ? 'pending' : 'accepted';

          await tx.freightAssignment.create({
            data: {
              freightId: f.id,
              transportCompanyId: producerCompanyId,
              status: assignmentStatus,
              assignedById: user.sub,
              truckId: truck.id,
              plate: truck.plate,
              driverId: assignDriverId,
              driverName: assignDriverName,
              ...(isMulti ? { tripNumber: 1, tripStatus: tripStatusVal } : {}),
            },
          });

          // Flow C: stay at pending_assignment (plant must authorize)
          // Flow D: go to accepted (producer has full autonomy)
          // Multi-truck: stay at pending_assignment until all slots filled
          let newStatus: FreightStatus;
          if (isMulti) {
            newStatus = FreightStatus.pending_assignment;
          } else if (needsPlantApproval) {
            newStatus = FreightStatus.pending_assignment; // Flow C
          } else {
            newStatus = FreightStatus.accepted; // Flow D
          }
          const assignedCount = await tx.freightAssignment.count({ where: { freightId: f.id, status: { in: ['active', 'accepted'] } } });
          await tx.freight.update({
            where: { id: f.id },
            data: { status: newStatus, assignedTruckCount: assignedCount } as any,
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
    this.broadcastAndInvalidate(freight.id, { id: freight.id, code: freight.code, status: freight.status }, user.sub);

    // Fire-and-forget: calculate route if coordinates available
    this.calculateRoute(freight.id, originLat, originLng, destLat, destLng).catch(() => {});

    return freight;
  }

  /** Calculate route between origin and destination using Google Directions API */
  private async calculateRoute(freightId: string, oLat: any, oLng: any, dLat: any, dLng: any) {
    if (!oLat || !oLng || !dLat || !dLng) return;
    const key = this.config.get<string>('GOOGLE_DIRECTIONS_API_KEY');
    if (!key) return;
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${oLat},${oLng}&destination=${dLat},${dLng}&key=${key}`;
      const res = await fetch(url);
      const json = await res.json();
      if (json.status !== 'OK' || !json.routes?.[0]) return;
      const route = json.routes[0];
      const leg = route.legs?.[0];
      await this.prisma.freight.update({
        where: { id: freightId },
        data: {
          routePolyline: route.overview_polyline?.points || null,
          routeDistanceKm: leg?.distance?.value ? Math.round(leg.distance.value / 100) / 10 : null,
          routeDurationMin: leg?.duration?.value ? Math.round(leg.duration.value / 60) : null,
          routeCalculatedAt: new Date(),
        },
      });
      this.logger.log(`Route calculated for freight ${freightId}: ${leg?.distance?.text}, ${leg?.duration?.text}`);
    } catch (e) {
      this.logger.warn(`Route calculation failed for ${freightId}: ${e.message}`);
    }
  }

  // ======================== LIST (multi-tenant) =======================

  async findAll(user: any, query: { status?: string; page?: number; limit?: number; company?: string; cursor?: string; dateFrom?: string; dateTo?: string; grain?: string; search?: string; destName?: string; originCompany?: string; transporter?: string }) {
    const limit = Math.min(query.limit || 20, 100);

    const where: any = {};

    if (user.role !== 'platform_admin') {
      const allIds = await this.resolveAllCompanyIds(user);
      const filterIds = query.company && allIds.includes(query.company)
        ? [query.company]
        : allIds;

      // Use materialized participantCompanyIds for fast filtering (GIN index).
      // Also include driver-level access via assignments for choferes.
      where.OR = [
        { participantCompanyIds: { hasSome: filterIds } },
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

    // Capture company-scoped where before adding filters (for status counts)
    const companyWhere: any = where.OR ? { OR: [...where.OR] } : {};

    if (query.status) {
      const statuses = query.status.split(',').map(s => s.trim());
      for (const s of statuses) {
        if (!Object.values(FreightStatus).includes(s as FreightStatus)) {
          throw new BadRequestException(`Estado inválido: ${s}`);
        }
      }
      where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (query.dateFrom || query.dateTo) {
      where.loadDate = {};
      if (query.dateFrom && !isNaN(new Date(query.dateFrom).getTime())) {
        where.loadDate.gte = new Date(query.dateFrom);
      }
      if (query.dateTo && !isNaN(new Date(query.dateTo + 'T23:59:59.999Z').getTime())) {
        where.loadDate.lte = new Date(query.dateTo + 'T23:59:59.999Z');
      }
      if (Object.keys(where.loadDate).length === 0) delete where.loadDate;
    }
    if (query.grain) {
      where.items = { some: { grain: { contains: query.grain, mode: 'insensitive' } } };
    }
    if (query.destName) {
      where.destName = { contains: query.destName, mode: 'insensitive' };
    }
    if (query.originCompany) {
      where.originCompany = { ...where.originCompany, name: { contains: query.originCompany, mode: 'insensitive' } };
    }
    if (query.transporter) {
      // Helper to safely append an AND condition
      const addAnd = (cond: any) => {
        if (where.AND) { where.AND.push(cond); }
        else if (where.OR) { where.AND = [{ OR: where.OR }, cond]; delete where.OR; }
        else { Object.assign(where, cond); }
      };
      addAnd({ assignments: { some: { transportCompany: { name: { contains: query.transporter, mode: 'insensitive' } }, status: { in: ['active', 'accepted'] } } } });
    }

    if (query.search) {
      const s = query.search;
      const searchConditions: any[] = [
        { code: { contains: s, mode: 'insensitive' } },
        { originName: { contains: s, mode: 'insensitive' } },
        { destName: { contains: s, mode: 'insensitive' } },
        { items: { some: { grain: { contains: s, mode: 'insensitive' } } } },
        { originCompany: { name: { contains: s, mode: 'insensitive' } } },
        { destCompany: { name: { contains: s, mode: 'insensitive' } } },
        { field: { name: { contains: s, mode: 'insensitive' } } },
        { requestedBy: { name: { contains: s, mode: 'insensitive' } } },
        { assignments: { some: { transportCompany: { name: { contains: s, mode: 'insensitive' } } } } },
        { assignments: { some: { driver: { name: { contains: s, mode: 'insensitive' } } } } },
        { assignments: { some: { truck: { plate: { contains: s, mode: 'insensitive' } } } } },
      ];
      // Combine with existing where.OR (company scoping) using AND
      if (where.OR) {
        where.AND = [{ OR: where.OR }, { OR: searchConditions }];
        delete where.OR;
      } else {
        where.OR = searchConditions;
      }
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

    const [freights, total, statusCounts] = await Promise.all([
      this.prisma.freight.findMany({
        where,
        ...paginationArgs,
        include: {
          items: { select: { id: true, grain: true, tons: true } },
          originLot: { select: { id: true, name: true } },
          field: { select: { id: true, name: true } },
          destPlant: { select: { id: true, name: true } },
          originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
          producerCompany: { select: { id: true, name: true } },
          requestedBy: { select: { id: true, name: true } },
          // Light mode: omit documents, pendingChanges, conversation — loaded on-demand in detail view
          _count: { select: { documents: true, weighTickets: true } },
          assignments: {
            where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
            orderBy: { createdAt: 'asc' },
            include: {
              transportCompany: { select: { id: true, name: true } },
              driver: { select: { id: true, name: true, phone: true } },
              truck: { select: { id: true, plate: true, model: true } },
            },
          },
        },
      }),
      this.prisma.freight.count({ where }),
      this.getCachedStatusCounts(companyWhere),
    ]);

    // Batch-query OCR document counts to avoid N+1
    const freightIds = freights.map((f: any) => f.id);
    const [ocrDocCounts, ocrTicketCounts] = freightIds.length > 0 ? await Promise.all([
      this.prisma.freightDocument.groupBy({
        by: ['freightId'],
        where: { freightId: { in: freightIds }, ocrData: { not: Prisma.DbNull } },
        _count: true,
      }),
      this.prisma.weighTicket.groupBy({
        by: ['freightId'],
        where: { freightId: { in: freightIds }, ocrConfidence: { not: null } },
        _count: true,
      }),
    ]) : [[], []];

    const ocrDocMap = new Map(ocrDocCounts.map((r: any) => [r.freightId, r._count]));
    const ocrTicketMap = new Map(ocrTicketCounts.map((r: any) => [r.freightId, r._count]));

    const enriched = freights.map((f: any) => ({
      ...f,
      documentCount: f._count?.documents || 0,
      weighTicketCount: f._count?.weighTickets || 0,
      ocrDocCount: ocrDocMap.get(f.id) || 0,
      ocrTicketCount: ocrTicketMap.get(f.id) || 0,
    }));

    const page = query.page || 1;
    const nextCursor = enriched.length === limit ? enriched[enriched.length - 1]?.id : undefined;
    return { data: enriched, total, page, limit, pages: Math.ceil(total / limit), nextCursor, statusCounts };
  }

  // ======================== FIND ONE =================================

  async findOne(id: string, companyIds?: string[], currentUser?: any) {
    // When companyIds are provided (direct service calls), add company scoping.
    // When called from controller with FreightAccessGuard, companyIds is undefined
    // and access was already verified — use findUnique (faster, uses PK index).
    const useCompanyScoping = companyIds && companyIds.length > 0;

    const includeClause = {
      items: true,
      originLot: true,
      destPlant: true,
      field: { select: { id: true, name: true } },
      originCompany: { select: { id: true, name: true, type: true, hasInternalFleet: true, types: true } },
      destCompany: { select: { id: true, name: true, type: true, hasInternalFleet: true, types: true } },
      producerCompany: { select: { id: true, name: true } },
      requestedBy: { select: { id: true, name: true } },
      assignments: {
        orderBy: { createdAt: 'desc' as const },
        include: {
          transportCompany: { select: { id: true, name: true } },
          assignedBy: { select: { id: true, name: true } },
          driver: { select: { id: true, name: true } },
          truck: { select: { id: true, plate: true, model: true } },
        },
      },
      documents: { orderBy: { createdAt: 'desc' as const }, take: 20 },
      conversation: { select: { id: true } },
      pendingChanges: { where: { status: 'pending' as const }, select: { id: true, changeType: true, fromValue: true, toValue: true, requestedById: true, approverCompanyId: true, status: true, createdAt: true, requestedBy: { select: { name: true } } } },
    };

    const freight = useCompanyScoping
      ? await this.prisma.freight.findFirst({
          where: {
            id,
            OR: [
              { originCompanyId: { in: companyIds } },
              { destCompanyId: { in: companyIds } },
              { assignments: { some: { transportCompanyId: { in: companyIds }, status: { in: ['active', 'accepted'] } } } },
            ],
          },
          include: includeClause,
        })
      : await this.prisma.freight.findUnique({
          where: { id },
          include: includeClause,
        });

    if (!freight) throw new NotFoundException('Flete no encontrado');

    return freight;
  }

  /** Light single-freight fetch (same shape as findAll items) — used for SSE refresh without full detail overhead */
  async findOneSummary(id: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { id },
      include: {
        items: { select: { id: true, grain: true, tons: true } },
        originLot: { select: { id: true, name: true } },
        field: { select: { id: true, name: true } },
        destPlant: { select: { id: true, name: true } },
        originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
        destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
        producerCompany: { select: { id: true, name: true } },
        requestedBy: { select: { id: true, name: true } },
        assignments: {
          where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } },
          orderBy: { createdAt: 'asc' as const },
          include: {
            transportCompany: { select: { id: true, name: true } },
            driver: { select: { id: true, name: true, phone: true } },
            truck: { select: { id: true, plate: true, model: true } },
          },
        },
      },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    return freight;
  }

  /** Fetch only the "extra" detail fields not included in list/summary responses */
  async findOneDetailExtra(id: string) {
    const freight = await this.prisma.freight.findUnique({
      where: { id },
      select: {
        id: true,
        documents: { orderBy: { createdAt: 'desc' as const }, take: 20 },
        conversation: { select: { id: true } },
        pendingChanges: {
          where: { status: 'pending' },
          select: {
            id: true, changeType: true, fromValue: true, toValue: true,
            requestedById: true, approverCompanyId: true, status: true,
            createdAt: true, requestedBy: { select: { name: true } },
          },
        },
      },
    });
    if (!freight) throw new NotFoundException('Flete no encontrado');
    return freight;
  }

  // ======================== ASSIGN ===================================

  async assign(freightId: string, dto: AssignFreightDto, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    const isTransporter = await this.hasCompanyType(user, 'transporter');
    const isProducer = await this.hasCompanyType(user, 'producer');
    if (!isPlant && !isTransporter && !isProducer) {
      throw new ForbiddenException('Sin permisos para asignar transportista');
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

    let result: { updated: any; freight: any; bothConsulta: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        // Read freight INSIDE transaction to prevent TOCTOU race
        const freight = await tx.freight.findUnique({
          where: { id: freightId },
          include: { conversation: { select: { id: true } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');

        // Access check by company type
        if (isPlant && !isTransporter && !isProducer) {
          if (!freight.destCompanyId || !allIds.includes(freight.destCompanyId)) {
            throw new ForbiddenException('Solo la planta destino del flete puede asignar transportista');
          }
        } else if (isProducer && !isPlant && !isTransporter) {
          if (!allIds.includes(freight.originCompanyId) || !freight.useOwnFleet) {
            throw new ForbiddenException('Solo el productor origen con flota propia puede asignar');
          }
        } else if (isTransporter && !isPlant && !isProducer) {
          const isParticipant = allIds.includes(freight.originCompanyId) ||
            (freight.destCompanyId && allIds.includes(freight.destCompanyId));
          if (!isParticipant) {
            throw new ForbiddenException('Sin acceso a este flete');
          }
        }
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

        // Check if transporter is CONSULTA (READONLY) — requires truck, auto-accepts
        // Use both destCompanyId and caller's company as potential grantors
        let isConsultaTransporter = false;
        const plantCompanyId = user.activeCompanyId || user.companyId;
        const grantorCandidates = [...new Set([freight.destCompanyId, plantCompanyId].filter(Boolean))];
        if (grantorCandidates.length > 0) {
          const transportAccess = await tx.companyAccess.findFirst({
            where: {
              grantorCompanyId: { in: grantorCandidates },
              granteeCompanyId: dto.transportCompanyId,
              isActive: true,
              accessLevel: 'READONLY',
            },
          });
          if (transportAccess) {
            isConsultaTransporter = true;
            if (!dto.truckId) {
              throw new BadRequestException('Para transportista CONSULTA, camión es obligatorio');
            }
          }
        }
        this.logger.log(`assign: freight=${freightId} transporter=${dto.transportCompanyId} isConsulta=${isConsultaTransporter} hasTruck=${!!dto.truckId} grantors=${JSON.stringify(grantorCandidates)}`);

        // Block assignment on terminal states
        if (freight.status === FreightStatus.finished || freight.status === FreightStatus.canceled) {
          throw new BadRequestException('No se puede asignar en un flete finalizado o cancelado');
        }

        const hasTruck = !!dto.truckId;
        // For early states, compute target status normally. For later states, keep current status.
        const isEarlyState = ['pending_assignment', 'assigned'].includes(freight.status);
        const targetFreightStatus = isEarlyState
          ? ((hasTruck || isConsultaTransporter) ? FreightStatus.accepted : FreightStatus.assigned)
          : freight.status as FreightStatus;

        // Only cancel existing assignments if in early state (reasignment flow)
        if (isEarlyState) {
          await tx.freightAssignment.updateMany({
            where: { freightId, status: { in: ['active', 'accepted'] } },
            data: { status: AssignmentStatus.canceled, reason: 'Reasignado' },
          });
        }

        const assignData: any = {
          freightId,
          transportCompanyId: dto.transportCompanyId,
          status: hasTruck ? AssignmentStatus.accepted : AssignmentStatus.active,
          assignedById: user.sub,
        };
        if (dto.truckId) {
          // Check both companyId and ownerCompanyId — plant-created trucks for CONSULTA transporters
          // have companyId=plant but ownerCompanyId=transporter
          const truck = await tx.truck.findFirst({
            where: {
              id: dto.truckId,
              active: true,
              OR: [
                { companyId: dto.transportCompanyId },
                { ownerCompanyId: dto.transportCompanyId },
              ],
            },
          });
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
          // Lock driver's active assignments to prevent concurrent duplicate queuePositions
          await tx.$queryRaw`
            SELECT fa.id
            FROM "freight_assignments" fa
            JOIN "freights" f ON f.id = fa."freight_id"
            WHERE fa."driver_id"::text = ${dto.driverId}
              AND fa.status IN ('active','accepted')
              AND f.status IN ('assigned','accepted','in_progress','loaded')
            FOR UPDATE OF fa`;
          const maxRows: any[] = await tx.$queryRaw`
            SELECT COALESCE(MAX(fa."queue_position"), 0) AS "maxPos"
            FROM "freight_assignments" fa
            JOIN "freights" f ON f.id = fa."freight_id"
            WHERE fa."driver_id"::text = ${dto.driverId}
              AND fa.status IN ('active','accepted')
              AND f.status IN ('assigned','accepted','in_progress','loaded')`;
          assignData.queuePosition = (maxRows[0]?.maxPos ?? 0) + 1;
        }
        // For multi-truck (single-truck assign): set tripStatus based on truck presence
        if ((freight as any).isMultiTruck) {
          assignData.tripStatus = hasTruck ? 'accepted' : 'pending';
          assignData.tripNumber = 1;
        }
        const assignment = await tx.freightAssignment.create({ data: assignData });

        let finalFreightStatus: FreightStatus = targetFreightStatus;
        let bothConsulta = false;

        // Check if BOTH producer and transporter are CONSULTA (READONLY)
        // When both are CONSULTA, auto-complete: accepted → in_progress → loaded
        if (isConsultaTransporter && grantorCandidates.length > 0) {
          const producerCid = freight.producerCompanyId || freight.originCompanyId;
          // Producer is CONSULTA if plant has READONLY access grant to producer
          const producerIsPlant = grantorCandidates.includes(producerCid);
          const producerAccess = !producerIsPlant
            ? await tx.companyAccess.findFirst({
                where: {
                  grantorCompanyId: { in: grantorCandidates },
                  granteeCompanyId: producerCid,
                  isActive: true,
                  accessLevel: 'READONLY',
                },
              })
            : null;
          bothConsulta = !!producerAccess;
          this.logger.log(`assign: bothConsulta=${bothConsulta} producerCid=${producerCid} producerIsPlant=${producerIsPlant}`);
        }

        const now = new Date();
        const freightUpdateData: any = { status: finalFreightStatus };

        if (bothConsulta) {
          // Auto-complete intermediate steps: accepted → in_progress → loaded
          finalFreightStatus = FreightStatus.loaded;
          freightUpdateData.status = finalFreightStatus;
          freightUpdateData.startedAt = now;
          freightUpdateData.loadedAt = now;
          // Pre-set transporter finished confirmation so plant only needs to confirm once
          freightUpdateData.transporterFinishedConfirmedAt = now;

          // Update assignment tripStatus to loaded
          await tx.freightAssignment.update({
            where: { id: assignment.id },
            data: { tripStatus: 'loaded', startedAt: now, loadedAt: now, transporterFinishedConfirmedAt: now },
          });
        }

        const updated = await tx.freight.update({
          where: { id: freightId },
          data: freightUpdateData,
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
          // Invalidate SSE participants cache so new transporter receives real-time events
          this.sse.invalidateParticipantsCache(freight.conversation.id);
        }

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            freightId: freightId,
            action: 'assigned',
            fromValue: freight.status,
            toValue: targetFreightStatus,
            userId: user.sub,
            metadata: { transportCompanyId: dto.transportCompanyId, assignmentId: assignment.id },
          },
        });

        // Log auto-completed steps if both CONSULTA
        if (bothConsulta) {
          await tx.auditLog.create({
            data: {
              entityType: 'freight', entityId: freightId, freightId,
              action: 'auto_started',
              fromValue: 'accepted', toValue: 'in_progress',
              userId: user.sub,
              metadata: { autoCompleted: true, reason: 'both_consulta' },
            },
          });
          await tx.auditLog.create({
            data: {
              entityType: 'freight', entityId: freightId, freightId,
              action: 'auto_loaded',
              fromValue: 'in_progress', toValue: 'loaded',
              userId: user.sub,
              metadata: { autoCompleted: true, reason: 'both_consulta' },
            },
          });
          await tx.auditLog.create({
            data: {
              entityType: 'freight', entityId: freightId, freightId,
              action: 'auto_transporter_confirmed',
              fromValue: 'loaded', toValue: 'loaded',
              userId: user.sub,
              metadata: { autoCompleted: true, reason: 'both_consulta', confirmedBy: 'transporter' },
            },
          });
        }

        return { updated, freight, bothConsulta };
      }, { timeout: 15000 });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assign() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new InternalServerErrorException('Error al asignar transportista. Intente nuevamente.');
    }

    this.logger.log(`assign: completed freight=${freightId} finalStatus=${result.updated.status} bothConsulta=${result.bothConsulta} truckId=${result.updated.truckId ?? 'none'}`);

    // Notifications: if both CONSULTA, send single consolidated notification (no intermediate spam)
    if (result.bothConsulta) {
      this.notifyAllParticipants(
        result.freight, [{ transportCompanyId: dto.transportCompanyId }],
        NotificationType.freight_assigned,
        'Flete asignado y en espera de entrega',
        `${result.freight.code} → ${result.freight.destName || 'destino'} · Pasos intermedios completados automáticamente`,
        user.sub,
      );
    } else {
      // Normal assignment notification
      this.notifyAllParticipants(
        result.freight, [{ transportCompanyId: dto.transportCompanyId }],
        NotificationType.freight_assigned,
        'Transportista asignado',
        `${result.freight.code} → ${result.freight.destName || 'destino'}`,
        user.sub,
        new Set([dto.transportCompanyId]),
      );
    }

    // Notify driver personally if assigned
    if (dto.driverId) {
      this.notifications.notify(
        dto.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${result.freight.code} → ${result.freight.destName || 'destino'}`,
        freightId,
      );
    }

    // SSE (also refreshes participantCompanyIds)
    this.broadcastAndInvalidate(freightId, { id: freightId, code: result.freight.code, status: result.updated.status }, user.sub);

    return result.updated;
  }

  // ======================== RESPOND (accept/reject) ===================

  async respond(freightId: string, dto: RespondAssignmentDto, user: any) {
    // Accept is no longer valid — assignments are accepted by assigning truck+driver via updateAssignment
    if (dto.action === 'accepted') {
      throw new BadRequestException('Los viajes se aceptan automáticamente al asignar camión y chofer. Usá el endpoint PATCH /assignments/:id para asignar.');
    }

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
          include: { assignments: { where: { status: { in: ['active', 'accepted'] } } } },
        });
        if (!freight) throw new NotFoundException('Flete no encontrado');
        if ((freight as any).isMultiTruck) throw new BadRequestException('Para fletes multi-camión, usar endpoints multi-truck');

        const assignment = freight.assignments[0];
        if (!assignment || (!allIds.includes(assignment.transportCompanyId) && assignment.driverId !== user.sub)) {
          throw new ForbiddenException('Tu empresa no está asignada a este flete');
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
      this.broadcastAndInvalidate(freightId, { id: freightId, code: result.freight.code, status: 'pending_assignment' }, user.sub);

      return result.updated;
    }

    // No other action paths — reject is the only valid action
    throw new BadRequestException('Acción no válida');
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
          ...(freight.assignments || []).map(a => a.transportCompanyId)].filter(Boolean);
        if (!allIds.some(id => involved.includes(id))) {
          throw new ForbiddenException('No tenés acceso a este flete');
        }
      }
    }

    let ct = await this.resolveCompanyType(user);

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
      // Plant-centric: plant can start freight on behalf of CONSULTA transporter
      if (ct === 'plant' && freight.destCompanyId) {
        const callerIds = await this.resolveAllCompanyIds(user);
        if (callerIds.includes(freight.destCompanyId)) {
          const transporterCo = freight.assignments?.[0]?.transportCompanyId;
          if (transporterCo) {
            const access = await this.prisma.companyAccess.findFirst({
              where: { grantorCompanyId: freight.destCompanyId, granteeCompanyId: transporterCo, isActive: true, accessLevel: 'READONLY' },
            });
            if (access) ct = 'transporter'; // Plant acts as transporter for CONSULTA
          }
        }
      }
      const effectiveType = ct === 'producer' && isOwnFleet ? 'transporter' : ct;

      this.stateMachine.validateTransition(freight.status, FreightStatus.in_progress, effectiveType);

      // Require truck+driver before starting
      const activeAssignment = freight.assignments?.[0];
      if (!activeAssignment?.truckId) {
        throw new BadRequestException('El flete no tiene camión asignado. Asigná camión y chofer antes de iniciar.');
      }
      if (!activeAssignment?.driverId) {
        throw new BadRequestException('El flete no tiene chofer asignado. Asigná chofer antes de iniciar.');
      }

      // Check truck availability — only block if in_progress or loaded (accepted elsewhere is OK)
      const busyAssignment = await tx.freightAssignment.findFirst({
        where: {
          truckId: activeAssignment.truckId,
          tripStatus: { in: ['in_progress', 'loaded'] },
          freightId: { not: freightId },
        },
        include: { freight: { select: { code: true } } },
      });
      if (busyAssignment) {
        throw new BadRequestException(
          `El camión ${activeAssignment.plate || ''} está en otro viaje en curso (flete ${busyAssignment.freight.code}). Debe finalizar ese viaje antes de iniciar este.`,
        );
      }

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
      'Flete a campo',
      `${freight.code} inició el viaje`,
      user.sub,
    );

    // SSE
    this.broadcastAndInvalidate(freightId, { id: freightId, code: freight.code, status: 'in_progress' }, user.sub);

    return startResult;
  }

  // ======================== CONFIRM LOADED ============================

  async confirmLoaded(freightId: string, user: any, loadedTons?: number) {
    if (user.role === 'chofer') await this.assertDriverAccess(freightId, user.sub);

    let ct = await this.resolveCompanyType(user);

    // Plant-centric: plant can confirm loaded on behalf of CONSULTA transporter
    let plantActingAsTransporter = false;
    if (ct === 'plant') {
      const freight = await this.prisma.freight.findUnique({
        where: { id: freightId },
        select: { destCompanyId: true, assignments: { where: { status: { in: ['active', 'accepted'] } }, select: { transportCompanyId: true } } },
      });
      if (freight?.destCompanyId) {
        const callerIds = await this.companyRes.resolveAllCompanyIds(user);
        if (callerIds.includes(freight.destCompanyId)) {
          const transporterCo = freight.assignments?.[0]?.transportCompanyId;
          if (transporterCo) {
            const access = await this.prisma.companyAccess.findFirst({
              where: { grantorCompanyId: freight.destCompanyId, granteeCompanyId: transporterCo, isActive: true, accessLevel: 'READONLY' },
            });
            if (access) { ct = 'transporter'; plantActingAsTransporter = true; }
          }
        }
      }
    }

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
          if (!hasActiveAssignment && !plantActingAsTransporter) {
            throw new ForbiddenException('No sos el transportista asignado a este flete');
          }

          if (freight.status !== FreightStatus.in_progress) {
            throw new BadRequestException(
              `Solo se puede confirmar carga en estado "in_progress". Estado actual: "${freight.status}"`,
            );
          }
          if (freight.transporterLoadedConfirmedAt) {
            throw new BadRequestException('El transportista ya confirmó la carga');
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
          throw new BadRequestException('El productor ya confirmó la carga');
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

      this.broadcastAndInvalidate(freightId, { id: freightId, code: loadedResult.freight.code, status: loadedResult.updated.status }, user.sub);

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
          throw new BadRequestException(`Solo se puede confirmar finalización en estado "loaded". Estado actual: "${freight.status}"`);
        }
        if (freight.transporterFinishedConfirmedAt) {
          throw new BadRequestException('El transportista ya confirmó la entrega');
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
      this.broadcastAndInvalidate(freightId, { id: freightId, code: tFinishResult.freight.code, status: tFinishResult.plantAlsoConfirmed ? 'finished' : 'loaded' }, user.sub);

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
          throw new BadRequestException(`Solo se puede confirmar finalización en estado "loaded". Estado actual: "${freight.status}"`);
        }
        if (freight.plantFinishedConfirmedAt) {
          throw new BadRequestException('La planta ya confirmó la recepción');
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
      this.broadcastAndInvalidate(freightId, { id: freightId, code: pFinishResult.freight.code, status: pFinishResult.transporterAlsoConfirmed ? 'finished' : 'loaded' }, user.sub);

      return pFinishResult.updated;
    }

    throw new ForbiddenException('Solo transportista o planta pueden confirmar finalización');
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
        throw new BadRequestException('No se puede cancelar un flete a campo o a planta');
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
    this.broadcastAndInvalidate(freightId, { id: freightId, code: cancelResult.freight.code, status: 'canceled' }, user.sub);

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
            select: { id: true, transportCompanyId: true, truckId: true, driverId: true, status: true, tripStatus: true },
          },
        },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (!freight.destCompanyId || !allIdsAuth.includes(freight.destCompanyId)) {
        throw new ForbiddenException('Solo la planta destino puede autorizar este flete');
      }
      // Accept both assigned (legacy) and pending_assignment (Flow C: producer own fleet pending approval)
      if (freight.status !== FreightStatus.assigned && freight.status !== FreightStatus.pending_assignment) {
        throw new BadRequestException('El flete no está en estado que requiera autorización');
      }

      // Upgrade all active assignments that have trucks to accepted (producer own fleet Flow C)
      // Use updateMany with status filter for optimistic locking (prevents race conditions)
      const upgradeResult = await tx.freightAssignment.updateMany({
        where: { freightId: freight.id, status: AssignmentStatus.active, truckId: { not: null } },
        data: { status: AssignmentStatus.accepted },
      });
      if (upgradeResult.count === 0 && freight.assignments.some((a: any) => a.status === 'active' && a.truckId)) {
        this.logger.warn(`No active assignments to authorize for freight ${freight.id} — possible race condition`);
      }
      // Also upgrade tripStatus for pending trips
      await tx.freightAssignment.updateMany({
        where: { freightId: freight.id, status: AssignmentStatus.accepted, tripStatus: 'pending' },
        data: { tripStatus: 'accepted' },
      });

      // Determine final freight status based on whether all assignments have trucks
      const allHaveTrucks = freight.assignments.every((a: any) => a.truckId);
      const finalStatus = allHaveTrucks ? FreightStatus.accepted : FreightStatus.assigned;

      const updated = await tx.freight.update({
        where: { id: freightId },
        data: { status: finalStatus },
      });

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: 'authorized',
          fromValue: freight.status,
          toValue: finalStatus,
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

    this.broadcastAndInvalidate(freightId, { id: freightId, code: freight.code, status: 'accepted' }, user.sub);

    return updated;
  }

  // ======================== UPDATE FREIGHT ==============================

  private readonly FREIGHT_INCLUDE = {
    items: true,
    originLot: { select: { id: true, name: true } },
    destPlant: { select: { id: true, name: true } },
    originCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
    destCompany: { select: { id: true, name: true, hasInternalFleet: true, types: true } },
    producerCompany: { select: { id: true, name: true } },
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
    dto: { loadDate?: string; loadTime?: string; notes?: string; useOwnFleet?: boolean; destPlantId?: string; truckId?: string; driverId?: string; customDestName?: string; customDestLat?: number; customDestLng?: number; truckCount?: number },
    user: any,
  ) {
    if (user.role === 'chofer') throw new ForbiddenException('Los choferes no pueden editar fletes');

    const allIds = await this.resolveAllCompanyIds(user);

    try {
    return await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({
        where: { id: freightId },
        include: { assignments: { where: { status: { in: [AssignmentStatus.active, AssignmentStatus.accepted] } } }, items: { select: { tons: true } } },
      });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      // Compute actual assigned count from active assignments (not stale field)
      const actualAssignedCount = freight.assignments.length;
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

      const isOriginCompany = allIds.includes(freight.originCompanyId);

      // --- loadDate / loadTime: only origin company, only in pending_assignment ---
      if (dto.loadDate || dto.loadTime !== undefined) {
        if (!isOriginCompany) {
          throw new ForbiddenException('Solo la empresa de origen puede editar fecha y hora de carga');
        }
        if (freight.status !== FreightStatus.pending_assignment) {
          throw new BadRequestException('Fecha y hora solo se pueden editar en estado pendiente de asignación');
        }
        if (dto.loadDate) {
          const parsedLoadDate = new Date(dto.loadDate);
          if (isNaN(parsedLoadDate.getTime())) {
            throw new BadRequestException('Fecha de carga inválida');
          }
          // Reasonable date range check: not more than 1 year in the future
          const maxDate = new Date();
          maxDate.setFullYear(maxDate.getFullYear() + 1);
          if (parsedLoadDate > maxDate) {
            throw new BadRequestException('Fecha demasiado lejana (máximo 1 año)');
          }
          data.loadDate = parsedLoadDate;
          data.scheduledAt = new Date(`${dto.loadDate}T${dto.loadTime || freight.loadTime || '08:00'}:00`);
        }
        if (dto.loadTime !== undefined) data.loadTime = dto.loadTime;
      }

      // --- notes: origin company only, any non-terminal status ---
      if (dto.notes !== undefined) {
        if (!isOriginCompany) {
          throw new ForbiddenException('Solo la empresa de origen puede editar notas');
        }
        data.notes = dto.notes;
      }

      // --- truckCount: origin company or dest plant, must be >= assigned count ---
      if (dto.truckCount !== undefined && dto.truckCount !== freight.truckCount) {
        if (!isOriginCompany && (!freight.destCompanyId || !allIds.includes(freight.destCompanyId))) {
          throw new ForbiddenException('Solo la empresa de origen o destino puede editar la cantidad de camiones');
        }
        if (dto.truckCount < actualAssignedCount) {
          throw new BadRequestException(`No se puede reducir a ${dto.truckCount} camiones: ya hay ${actualAssignedCount} asignados`);
        }
        data.truckCount = dto.truckCount;
        data.isMultiTruck = dto.truckCount > 1;
      }

      // --- useOwnFleet ---
      if (dto.useOwnFleet !== undefined && dto.useOwnFleet !== freight.useOwnFleet) {
        const hasActiveAssignments = freight.assignments.length > 0;
        if (!hasActiveAssignments || !freight.destCompanyId) {
          // No active assignments or no counter-party → apply directly
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
              approverCompanyId: freight.destCompanyId,
            },
          });
          pendingChangeCreated = true;
          // Notify approver company
          const approverCompanyId = freight.destCompanyId;
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
          // Capacity warning (non-blocking — business may assign undersized trucks)
          if (truck.capacity && freight.items?.length > 0) {
            const requiredTons = freight.items.reduce((s: number, i: any) => s + (Number(i.tons) || 0), 0);
            const truckCapacity = parseFloat(truck.capacity) || 0;
            if (truckCapacity > 0 && requiredTons > truckCapacity) {
              this.logger.warn(`Truck ${truck.plate} capacity ${truckCapacity}t < required ${requiredTons}t for freight ${freight.code}`);
            }
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
          data.status = FreightStatus.accepted;
          // Recompute from DB to avoid stale count
          const ownFleetCount = await tx.freightAssignment.count({ where: { freightId, status: { in: ['active', 'accepted'] } } });
          data.assignedTruckCount = ownFleetCount;
        }
      }

      // --- destPlantId (may be a Plant ID or Company ID from catalog) ---
      if (dto.destPlantId && dto.destPlantId !== freight.destPlantId && dto.destPlantId !== freight.destCompanyId) {
        // Try Plant table first, then Company table (producers select companies as destinations)
        let resolvedDest: { plantId: string | null; companyId: string; name: string; lat: any; lng: any };
        const plant = await tx.plant.findFirst({
          where: { id: dto.destPlantId, active: true, company: { active: true } },
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
        this.broadcastAndInvalidate(freightId, { id: updated.id, code: updated.code, status: updated.status });
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

      this.broadcastAndInvalidate(freightId, { id: updated.id, code: updated.code, status: updated.status });
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
      const isAdmin = user.role === 'platform_admin' || user.isSuperAdmin;
      if (!isAdmin) {
        // Resolve all companies: memberships + companyId + companyByType
        const callerCompanies = await this.companyRes.resolveAllCompanyIds(user);
        if (!callerCompanies.includes(companyId)) {
          this.logger.warn(`getAvailableDrivers access denied: user=${user.sub} jwt.companyId=${user.companyId} requested=${companyId} resolvedIds=${JSON.stringify(callerCompanies)}`);
          throw new ForbiddenException('No tiene acceso a los choferes de esta empresa');
        }
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
    if (!freight) return FreightStatus.pending_assignment;
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
    // When assignments are lost (canceled/rejected), allow regression to pending_assignment
    // This handles: all removed, or some canceled reducing below truckCount
    if (assignments.length === 0) return applyMonotonicGuard(FreightStatus.pending_assignment, true);
    if (assignments.length < truckCount) return applyMonotonicGuard(FreightStatus.pending_assignment, true);

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
    const isTransporter = await this.hasCompanyType(user, 'transporter');
    const isProducer = await this.hasCompanyType(user, 'producer');
    if (!isPlant && !isTransporter && !isProducer) throw new ForbiddenException('Sin permisos para asignar transportistas');

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

        // Access check: plant must be dest company, producer must be origin with own fleet, transporter must be assigned
        if (isPlant && !isTransporter && !isProducer) {
          if (!freight.destCompanyId || !allIdsAm.includes(freight.destCompanyId)) {
            throw new ForbiddenException('Solo la planta destino del flete puede asignar transportistas');
          }
        } else if (isProducer && !isPlant && !isTransporter) {
          if (!allIdsAm.includes(freight.originCompanyId) || !freight.useOwnFleet) {
            throw new ForbiddenException('Solo el productor origen con flota propia puede asignar');
          }
        } else if (isTransporter && !isPlant && !isProducer) {
          const isParticipant = allIdsAm.includes(freight.originCompanyId) ||
            (freight.destCompanyId && allIdsAm.includes(freight.destCompanyId));
          if (!isParticipant) {
            throw new ForbiddenException('Sin acceso a este flete');
          }
        }

        if (['finished', 'canceled'].includes(freight.status)) {
          throw new BadRequestException('No se puede asignar en un flete finalizado o cancelado');
        }

        const existingAssignments = await (tx.freightAssignment as any).findMany({
          where: { freightId, status: { in: ['active', 'accepted'] } },
          select: { tons: true },
        });
        const existingCount = existingAssignments.length;

        if (dto.trucks.length > 20) {
          throw new BadRequestException('Máximo 20 camiones por asignación');
        }

        // Validate truckCount limit
        if (freight.isMultiTruck && freight.truckCount && existingCount + dto.trucks.length > freight.truckCount) {
          throw new BadRequestException(
            `El flete permite ${freight.truckCount} camiones, ya tiene ${existingCount} asignados. Solo puede agregar ${freight.truckCount - existingCount} más.`,
          );
        }

        // Use MAX(tripNumber) to avoid collisions with canceled assignments
        const maxTripRow: any[] = await tx.$queryRaw`
          SELECT COALESCE(MAX("trip_number"), 0) AS "maxTn"
          FROM "freight_assignments"
          WHERE "freight_id"::text = ${freightId}`;
        let tripNumber = maxTripRow[0]?.maxTn ?? existingCount;

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

          // Check CONSULTA transporter auto-accept
          let isConsultaAm = false;
          if (freight.destCompanyId) {
            const taAccess = await tx.companyAccess.findFirst({
              where: {
                grantorCompanyId: freight.destCompanyId,
                granteeCompanyId: truck.transportCompanyId,
                isActive: true,
                accessLevel: 'READONLY',
              },
            });
            if (taAccess) {
              isConsultaAm = true;
              if (!truck.truckId) {
                throw new BadRequestException('Para transportista CONSULTA, camión es obligatorio');
              }
            }
          }

          const hasTruckAm = !!truck.truckId || isConsultaAm;
          const assignData: any = {
            freightId,
            transportCompanyId: truck.transportCompanyId,
            status: hasTruckAm ? AssignmentStatus.accepted : AssignmentStatus.active,
            assignedById: user.sub,
            tripNumber,
            tripStatus: hasTruckAm ? 'accepted' : 'pending',
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
            // Lock driver's active assignments to prevent concurrent duplicate queuePositions
            await tx.$queryRaw`
              SELECT fa.id
              FROM "freight_assignments" fa
              JOIN "freights" f ON f.id = fa."freight_id"
              WHERE fa."driver_id"::text = ${truck.driverId}
                AND fa.status IN ('active','accepted')
                AND f.status IN ('assigned','accepted','in_progress','loaded')
              FOR UPDATE OF fa`;
            const maxRows: any[] = await tx.$queryRaw`
              SELECT COALESCE(MAX(fa."queue_position"), 0) AS "maxPos"
              FROM "freight_assignments" fa
              JOIN "freights" f ON f.id = fa."freight_id"
              WHERE fa."driver_id"::text = ${truck.driverId}
                AND fa.status IN ('active','accepted')
                AND f.status IN ('assigned','accepted','in_progress','loaded')`;
            assignData.queuePosition = (maxRows[0]?.maxPos ?? 0) + 1;
          }

          await tx.freightAssignment.create({ data: assignData });

          if (freight.conversation?.id) {
            await tx.conversationParticipant.upsert({
              where: { conversationId_companyId: { conversationId: freight.conversation.id, companyId: truck.transportCompanyId } },
              create: { conversationId: freight.conversation.id, companyId: truck.transportCompanyId },
              update: {},
            });
            // Invalidate SSE participants cache so new transporter receives real-time events
            this.sse.invalidateParticipantsCache(freight.conversation.id);
          }
        }

        // Recompute count from DB to avoid race conditions with concurrent assignments
        const activeCount = await tx.freightAssignment.count({ where: { freightId, status: { in: ['active', 'accepted'] } } });
        const newStatus = await this.deriveFreightStatus(tx, freightId);
        const updated = await tx.freight.update({
          where: { id: freightId },
          data: { status: newStatus, assignedTruckCount: activeCount, isMultiTruck: true } as any,
        });

        await tx.auditLog.create({
          data: {
            entityType: 'freight',
            entityId: freightId,
            action: 'assigned_multi',
            fromValue: freight.status,
            toValue: newStatus,
            userId: user.sub,
            metadata: { trucksAssigned: dto.trucks.length, totalAssigned: activeCount },
          },
        });

        return { updated, freight };
      }, { timeout: 15000 });
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException || err instanceof NotFoundException) throw err;
      this.logger.error(`assignMulti() failed for freight ${freightId}: ${err.message}`, err.stack);
      throw new BadRequestException('Error al asignar camiones. Intente nuevamente.');
    }

    // Notify all participants about multi-truck assignment (auto-accepted)
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
    this.broadcastAndInvalidate(freightId, { id: freightId, code: result.freight.code, status: result.updated.status }, user.sub);
    return result.updated;
  }

  async assignTruck(freightId: string, dto: TruckAssignmentDto, user: any) {
    return this.assignMulti(freightId, { trucks: [dto] }, user);
  }

  async cancelAssignment(freightId: string, assignmentId: string, reason: string, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    const isProducer = await this.hasCompanyType(user, 'producer');
    if (!isPlant && !isProducer) throw new ForbiddenException('Solo la planta o productor pueden cancelar asignaciones');

    const allIdsCa = await this.resolveAllCompanyIds(user);

    const { result, freight } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      // Plants: must be dest company. Producers: must be origin company.
      const isDestCompany = freight.destCompanyId && allIdsCa.includes(freight.destCompanyId);
      const isOriginCompany = allIdsCa.includes(freight.originCompanyId);
      if (isPlant && !isDestCompany) {
        throw new ForbiddenException('Solo la planta destino puede cancelar asignaciones');
      }
      if (isProducer && !isPlant && !isOriginCompany) {
        throw new ForbiddenException('Solo el productor de origen puede cancelar asignaciones de su flota');
      }
      if (!(freight as any).isMultiTruck) throw new BadRequestException('Para fletes single-truck, usar endpoint cancel');

      const assignment = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada o ya cancelada');

      // Producers can only cancel their own-fleet assignments
      if (isProducer && !isPlant) {
        const isOwnFleetAssignment = assignment.transportCompanyId === freight.originCompanyId;
        if (!isOwnFleetAssignment) {
          throw new ForbiddenException('Solo puede cancelar asignaciones de su propia flota');
        }
      }

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
          NotificationType.freight_updated,
          'Asignación cancelada',
          `${freight.code}: ${reason || 'Cancelado por planta'}`,
          freightId,
          user.sub,
        );
      }
    }

    this.broadcastAndInvalidate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub);
    return result;
  }

  async updateAssignment(freightId: string, assignmentId: string, dto: { transportCompanyId?: string; truckId?: string | null; driverId?: string | null; tons?: number }, user: any) {
    const isPlant = await this.hasCompanyType(user, 'plant');
    const isTransporter = await this.hasCompanyType(user, 'transporter');
    const isProducer = await this.hasCompanyType(user, 'producer');
    if (!isPlant && !isTransporter && !isProducer) throw new ForbiddenException('Solo la planta, el transportista o el productor pueden editar asignaciones');

    const allIdsUa = await this.resolveAllCompanyIds(user);

    const { updated, freight: freshFreight, statusUpgraded } = await this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');

      // Plant: must be dest company. Transporter: checked below against assignment.
      if (isPlant && !isTransporter && !isProducer) {
        if (!freight.destCompanyId || !allIdsUa.includes(freight.destCompanyId)) {
          throw new ForbiddenException('Solo la planta destino puede editar asignaciones');
        }
      }

      // Producer with own fleet: must be origin company
      if (isProducer && !isPlant && !isTransporter) {
        if (!freight.originCompanyId || !allIdsUa.includes(freight.originCompanyId) || !freight.useOwnFleet) {
          throw new ForbiddenException('Solo el productor origen con flota propia puede editar asignaciones');
        }
      }

      const assignment: any = await (tx.freightAssignment as any).findFirst({
        where: { id: assignmentId, freightId, status: { in: ['active', 'accepted'] } },
      });
      if (!assignment) throw new NotFoundException('Asignación no encontrada');

      // Transporter: must own the assignment
      if (isTransporter && !isPlant && !isProducer) {
        if (!allIdsUa.includes(assignment.transportCompanyId)) {
          throw new ForbiddenException('No sos el transportista asignado a esta asignación');
        }
      }

      if (assignment.tripStatus && !['pending', 'accepted'].includes(assignment.tripStatus)) {
        throw new BadRequestException('No se puede modificar un viaje ya iniciado');
      }

      const updateData: any = {};

      // Only plant can change transportCompanyId
      if (dto.transportCompanyId && dto.transportCompanyId !== assignment.transportCompanyId) {
        if (!isPlant) throw new ForbiddenException('Solo la planta puede cambiar la empresa transportista');
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

      // Status upgrade: when truck+driver assigned to a pending assignment → accepted
      let statusUpgraded = false;
      const finalTruckId = updateData.truckId !== undefined ? updateData.truckId : assignment.truckId;
      const finalDriverId = updateData.driverId !== undefined ? updateData.driverId : assignment.driverId;
      if (finalTruckId && finalDriverId && assignment.status === AssignmentStatus.active) {
        updateData.status = AssignmentStatus.accepted;
        if (assignment.tripStatus === 'pending') {
          updateData.tripStatus = 'accepted';
        }
        statusUpgraded = true;
      }

      const result = await (tx.freightAssignment as any).update({
        where: { id: assignmentId },
        data: updateData,
        include: { transportCompany: { select: { id: true, name: true } }, truck: true, driver: { select: { id: true, name: true, phone: true } } },
      });

      // If status was upgraded, derive freight status
      let freightUpdate: any = freight;
      if (statusUpgraded && (freight as any).isMultiTruck) {
        const newStatus = await this.deriveFreightStatus(tx, freightId);
        if (newStatus !== freight.status) {
          freightUpdate = await tx.freight.update({ where: { id: freightId }, data: { status: newStatus } });
        }
      } else if (statusUpgraded && !((freight as any).isMultiTruck)) {
        // Single-truck: if assignment now has truck+driver → freight accepted
        if (freight.status === FreightStatus.assigned || freight.status === FreightStatus.pending_assignment) {
          freightUpdate = await tx.freight.update({ where: { id: freightId }, data: { status: FreightStatus.accepted } });
        }
      }

      await tx.auditLog.create({
        data: {
          entityType: 'freight',
          entityId: freightId,
          freightId: freightId,
          action: statusUpgraded ? 'assignment_truck_assigned' : 'assignment_updated',
          fromValue: statusUpgraded ? assignment.status : undefined,
          toValue: statusUpgraded ? 'accepted' : undefined,
          userId: user.sub,
          metadata: { assignmentId, changes: updateData },
        },
      });

      return { updated: result, freight: freightUpdate, statusUpgraded };
    });

    // Notify: if transporter assigned truck → notify plant; if plant edited → notify transporter
    if (statusUpgraded && freshFreight.destCompanyId) {
      this.notifications.notifyCompany(
        freshFreight.destCompanyId,
        NotificationType.freight_accepted,
        'Camión y chofer asignados',
        `${freshFreight.code}: ${updated.transportCompany?.name || 'Transportista'} asignó camión ${updated.plate || ''} (${updated.driverName || 'chofer'})`,
        freightId,
        user.sub,
      );
    } else if (updated.transportCompanyId && isPlant) {
      this.notifications.notifyCompany(
        updated.transportCompanyId,
        NotificationType.freight_updated,
        'Asignación actualizada',
        `${freshFreight.code}: se actualizó tu asignación`,
        freightId,
        user.sub,
      );
    }

    // Notify driver personally if assigned
    if (statusUpgraded && updated.driverId) {
      this.notifications.notify(
        updated.driverId, NotificationType.freight_assigned,
        'Te asignaron un flete',
        `${freshFreight.code} → ${freshFreight.destName || 'destino'}. Iniciá cuando estés listo.`,
        freightId,
      );
    }

    this.broadcastAndInvalidate(freightId, { id: freightId, code: freshFreight.code, status: freshFreight.status }, user.sub);
    return updated;
  }

  async respondTrip(freightId: string, assignmentId: string, dto: RespondTripDto, user: any) {
    // Accept is no longer valid — trips are accepted by assigning truck+driver via updateAssignment
    if (dto.action === 'accepted') {
      throw new BadRequestException('Los viajes se aceptan automáticamente al asignar camión y chofer. Usá el endpoint PATCH /assignments/:id para asignar.');
    }

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
      this.broadcastAndInvalidate(freightId, { id: freightId, code: rejectFreight.code, status: result.status }, user.sub);
      return result;
    }

    // No other action paths — reject is the only valid action
    throw new BadRequestException('Acción no válida');
  }

  async startTrip(freightId: string, assignmentId: string, user: any) {
    if (user.role === 'chofer') {
      const a = await this.prisma.freightAssignment.findFirst({
        where: { id: assignmentId, freightId, driverId: user.sub, status: { in: ['active', 'accepted'] } },
      });
      if (!a) throw new ForbiddenException('No sos el chofer asignado');
      // Verify driver's company membership matches the assignment's transport company
      const allIds = await this.resolveAllCompanyIds(user);
      if (!allIds.includes(a.transportCompanyId)) {
        throw new ForbiddenException('Driver not authorized for this transport company');
      }
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
      const isCallerTransporter = callerStIds.includes(assignment.transportCompanyId);
      // Plant-centric: plant can start trip for CONSULTA transporter
      const isPlantForConsulta = !isCallerTransporter
        && await this.isPlantActingForConsultaTransporter(user, freight.destCompanyId, assignment.transportCompanyId);
      if (!isCallerTransporter && !isPlantForConsulta) {
        throw new ForbiddenException('No sos el transportista asignado a este viaje');
      }

      this.stateMachine.validateTripTransition(assignment.tripStatus as any, 'in_progress' as any);

      // Require truck+driver before starting
      if (!assignment.truckId) {
        throw new BadRequestException('El viaje no tiene camión asignado. Asigná camión y chofer antes de iniciar.');
      }
      if (!assignment.driverId) {
        throw new BadRequestException('El viaje no tiene chofer asignado. Asigná chofer antes de iniciar.');
      }

      // Check truck availability — only block if in_progress or loaded (accepted elsewhere is OK)
      const busyAssignment = await (tx.freightAssignment as any).findFirst({
        where: {
          truckId: assignment.truckId,
          tripStatus: { in: ['in_progress', 'loaded'] },
          id: { not: assignmentId },
        },
        include: { freight: { select: { code: true } } },
      });
      if (busyAssignment) {
        throw new BadRequestException(
          `El camión ${assignment.plate || ''} está en otro viaje en curso (flete ${busyAssignment.freight.code}). Debe finalizar ese viaje antes de iniciar este.`,
        );
      }

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
      'Camión a campo',
      `${freight.code} — Camión #${assignment.tripNumber} inició viaje`,
      user.sub,
    );
    this.broadcastAndInvalidate(freightId, { id: freightId, code: freight.code, status: result.status }, user.sub);
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
        // Plant-centric: plant can confirm loaded for CONSULTA transporter
        if (ct === 'plant' && await this.isPlantActingForConsultaTransporter(user, freight.destCompanyId, assignment.transportCompanyId)) {
          ct = 'transporter';
        }

        if (ct === 'transporter') {
          const callerCtlIds = await this.resolveAllCompanyIds(user);
          // Allow plant acting for CONSULTA (callerCtlIds won't include transport company, but plant was promoted above)
          const isPlantProxy = !callerCtlIds.includes(assignment.transportCompanyId)
            && callerCtlIds.includes(freight.destCompanyId || '');
          if (!callerCtlIds.includes(assignment.transportCompanyId) && !isPlantProxy) {
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
          if (assignment.tripStatus !== 'loaded') throw new BadRequestException('El camión debe estar a planta para que el productor confirme');
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

        throw new ForbiddenException('Solo transportista, productor o planta con flota propia pueden confirmar carga');
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
      this.broadcastAndInvalidate(freightId, { id: freightId, code: (result as any).code, status: (result as any).status }, user.sub);
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
        throw new BadRequestException(`Solo se puede finalizar un camión a planta. Estado actual: ${assignment.tripStatus}`);
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
    this.broadcastAndInvalidate(freightId, { id: freightId, code: (result as any).code, status: (result as any).status }, user.sub);
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
        !isFinite(body.lat) || !isFinite(body.lng) ||
        body.lat < -90 || body.lat > 90 || body.lng < -180 || body.lng > 180) {
      throw new BadRequestException('Coordenadas inválidas (lat: -90..90, lng: -180..180)');
    }

    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId }, select: { status: true } });
      if (!freight) throw new NotFoundException('Flete no encontrado');
      if (freight.status !== FreightStatus.in_progress && freight.status !== FreightStatus.loaded) {
        throw new BadRequestException('Solo se puede trackear un flete a campo o a planta');
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
          ...(freight.assignments || []).map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = (freight.assignments || []).some(a => a.driverId === user.sub);
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

  async renameDocument(freightId: string, docId: string, name: string, user: any) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new BadRequestException('El nombre no puede estar vacío');
    }
    if (name.length > 255) {
      throw new BadRequestException('El nombre es demasiado largo (máx 255 caracteres)');
    }
    return this.prisma.$transaction(async (tx) => {
      const freight = await tx.freight.findUnique({ where: { id: freightId } });
      if (!freight) throw new NotFoundException('Flete no encontrado');

      const doc = await tx.freightDocument.findFirst({ where: { id: docId, freightId } });
      if (!doc) throw new NotFoundException('Documento no encontrado');

      await tx.freightDocument.update({ where: { id: docId }, data: { name: name.trim() } });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'document_renamed', userId: user.sub, metadata: { docId, oldName: doc.name, newName: name.trim() } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return { ok: true };
    });
  }

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
          ...(freight.assignments || []).map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = (freight.assignments || []).some(a => a.driverId === user.sub);
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

  async editOcrData(freightId: string, docId: string, ocrData: any, user: any) {
    // Validate ocrData shape
    if (!ocrData || typeof ocrData !== 'object' || Array.isArray(ocrData)) {
      throw new BadRequestException('ocrData debe ser un objeto JSON');
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
          ...(freight.assignments || []).map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = (freight.assignments || []).some(a => a.driverId === user.sub);
        const hasAccess = isDriver || allIds.some(id => freightCompanies.includes(id));
        if (!hasAccess) throw new ForbiddenException('No tiene acceso a este flete');
      }

      const doc = await tx.freightDocument.findFirst({ where: { id: docId, freightId } });
      if (!doc) throw new NotFoundException('Documento no encontrado');

      // Build history: save previous ocrData snapshot (without its own history to avoid bloat)
      const prevOcr = (doc.ocrData as any) || {};
      const prevHistory: any[] = Array.isArray(prevOcr._editHistory) ? prevOcr._editHistory : [];
      // Snapshot previous datos (exclude _editHistory and _editMeta to keep history lean)
      const { _editHistory: _h, _editMeta: _m, ...prevSnapshot } = prevOcr;
      const newHistory = [
        ...prevHistory.slice(-9), // Keep last 10 versions max
        { datos: prevSnapshot, editedAt: prevOcr._editMeta?.editedAt || doc.updatedAt?.toISOString(), editedBy: prevOcr._editMeta?.editedBy || null },
      ];

      // Merge edit metadata into ocrData
      const updatedOcrData = {
        ...ocrData,
        _editMeta: { editedAt: new Date().toISOString(), editedBy: user.sub, editedByName: user.name || null },
        _editHistory: newHistory,
      };

      await tx.freightDocument.update({
        where: { id: docId },
        data: { ocrData: updatedOcrData },
      });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'ocr_data_edited', userId: user.sub, metadata: { docId, docName: doc.name } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return { ok: true, editedAt: updatedOcrData._editMeta.editedAt };
    });
  }

  async clearOcrData(freightId: string, docId: string, user: any) {
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
          ...(freight.assignments || []).map(a => a.transportCompanyId)].filter(Boolean);
        const isDriver = (freight.assignments || []).some(a => a.driverId === user.sub);
        const hasAccess = isDriver || allIds.some(id => freightCompanies.includes(id));
        if (!hasAccess) throw new ForbiddenException('No tiene acceso a este flete');
      }

      const doc = await tx.freightDocument.findFirst({ where: { id: docId, freightId } });
      if (!doc) throw new NotFoundException('Documento no encontrado');

      await tx.freightDocument.update({
        where: { id: docId },
        data: { ocrData: Prisma.DbNull },
      });

      await tx.auditLog.create({
        data: { entityType: 'freight', entityId: freightId, freightId, action: 'ocr_data_cleared', userId: user.sub, metadata: { docId, docName: doc.name } },
      }).catch(e => this.logger.warn('Audit log failed: ' + e.message));

      return { ok: true };
    });
  }

  // ─── Stats by period ───────────────────────────────────────────
  async getStats(user: any, from?: string, to?: string, groupBy = 'week') {
    const companyIds = await this.resolveAllCompanyIds(user);
    const empty = { period: { from, to }, groupBy, overview: { totalFreights: 0, completedFreights: 0, canceledFreights: 0, inProgressFreights: 0, completionRate: 0, cancellationRate: 0, totalTons: 0, avgTonsPerFreight: 0, avgCompletionTimeHours: 0, totalTrips: 0, multiTruckFreights: 0 }, byStatus: {}, byGrain: [], byTransporter: [], byDestination: [], byOrigin: [], timeline: [], delays: { totalDelayed: 0, delayedPercentage: 0, avgDelayHours: 0, topDelayedRoutes: [] }, drivers: [] };
    if (!companyIds.length) return empty;

    const now = new Date();
    const dateFrom = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const dateTo = to ? new Date(to + 'T23:59:59') : now;
    const r = (n: number) => Math.round(n * 100) / 100;

    const freights = await this.prisma.freight.findMany({
      where: { participantCompanyIds: { hasSome: companyIds }, loadDate: { gte: dateFrom, lte: dateTo } },
      include: {
        items: true,
        field: { select: { id: true, name: true } },
        assignments: { include: { transportCompany: { select: { id: true, name: true } }, driver: { select: { id: true, name: true } }, truck: { select: { plate: true } } } },
      },
      take: 2000,
      orderBy: { loadDate: 'asc' },
    });

    // ── Aggregation maps ──
    const byStatus: Record<string, number> = {};
    const grainMap: Record<string, { count: number; tons: number }> = {};
    const transporterMap: Record<string, { name: string; count: number; tons: number; completedCount: number; rejectedCount: number; totalAssignments: number; responseTimes: number[] }> = {};
    const destMap: Record<string, { name: string; count: number; tons: number }> = {};
    const originMap: Record<string, { name: string; fieldId: string | null; count: number; tons: number }> = {};
    const driverMap: Record<string, { name: string; plate: string; trips: number; tons: number; dates: Set<string> }> = {};
    const completionTimes: number[] = [];
    let totalTons = 0, totalTrips = 0, multiTruckCount = 0;
    const delayed: { origin: string; dest: string; delayH: number }[] = [];

    for (const f of freights) {
      byStatus[f.status] = (byStatus[f.status] || 0) + 1;
      const fTons = f.items.reduce((s, i) => s + Number(i.tons || 0), 0);
      totalTons += fTons;
      if (f.isMultiTruck) multiTruckCount++;

      // Grain
      for (const it of f.items) {
        const g = it.grain || 'Otros';
        if (!grainMap[g]) grainMap[g] = { count: 0, tons: 0 };
        grainMap[g].count++;
        grainMap[g].tons += Number(it.tons || 0);
      }

      // Completion time
      if (f.status === 'finished' && f.finishedAt) {
        const h = (new Date(f.finishedAt).getTime() - new Date(f.createdAt).getTime()) / 3600000;
        if (h > 0 && h < 720) completionTimes.push(h);
      }

      // Delay detection
      const loadDT = new Date(`${new Date(f.loadDate).toISOString().split('T')[0]}T${f.loadTime || '00:00'}`);
      if (loadDT < now && ['pending_assignment', 'assigned', 'accepted'].includes(f.status)) {
        const delayH = (now.getTime() - loadDT.getTime()) / 3600000;
        delayed.push({ origin: f.originName, dest: f.destName, delayH });
      }

      // Transporters & drivers
      for (const a of f.assignments) {
        const tId = a.transportCompanyId;
        const tName = a.transportCompany?.name || 'Desconocido';
        if (!transporterMap[tId]) transporterMap[tId] = { name: tName, count: 0, tons: 0, completedCount: 0, rejectedCount: 0, totalAssignments: 0, responseTimes: [] };
        transporterMap[tId].totalAssignments++;
        if (a.status === 'rejected') transporterMap[tId].rejectedCount++;
        else { transporterMap[tId].count++; transporterMap[tId].tons += fTons; }
        if (a.tripStatus === 'finished') transporterMap[tId].completedCount++;

        // Response time (assigned → accepted/rejected)
        if ((a.status === 'accepted' || a.status === 'rejected') && a.updatedAt && a.createdAt) {
          const rt = (new Date(a.updatedAt).getTime() - new Date(a.createdAt).getTime()) / 3600000;
          if (rt >= 0 && rt < 168) transporterMap[tId].responseTimes.push(rt);
        }

        // Trips & drivers
        if (['accepted', 'in_progress', 'loaded', 'finished'].includes(a.tripStatus)) totalTrips++;
        if (a.driver) {
          const dId = a.driverId || a.driver.id;
          const plate = a.truck?.plate || a.plate || '';
          if (!driverMap[dId]) driverMap[dId] = { name: a.driver.name || a.driverName || 'Desconocido', plate, trips: 0, tons: 0, dates: new Set() };
          driverMap[dId].trips++;
          driverMap[dId].tons += Number(a.loadedTons || a.tons || 0);
          driverMap[dId].dates.add(new Date(f.loadDate).toISOString().split('T')[0]);
        }
      }

      // Destination
      const dKey = f.destName || 'Sin destino';
      if (!destMap[dKey]) destMap[dKey] = { name: dKey, count: 0, tons: 0 };
      destMap[dKey].count++; destMap[dKey].tons += fTons;

      // Origin
      const oKey = f.originName || 'Sin origen';
      if (!originMap[oKey]) originMap[oKey] = { name: oKey, fieldId: f.fieldId || null, count: 0, tons: 0 };
      originMap[oKey].count++; originMap[oKey].tons += fTons;
    }

    // ── Timeline ──
    const timeline: { period: string; label: string; count: number; tons: number; completed: number; canceled: number }[] = [];
    const bucketKey = (d: Date): string => {
      if (groupBy === 'day') return d.toISOString().split('T')[0];
      if (groupBy === 'week') { const mon = new Date(d); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7)); return mon.toISOString().split('T')[0]; }
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    };
    const bucketLabel = (key: string, idx: number): string => {
      if (groupBy === 'day') return key.slice(5);
      if (groupBy === 'week') return `Sem ${idx + 1}`;
      const [y, m] = key.split('-'); const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']; return months[parseInt(m) - 1] || key;
    };
    const tlMap: Record<string, { count: number; tons: number; completed: number; canceled: number }> = {};
    for (const f of freights) {
      const k = bucketKey(new Date(f.loadDate));
      if (!tlMap[k]) tlMap[k] = { count: 0, tons: 0, completed: 0, canceled: 0 };
      tlMap[k].count++;
      tlMap[k].tons += f.items.reduce((s, i) => s + Number(i.tons || 0), 0);
      if (f.status === 'finished') tlMap[k].completed++;
      if (f.status === 'canceled') tlMap[k].canceled++;
    }
    const sortedKeys = Object.keys(tlMap).sort();
    sortedKeys.forEach((k, i) => timeline.push({ period: k, label: bucketLabel(k, i), ...tlMap[k], tons: r(tlMap[k].tons) }));

    // ── Delays ──
    const delayRouteMap: Record<string, { origin: string; dest: string; delayedCount: number; totalDelay: number }> = {};
    for (const d of delayed) {
      const rk = `${d.origin}→${d.dest}`;
      if (!delayRouteMap[rk]) delayRouteMap[rk] = { origin: d.origin, dest: d.dest, delayedCount: 0, totalDelay: 0 };
      delayRouteMap[rk].delayedCount++; delayRouteMap[rk].totalDelay += d.delayH;
    }

    const finished = byStatus['finished'] || 0;
    const canceled = byStatus['canceled'] || 0;
    const inProgress = (byStatus['in_progress'] || 0) + (byStatus['loaded'] || 0) + (byStatus['accepted'] || 0) + (byStatus['assigned'] || 0);
    const avgCT = completionTimes.length > 0 ? r(completionTimes.reduce((a, b) => a + b, 0) / completionTimes.length) : 0;

    return {
      period: { from: dateFrom.toISOString().split('T')[0], to: dateTo.toISOString().split('T')[0] },
      groupBy,
      overview: {
        totalFreights: freights.length, completedFreights: finished, canceledFreights: canceled, inProgressFreights: inProgress,
        completionRate: finished + canceled > 0 ? r(finished / (finished + canceled)) : 0,
        cancellationRate: freights.length > 0 ? r(canceled / freights.length) : 0,
        totalTons: r(totalTons), avgTonsPerFreight: freights.length > 0 ? r(totalTons / freights.length) : 0,
        avgCompletionTimeHours: avgCT, totalTrips, multiTruckFreights: multiTruckCount,
      },
      byStatus,
      byGrain: Object.entries(grainMap).map(([grain, v]) => ({ grain, count: v.count, tons: r(v.tons), percentage: totalTons > 0 ? r((v.tons / totalTons) * 100) : 0, avgTons: v.count > 0 ? r(v.tons / v.count) : 0 })).sort((a, b) => b.tons - a.tons),
      byTransporter: Object.entries(transporterMap).map(([id, v]) => ({ id, name: v.name, count: v.count, tons: r(v.tons), completedCount: v.completedCount, avgResponseTimeHours: v.responseTimes.length > 0 ? r(v.responseTimes.reduce((a, b) => a + b, 0) / v.responseTimes.length) : 0, rejectionRate: v.totalAssignments > 0 ? r(v.rejectedCount / v.totalAssignments) : 0 })).sort((a, b) => b.count - a.count).slice(0, 15),
      byDestination: Object.values(destMap).map(d => ({ ...d, tons: r(d.tons), avgTons: d.count > 0 ? r(d.tons / d.count) : 0 })).sort((a, b) => b.count - a.count).slice(0, 15),
      byOrigin: Object.values(originMap).map(o => ({ ...o, tons: r(o.tons) })).sort((a, b) => b.count - a.count).slice(0, 15),
      timeline,
      delays: {
        totalDelayed: delayed.length,
        delayedPercentage: freights.length > 0 ? r((delayed.length / freights.length) * 100) : 0,
        avgDelayHours: delayed.length > 0 ? r(delayed.reduce((s, d) => s + d.delayH, 0) / delayed.length) : 0,
        topDelayedRoutes: Object.values(delayRouteMap).sort((a, b) => b.delayedCount - a.delayedCount).slice(0, 5).map(r2 => ({ ...r2, avgDelayHours: r(r2.totalDelay / r2.delayedCount) })),
      },
      drivers: Object.values(driverMap).map(d => ({ name: d.name, plate: d.plate, trips: d.trips, tons: r(d.tons), avgTripsPerDay: d.dates.size > 0 ? r(d.trips / d.dates.size) : 0 })).sort((a, b) => b.trips - a.trips).slice(0, 15),
    };
  }
}
