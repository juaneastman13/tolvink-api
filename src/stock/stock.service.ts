import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  StockMovementType,
  StockOwnershipType,
  StockSourceType,
  StockUnit,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { companyHasType } from '../common/company-type-helpers';
import {
  CreateStockItemDto,
  CreateStockLocationDto,
  CreateStockMovementDto,
  ListStockItemsQueryDto,
  ListStockLocationsQueryDto,
  ListStockMovementsQueryDto,
} from './stock.dto';

type TxClient = Prisma.TransactionClient;

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    private prisma: PrismaService,
    private companyRes: CompanyResolutionService,
  ) {}

  async getSummary(user: any) {
    const { companyId } = await this.resolveStockContext(user);
    const [balances, recentMovements] = await Promise.all([
      this.prisma.stockBalance.findMany({
        where: { companyId },
        include: {
          item: { select: { id: true, name: true, category: true, baseUnit: true } },
          location: { select: { id: true, name: true, ownershipType: true, locationType: true } },
        },
      }),
      this.prisma.stockMovement.findMany({
        where: { companyId, revertedAt: null },
        include: {
          item: { select: { id: true, name: true, category: true, baseUnit: true } },
          fromLocation: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
        },
        orderBy: { effectiveAt: 'desc' },
        take: 10,
      }),
    ]);

    const itemsMap = new Map<string, any>();
    const categoryMap = new Map<string, any>();

    for (const balance of balances) {
      const qty = Number(balance.currentQuantity || 0);
      const itemKey = balance.itemId;
      const categoryKey = `${balance.item.category}:${balance.baseUnit}`;

      if (!itemsMap.has(itemKey)) {
        itemsMap.set(itemKey, {
          itemId: balance.itemId,
          itemName: balance.item.name,
          category: balance.item.category,
          baseUnit: balance.baseUnit,
          ownQuantity: 0,
          thirdPartyQuantity: 0,
          totalQuantity: 0,
          locations: [],
        });
      }
      if (!categoryMap.has(categoryKey)) {
        categoryMap.set(categoryKey, {
          category: balance.item.category,
          baseUnit: balance.baseUnit,
          ownQuantity: 0,
          thirdPartyQuantity: 0,
          totalQuantity: 0,
        });
      }

      const itemEntry = itemsMap.get(itemKey);
      const categoryEntry = categoryMap.get(categoryKey);
      const bucket = balance.location.ownershipType === 'own' ? 'ownQuantity' : 'thirdPartyQuantity';

      itemEntry[bucket] += qty;
      itemEntry.totalQuantity += qty;
      itemEntry.locations.push({
        locationId: balance.locationId,
        locationName: balance.location.name,
        locationType: balance.location.locationType,
        ownershipType: balance.location.ownershipType,
        quantity: qty,
      });

      categoryEntry[bucket] += qty;
      categoryEntry.totalQuantity += qty;
    }

    return {
      companyId,
      items: Array.from(itemsMap.values()),
      categories: Array.from(categoryMap.values()),
      recentMovements: recentMovements.map((movement) => ({
        id: movement.id,
        movementType: movement.movementType,
        itemName: movement.item.name,
        category: movement.item.category,
        quantity: Number(movement.baseQuantity),
        baseUnit: movement.baseUnit,
        fromLocation: movement.fromLocation?.name || null,
        toLocation: movement.toLocation?.name || null,
        effectiveAt: movement.effectiveAt,
        createdBy: movement.createdBy.name,
        sourceType: movement.sourceType,
      })),
    };
  }

  async listItems(user: any, query: ListStockItemsQueryDto) {
    const { companyId } = await this.resolveStockContext(user);
    return this.prisma.stockItem.findMany({
      where: {
        companyId,
        active: true,
        ...(query.category ? { category: query.category as any } : {}),
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async createItem(user: any, dto: CreateStockItemDto) {
    const { companyId } = await this.resolveStockContext(user);
    return this.prisma.stockItem.create({
      data: {
        companyId,
        category: dto.category as any,
        name: dto.name.trim(),
        code: dto.code?.trim() || null,
        baseUnit: dto.baseUnit as any,
      },
    });
  }

  async listLocations(user: any, query: ListStockLocationsQueryDto) {
    const { companyId } = await this.resolveStockContext(user);
    const locations = await this.prisma.stockLocation.findMany({
      where: {
        companyId,
        active: true,
        ...(query.locationType ? { locationType: query.locationType as any } : {}),
        ...(query.ownershipType ? { ownershipType: query.ownershipType as any } : {}),
      },
      include: {
        field: { select: { id: true, name: true } },
        lot: { select: { id: true, name: true } },
        plant: { select: { id: true, name: true, company: { select: { id: true, name: true } } } },
        balances: {
          include: { item: { select: { id: true, name: true, category: true, baseUnit: true } } },
        },
      },
      orderBy: [{ ownershipType: 'asc' }, { name: 'asc' }],
    });

    return locations.map((location) => ({
      ...location,
      balances: location.balances.map((balance) => ({
        ...balance,
        currentQuantity: Number(balance.currentQuantity),
      })),
    }));
  }

  async createLocation(user: any, dto: CreateStockLocationDto) {
    const { companyId } = await this.resolveStockContext(user);
    const referenceData = await this.validateLocationReferences(companyId, dto);

    return this.prisma.stockLocation.create({
      data: {
        companyId,
        locationType: dto.locationType as any,
        ownershipType: referenceData.ownershipType,
        name: dto.name.trim(),
        referenceKey: referenceData.referenceKey,
        fieldId: dto.fieldId || null,
        lotId: dto.lotId || null,
        plantId: dto.plantId || null,
        address: dto.address?.trim() || null,
        notes: dto.notes?.trim() || null,
      },
      include: {
        field: { select: { id: true, name: true } },
        lot: { select: { id: true, name: true } },
        plant: { select: { id: true, name: true, company: { select: { id: true, name: true } } } },
      },
    });
  }

  async listMovements(user: any, query: ListStockMovementsQueryDto) {
    const { companyId } = await this.resolveStockContext(user);
    return this.prisma.stockMovement.findMany({
      where: {
        companyId,
        revertedAt: null,
        ...(query.itemId ? { itemId: query.itemId } : {}),
        ...(query.movementType ? { movementType: query.movementType as any } : {}),
        ...(query.category ? { item: { category: query.category as any } } : {}),
        ...(query.locationId
          ? { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] }
          : {}),
        ...(query.dateFrom || query.dateTo
          ? {
              effectiveAt: {
                ...(query.dateFrom ? { gte: new Date(query.dateFrom) } : {}),
                ...(query.dateTo ? { lte: new Date(query.dateTo) } : {}),
              },
            }
          : {}),
      },
      include: {
        item: { select: { id: true, name: true, category: true, baseUnit: true } },
        fromLocation: { select: { id: true, name: true, ownershipType: true } },
        toLocation: { select: { id: true, name: true, ownershipType: true } },
        createdBy: { select: { id: true, name: true } },
      },
      orderBy: [{ effectiveAt: 'desc' }, { createdAt: 'desc' }],
      take: Math.min(query.limit || 50, 200),
    });
  }

  async createMovement(user: any, dto: CreateStockMovementDto) {
    const { companyId } = await this.resolveStockContext(user);
    if (
      dto.movementType === 'freight_in_internal'
      || dto.movementType === 'freight_in_third_party'
    ) {
      throw new BadRequestException('Los ingresos automáticos por flete no se cargan manualmente');
    }
    const item = await this.getStockItem(companyId, dto.itemId);
    const fromLocation = dto.fromLocationId ? await this.getStockLocation(companyId, dto.fromLocationId) : null;
    const toLocation = dto.toLocationId ? await this.getStockLocation(companyId, dto.toLocationId) : null;

    this.validateManualMovementShape(dto.movementType as StockMovementType, fromLocation?.id, toLocation?.id);

    const baseQuantity = this.convertToBaseUnit(dto.quantity, dto.unit as StockUnit, item.baseUnit);

    return this.prisma.$transaction(async (tx) => {
      return this.createMovementRecord(tx, {
        companyId,
        itemId: item.id,
        movementType: dto.movementType as StockMovementType,
        quantity: new Prisma.Decimal(dto.quantity),
        unit: dto.unit as StockUnit,
        baseQuantity,
        baseUnit: item.baseUnit,
        fromLocationId: fromLocation?.id || null,
        toLocationId: toLocation?.id || null,
        effectiveAt: dto.effectiveAt ? new Date(dto.effectiveAt) : new Date(),
        notes: dto.notes?.trim() || null,
        sourceType: StockSourceType.manual,
        sourceId: null,
        freightId: null,
        assignmentId: null,
        isSystemGenerated: false,
        metadata: null,
        createdByUserId: user.sub,
      });
    });
  }

  async revertMovement(user: any, movementId: string, reason?: string) {
    const { companyId } = await this.resolveStockContext(user);
    const movement = await this.prisma.stockMovement.findFirst({
      where: { id: movementId, companyId },
      include: { item: true },
    });
    if (!movement) throw new NotFoundException('Movimiento no encontrado');
    if (movement.revertedAt) throw new BadRequestException('El movimiento ya fue revertido');
    if (movement.isSystemGenerated || movement.sourceType === StockSourceType.freight) {
      throw new BadRequestException('Los movimientos automáticos por flete no se pueden revertir manualmente');
    }

    const reverseType = this.reverseMovementType(movement.movementType);
    if (!reverseType) {
      throw new BadRequestException('Este tipo de movimiento no soporta reversa automática');
    }

    return this.prisma.$transaction(async (tx) => {
      const reverseMovement = await this.createMovementRecord(tx, {
        companyId: movement.companyId,
        itemId: movement.itemId,
        movementType: reverseType,
        quantity: movement.quantity,
        unit: movement.unit,
        baseQuantity: movement.baseQuantity,
        baseUnit: movement.baseUnit,
        fromLocationId: movement.toLocationId,
        toLocationId: movement.fromLocationId,
        effectiveAt: new Date(),
        notes: reason?.trim() || `Reversa del movimiento ${movement.id}`,
        sourceType: StockSourceType.adjustment,
        sourceId: movement.id,
        freightId: null,
        assignmentId: null,
        isSystemGenerated: false,
        metadata: { reversedMovementId: movement.id },
        createdByUserId: user.sub,
      });

      await tx.stockMovement.update({
        where: { id: movement.id },
        data: {
          revertedAt: new Date(),
          revertedByUserId: user.sub,
        },
      });

      return reverseMovement;
    });
  }

  async recordFreightIncome(freightId: string, assignmentId?: string | null) {
    const freight = await this.prisma.freight.findUnique({
      where: { id: freightId },
      include: {
        items: { take: 1, orderBy: { createdAt: 'asc' } },
        destPlant: { include: { company: { select: { id: true, name: true } } } },
        tolvinkPlant: true,
        weighTickets: {
          where: {
            type: 'destination',
            ...(assignmentId ? { assignmentId } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        assignments: assignmentId
          ? {
              where: { id: assignmentId },
              select: { id: true, tripNumber: true, tons: true, loadedTons: true },
            }
          : false,
      } as any,
    });

    if (!freight || freight.status !== 'finished') return null;
    const producerCompanyId = freight.producerCompanyId || freight.originCompanyId;
    const producerCompany = await this.prisma.company.findUnique({
      where: { id: producerCompanyId },
      select: { id: true, enabledModules: true, type: true, types: true },
    });
    if (!producerCompany || !companyHasType(producerCompany, 'producer')) return null;
    if (!producerCompany.enabledModules.includes('stock')) return null;

    const itemSource = (freight as any).items?.[0] as any;
    if (!itemSource?.grain) return null;

    const assignment = Array.isArray((freight as any).assignments) ? (freight as any).assignments[0] : null;
    const sourceId = assignment?.id || freight.id;
    const existing = await this.prisma.stockMovement.findFirst({
      where: {
        companyId: producerCompanyId,
        sourceType: StockSourceType.freight,
        sourceId,
        revertedAt: null,
      },
      select: { id: true },
    });
    if (existing) return existing;

    const quantityKg = this.resolveFreightQuantityKg(freight as any, assignment);
    if (quantityKg <= 0) {
      this.logger.warn(`Stock skip for freight ${freight.id}: quantity could not be resolved`);
      return null;
    }

    return this.prisma.$transaction(async (tx) => {
      const item = await this.getOrCreateGrainItem(tx, producerCompanyId, itemSource.grain);
      const location = await this.resolveOrCreateFreightLocation(tx, producerCompanyId, freight as any);
      if (!location) {
        this.logger.warn(`Stock skip for freight ${freight.id}: destination location could not be resolved`);
        return null;
      }

      return this.createMovementRecord(tx, {
        companyId: producerCompanyId,
        itemId: item.id,
        movementType:
          location.ownershipType === StockOwnershipType.own
            ? StockMovementType.freight_in_internal
            : StockMovementType.freight_in_third_party,
        quantity: new Prisma.Decimal(quantityKg),
        unit: StockUnit.kg,
        baseQuantity: this.convertToBaseUnit(quantityKg, StockUnit.kg, item.baseUnit),
        baseUnit: item.baseUnit,
        fromLocationId: null,
        toLocationId: location.id,
        effectiveAt: freight.finishedAt || new Date(),
        notes: `Ingreso automático desde flete ${freight.code}`,
        sourceType: StockSourceType.freight,
        sourceId,
        freightId: freight.id,
        assignmentId: assignment?.id || null,
        isSystemGenerated: true,
        metadata: { freightCode: freight.code, tripNumber: assignment?.tripNumber || null },
        createdByUserId: freight.requestedById,
      });
    });
  }

  private async resolveStockContext(user: any) {
    const companyId = user.activeCompanyId || user.companyId;
    if (!companyId) throw new ForbiddenException('No hay empresa activa seleccionada');

    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { id: true, name: true, active: true, type: true, types: true, enabledModules: true },
    });
    if (!company?.active) throw new ForbiddenException('Empresa activa no disponible');

    const memberships = await this.companyRes.resolveAllCompanyIds(user);
    if (!memberships.includes(companyId) && user.role !== 'platform_admin') {
      throw new ForbiddenException('No tenés acceso a la empresa activa');
    }
    if (!companyHasType(company, 'producer') && user.role !== 'platform_admin') {
      throw new ForbiddenException('El módulo de stock está disponible solo para empresas productoras');
    }
    if (!company.enabledModules.includes('stock') && user.role !== 'platform_admin') {
      throw new ForbiddenException('El módulo de stock no está habilitado para esta empresa');
    }

    return { companyId, company };
  }

  private async getStockItem(companyId: string, itemId: string) {
    const item = await this.prisma.stockItem.findFirst({
      where: { id: itemId, companyId, active: true },
    });
    if (!item) throw new NotFoundException('Ítem de stock no encontrado');
    return item;
  }

  private async getStockLocation(companyId: string, locationId: string) {
    const location = await this.prisma.stockLocation.findFirst({
      where: { id: locationId, companyId, active: true },
    });
    if (!location) throw new NotFoundException('Ubicación de stock no encontrada');
    return location;
  }

  private validateManualMovementShape(
    movementType: StockMovementType,
    fromLocationId?: string | null,
    toLocationId?: string | null,
  ) {
    const inbound = new Set<StockMovementType>([
      StockMovementType.manual_in,
      StockMovementType.purchase_in,
      StockMovementType.adjustment_in,
      StockMovementType.freight_in_internal,
      StockMovementType.freight_in_third_party,
    ]);
    const outbound = new Set<StockMovementType>([
      StockMovementType.sale_out,
      StockMovementType.reexpedition_out,
      StockMovementType.consumption_out,
      StockMovementType.manual_out,
      StockMovementType.adjustment_out,
    ]);

    if (movementType === StockMovementType.transfer) {
      if (!fromLocationId || !toLocationId) {
        throw new BadRequestException('Las transferencias requieren origen y destino');
      }
      if (fromLocationId === toLocationId) {
        throw new BadRequestException('La transferencia requiere ubicaciones distintas');
      }
      return;
    }
    if (inbound.has(movementType) && !toLocationId) {
      throw new BadRequestException('El ingreso requiere ubicación destino');
    }
    if (outbound.has(movementType) && !fromLocationId) {
      throw new BadRequestException('El egreso requiere ubicación origen');
    }
  }

  private async validateLocationReferences(companyId: string, dto: CreateStockLocationDto) {
    let ownershipType = dto.ownershipType as StockOwnershipType;
    let referenceKey: string | null = null;

    if (dto.fieldId) {
      const field = await this.prisma.field.findFirst({
        where: { id: dto.fieldId, companyId, active: true },
        select: { id: true },
      });
      if (!field) throw new BadRequestException('El campo seleccionado no pertenece a la empresa activa');
      ownershipType = StockOwnershipType.own;
      referenceKey = `field:${field.id}`;
    }

    if (dto.lotId) {
      const lot = await this.prisma.lot.findFirst({
        where: { id: dto.lotId, companyId, active: true },
        select: { id: true },
      });
      if (!lot) throw new BadRequestException('El lote seleccionado no pertenece a la empresa activa');
      ownershipType = StockOwnershipType.own;
      referenceKey = `lot:${lot.id}`;
    }

    if (dto.plantId) {
      const plant = await this.prisma.plant.findUnique({
        where: { id: dto.plantId },
        select: { id: true, companyId: true },
      });
      if (!plant) throw new BadRequestException('La planta seleccionada no existe');
      ownershipType = plant.companyId === companyId ? StockOwnershipType.own : StockOwnershipType.third_party;
      referenceKey = `plant:${plant.id}`;
    }

    return { ownershipType, referenceKey };
  }

  private convertToBaseUnit(quantity: number, unit: StockUnit, baseUnit: StockUnit): Prisma.Decimal {
    const amount = Number(quantity || 0);
    if (amount <= 0) throw new BadRequestException('La cantidad debe ser mayor a cero');
    if (unit === baseUnit) return new Prisma.Decimal(amount);

    if (baseUnit === StockUnit.kg && unit === StockUnit.tn) {
      return new Prisma.Decimal(amount * 1000);
    }
    if (baseUnit === StockUnit.tn && unit === StockUnit.kg) {
      return new Prisma.Decimal(amount / 1000);
    }

    throw new BadRequestException(`No existe conversión soportada entre ${unit} y ${baseUnit}`);
  }

  private async createMovementRecord(
    tx: TxClient,
    data: {
      companyId: string;
      itemId: string;
      movementType: StockMovementType;
      quantity: Prisma.Decimal;
      unit: StockUnit;
      baseQuantity: Prisma.Decimal;
      baseUnit: StockUnit;
      fromLocationId?: string | null;
      toLocationId?: string | null;
      effectiveAt: Date;
      notes?: string | null;
      sourceType: StockSourceType;
      sourceId?: string | null;
      freightId?: string | null;
      assignmentId?: string | null;
      isSystemGenerated: boolean;
      metadata?: any;
      createdByUserId: string;
    },
  ) {
    await this.applyMovementToBalances(tx, data);

    const movement = await tx.stockMovement.create({
      data: {
        companyId: data.companyId,
        itemId: data.itemId,
        movementType: data.movementType,
        quantity: data.quantity,
        unit: data.unit,
        baseQuantity: data.baseQuantity,
        baseUnit: data.baseUnit,
        fromLocationId: data.fromLocationId || null,
        toLocationId: data.toLocationId || null,
        effectiveAt: data.effectiveAt,
        notes: data.notes || null,
        sourceType: data.sourceType,
        sourceId: data.sourceId || null,
        freightId: data.freightId || null,
        assignmentId: data.assignmentId || null,
        isSystemGenerated: data.isSystemGenerated,
        metadata: data.metadata || undefined,
        createdByUserId: data.createdByUserId,
      },
      include: {
        item: { select: { id: true, name: true, category: true, baseUnit: true } },
        fromLocation: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
      },
    });

    await tx.auditLog.create({
      data: {
        entityType: 'stock_movement',
        entityId: movement.id,
        action: 'created',
        fromValue: null,
        toValue: movement.movementType,
        userId: data.createdByUserId,
        reason: data.notes || undefined,
        metadata: {
          companyId: data.companyId,
          sourceType: data.sourceType,
          sourceId: data.sourceId,
          freightId: data.freightId,
          assignmentId: data.assignmentId,
        },
      },
    });

    return movement;
  }

  private async applyMovementToBalances(
    tx: TxClient,
    data: {
      companyId: string;
      itemId: string;
      fromLocationId?: string | null;
      toLocationId?: string | null;
      baseQuantity: Prisma.Decimal;
      baseUnit: StockUnit;
    },
  ) {
    if (data.fromLocationId) {
      const existing = await tx.stockBalance.findUnique({
        where: {
          companyId_itemId_locationId: {
            companyId: data.companyId,
            itemId: data.itemId,
            locationId: data.fromLocationId,
          },
        },
      });
      if (!existing) {
        throw new BadRequestException('No hay saldo disponible en la ubicación origen');
      }
      if (new Prisma.Decimal(existing.currentQuantity).lt(data.baseQuantity)) {
        throw new BadRequestException('La ubicación origen no tiene stock suficiente');
      }
      await tx.stockBalance.update({
        where: {
          companyId_itemId_locationId: {
            companyId: data.companyId,
            itemId: data.itemId,
            locationId: data.fromLocationId,
          },
        },
        data: { currentQuantity: { decrement: data.baseQuantity } },
      });
    }

    if (data.toLocationId) {
      await tx.stockBalance.upsert({
        where: {
          companyId_itemId_locationId: {
            companyId: data.companyId,
            itemId: data.itemId,
            locationId: data.toLocationId,
          },
        },
        create: {
          companyId: data.companyId,
          itemId: data.itemId,
          locationId: data.toLocationId,
          currentQuantity: data.baseQuantity,
          baseUnit: data.baseUnit,
        },
        update: {
          currentQuantity: { increment: data.baseQuantity },
          baseUnit: data.baseUnit,
        },
      });
    }
  }

  private reverseMovementType(movementType: StockMovementType): StockMovementType | null {
    switch (movementType) {
      case StockMovementType.manual_in:
      case StockMovementType.purchase_in:
        return StockMovementType.manual_out;
      case StockMovementType.adjustment_in:
        return StockMovementType.adjustment_out;
      case StockMovementType.sale_out:
      case StockMovementType.reexpedition_out:
      case StockMovementType.consumption_out:
      case StockMovementType.manual_out:
      case StockMovementType.adjustment_out:
        return StockMovementType.adjustment_in;
      case StockMovementType.transfer:
        return StockMovementType.transfer;
      default:
        return null;
    }
  }

  private async getOrCreateGrainItem(tx: TxClient, companyId: string, grain: string) {
    const name = String(grain || '').trim();
    const existing = await tx.stockItem.findFirst({
      where: { companyId, category: 'grain', name, active: true },
    });
    if (existing) return existing;

    return tx.stockItem.create({
      data: {
        companyId,
        category: 'grain',
        name,
        baseUnit: StockUnit.kg,
      },
    });
  }

  private async resolveOrCreateFreightLocation(tx: TxClient, companyId: string, freight: any) {
    if (freight.destPlantId && freight.destPlant) {
      const ownershipType =
        freight.destPlant.companyId === companyId ? StockOwnershipType.own : StockOwnershipType.third_party;
      return tx.stockLocation.upsert({
        where: {
          companyId_referenceKey: {
            companyId,
            referenceKey: `plant:${freight.destPlantId}`,
          },
        },
        create: {
          companyId,
          locationType: 'plant',
          ownershipType,
          name:
            ownershipType === StockOwnershipType.own
              ? freight.destPlant.name
              : `${freight.destPlant.company?.name || 'Planta'} - ${freight.destPlant.name}`,
          referenceKey: `plant:${freight.destPlantId}`,
          plantId: freight.destPlantId,
        },
        update: {
          ownershipType,
          name:
            ownershipType === StockOwnershipType.own
              ? freight.destPlant.name
              : `${freight.destPlant.company?.name || 'Planta'} - ${freight.destPlant.name}`,
          plantId: freight.destPlantId,
        },
      });
    }

    if (freight.tolvinkPlantId && freight.tolvinkPlant) {
      return tx.stockLocation.upsert({
        where: {
          companyId_referenceKey: {
            companyId,
            referenceKey: `tolvink_plant:${freight.tolvinkPlantId}`,
          },
        },
        create: {
          companyId,
          locationType: 'plant',
          ownershipType: StockOwnershipType.third_party,
          name: freight.tolvinkPlant.name,
          referenceKey: `tolvink_plant:${freight.tolvinkPlantId}`,
        },
        update: {
          ownershipType: StockOwnershipType.third_party,
          name: freight.tolvinkPlant.name,
        },
      });
    }

    if (freight.destCompanyId && freight.destName) {
      const ownershipType =
        freight.destCompanyId === companyId ? StockOwnershipType.own : StockOwnershipType.third_party;
      const referenceKey = `company_destination:${freight.destCompanyId}:${this.normalizeKey(freight.destName)}`;
      return tx.stockLocation.upsert({
        where: { companyId_referenceKey: { companyId, referenceKey } },
        create: {
          companyId,
          locationType: 'other',
          ownershipType,
          name: freight.destName,
          referenceKey,
        },
        update: {
          ownershipType,
          name: freight.destName,
        },
      });
    }

    if (freight.destName) {
      return tx.stockLocation.findFirst({
        where: { companyId, active: true, name: { equals: freight.destName, mode: 'insensitive' } },
      });
    }

    return null;
  }

  private resolveFreightQuantityKg(freight: any, assignment?: any): number {
    const weighTicket = freight.weighTickets?.[0];
    if (weighTicket?.netWeight != null) return Number(weighTicket.netWeight);
    if (assignment?.loadedTons != null) return Number(assignment.loadedTons) * 1000;
    if (assignment?.tons != null) return Number(assignment.tons) * 1000;
    const item = freight.items?.[0];
    if (item?.tons != null) return Number(item.tons) * 1000;
    return 0;
  }

  private normalizeKey(value: string) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
  }
}
