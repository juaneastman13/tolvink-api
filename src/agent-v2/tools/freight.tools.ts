import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { FreightsService } from '../../freights/freights.service';
import { CreateFreightSlots } from '../schemas/freight.schema';
import { AgentLocation } from '../schemas/agent-state.schema';

type CreateFreightExecutionInput = CreateFreightSlots & {
  originLocation?: AgentLocation | null;
  destinationLocation?: AgentLocation | null;
  idempotencyKey?: string;
};

export type CreateFreightToolResult = {
  status: 'created' | 'pre_request' | 'blocked_missing_location';
  code: string;
  id?: string;
  realExecution: boolean;
  durationMs?: number;
};

export type QueryFreightsInput = {
  dateFilter?: 'today' | 'tomorrow' | 'all';
  statusFilter?: string;
  freightCode?: string;
  limit?: number;
};

export type FreightListItem = {
  id: string;
  code: string;
  status: string;
  product?: string | null;
  tons?: number | null;
  origin?: string | null;
  destination?: string | null;
  date?: string | null;
  time?: string | null;
  transportCompany?: string | null;
  driver?: string | null;
  truck?: string | null;
  originCompanyId?: string | null;
  destCompanyId?: string | null;
  assignmentTransportCompanyId?: string | null;
  assignmentDriverId?: string | null;
  transporterFinishedConfirmedAt?: Date | string | null;
  plantFinishedConfirmedAt?: Date | string | null;
  producerLoadedConfirmedAt?: Date | string | null;
};

@Injectable()
export class AgentV2FreightTools {
  constructor(
    private prisma: PrismaService,
    private freights: FreightsService,
  ) {}

  async createFreightRequest(slots: CreateFreightExecutionInput, user: any): Promise<CreateFreightToolResult> {
    const started = Date.now();
    const realExecution = process.env.AGENT_V2_ENABLE_REAL_FREIGHT_CREATE === 'true';
    const code = `V2-${Date.now().toString().slice(-6)}`;

    await this.audit(user, 'agent_v2_create_freight_requested', {
      slots,
      realExecution,
      idempotencyKey: slots.idempotencyKey,
      hasOriginLocation: hasValidLocation(slots.originLocation),
      hasDestinationLocation: hasValidLocation(slots.destinationLocation),
    });

    if (!realExecution) {
      return { status: 'pre_request', code, realExecution: false, durationMs: Date.now() - started };
    }

    if (!hasValidLocation(slots.originLocation) || !hasValidLocation(slots.destinationLocation)) {
      await this.audit(user, 'agent_v2_create_freight_blocked_missing_origin_location', { slots });
      return { status: 'blocked_missing_location', code, realExecution: false, durationMs: Date.now() - started };
    }

    const freight = await this.freights.create({
      customOriginName: slots.origin,
      overrideOriginLat: slots.originLocation!.lat,
      overrideOriginLng: slots.originLocation!.lng,
      customDestName: slots.destination,
      customDestLat: slots.destinationLocation!.lat,
      customDestLng: slots.destinationLocation!.lng,
      loadDate: normalizeDateForBackend(slots.date),
      loadTime: normalizeTimeForBackend(slots.time),
      truckCount: slots.truckCount,
      notes: slots.observations,
      items: [{ grain: slots.product!, tons: undefined }],
    } as any, user);

    await this.audit(user, 'agent_v2_create_freight_created', {
      freightId: (freight as any).id,
      code: (freight as any).code,
    }, (freight as any).id);

    return {
      status: 'created',
      code: (freight as any).code,
      id: (freight as any).id,
      realExecution: true,
      durationMs: Date.now() - started,
    };
  }

  async listFreights(input: QueryFreightsInput, user: any): Promise<FreightListItem[]> {
    const where = this.buildReadWhere(input, user);
    const freights = await this.prisma.freight.findMany({
      where,
      orderBy: [{ loadDate: 'asc' }, { loadTime: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(input.limit || 10, 1), 20),
      include: {
        items: true,
        originCompany: { select: { name: true } },
        destCompany: { select: { name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          take: 1,
          include: {
            transportCompany: { select: { name: true } },
            driver: { select: { name: true } },
            truck: { select: { plate: true } },
          },
        },
      },
    });
    return freights.map((freight: any) => this.toListItem(freight));
  }

  async getFreightDetail(input: QueryFreightsInput, user: any): Promise<FreightListItem | null> {
    if (!input.freightCode) return null;
    const where = this.buildReadWhere(input, user);
    const freight = await this.prisma.freight.findFirst({
      where,
      include: {
        items: true,
        originCompany: { select: { name: true } },
        destCompany: { select: { name: true } },
        assignments: {
          where: { status: { in: ['active', 'accepted'] } },
          take: 1,
          include: {
            transportCompany: { select: { name: true } },
            driver: { select: { name: true } },
            truck: { select: { plate: true } },
          },
        },
      },
    });
    return freight ? this.toListItem(freight as any) : null;
  }

  private buildReadWhere(input: QueryFreightsInput, user: any): Record<string, unknown> {
    const activeCompanyId = user?.activeCompanyId || user?.companyId;
    const where: any = {};
    if (input.freightCode) where.code = input.freightCode.toUpperCase();
    if (input.statusFilter) where.status = input.statusFilter;
    if (input.dateFilter && input.dateFilter !== 'all') {
      where.loadDate = normalizeDateForBackend(input.dateFilter === 'tomorrow' ? 'manana' : 'hoy');
    }
    where.OR = [
      { originCompanyId: activeCompanyId },
      { destCompanyId: activeCompanyId },
      { assignments: { some: { transportCompanyId: activeCompanyId } } },
      { assignments: { some: { driverId: user?.id } } },
    ];
    return where;
  }

  private toListItem(freight: any): FreightListItem {
    const item = freight.items?.[0];
    const assignment = freight.assignments?.[0];
    return {
      id: freight.id,
      code: freight.code,
      status: freight.status,
      originCompanyId: freight.originCompanyId || null,
      destCompanyId: freight.destCompanyId || null,
      product: item?.grain || null,
      tons: item?.tons == null ? null : Number(item.tons),
      origin: freight.originName || freight.originCompany?.name || null,
      destination: freight.destName || freight.destCompany?.name || null,
      date: freight.loadDate ? String(freight.loadDate).slice(0, 10) : null,
      time: freight.loadTime || null,
      transportCompany: assignment?.transportCompany?.name || null,
      driver: assignment?.driver?.name || null,
      truck: assignment?.truck?.plate || null,
      assignmentTransportCompanyId: assignment?.transportCompanyId || null,
      assignmentDriverId: assignment?.driverId || null,
      transporterFinishedConfirmedAt: freight.transporterFinishedConfirmedAt || null,
      plantFinishedConfirmedAt: freight.plantFinishedConfirmedAt || null,
      producerLoadedConfirmedAt: freight.producerLoadedConfirmedAt || null,
    };
  }

  private async audit(user: any, action: string, metadata: Record<string, unknown>, freightId?: string) {
    const userId = user?.id || user?.sub;
    if (!userId) return;
    await this.prisma.auditLog.create({
      data: {
        entityType: 'agent_v2',
        entityId: freightId || userId,
        action,
        userId,
        freightId,
        metadata: {
          source: 'whatsapp',
          ...metadata,
        },
      },
    }).catch(() => undefined);
  }
}

function hasValidLocation(location?: AgentLocation | null): location is AgentLocation {
  return !!location
    && Number.isFinite(location.lat)
    && Number.isFinite(location.lng)
    && location.lat >= -90
    && location.lat <= 90
    && location.lng >= -180
    && location.lng <= 180;
}

function normalizeDateForBackend(date: string | undefined): string {
  const now = new Date();
  const normalized = (date || '').toLowerCase();
  if (normalized === 'manana' || normalized === 'mañana') {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date!;
  return now.toISOString().slice(0, 10);
}

function normalizeTimeForBackend(time: string | undefined): string {
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time || '')) return time!;
  return '08:00';
}
