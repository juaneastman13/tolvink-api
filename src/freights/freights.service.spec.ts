import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { FreightsService } from './freights.service';
import { PrismaService } from '../database/prisma.service';
import { CompanyResolutionService } from '../common/services/company-resolution.service';
import { FreightStateMachine } from './freight-state-machine.service';
import { NotificationService } from '../notifications/notification.service';
import { ConfigService } from '@nestjs/config';
import { SseService } from '../sse/sse.service';
import { StockService } from '../stock/stock.service';

// Mock @prisma/client enums + PrismaClient base class
jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { DbNull: 'DbNull' },
  FreightStatus: {
    draft: 'draft',
    pending_assignment: 'pending_assignment',
    assigned: 'assigned',
    accepted: 'accepted',
    in_progress: 'in_progress',
    loaded: 'loaded',
    finished: 'finished',
    canceled: 'canceled',
  },
  AssignmentStatus: {
    active: 'active',
    accepted: 'accepted',
    rejected: 'rejected',
    canceled: 'canceled',
  },
  NotificationType: {
    freight_created: 'freight_created',
    freight_assigned: 'freight_assigned',
    freight_accepted: 'freight_accepted',
    freight_rejected: 'freight_rejected',
    freight_started: 'freight_started',
    freight_loaded: 'freight_loaded',
    freight_confirmed: 'freight_confirmed',
    freight_finished: 'freight_finished',
    freight_canceled: 'freight_canceled',
  },
}));

describe('FreightsService', () => {
  let service: FreightsService;
  let prisma: any;
  let companyRes: any;
  let stateMachine: any;
  let notifications: any;

  const user = { sub: 'user-1', companyId: 'comp-prod', companyType: 'producer', role: 'gerente' };
  const plantUser = { sub: 'user-2', companyId: 'comp-plant', companyType: 'plant', role: 'gerente' };
  const transportUser = { sub: 'user-3', companyId: 'comp-trans', companyType: 'transporter', role: 'operario' };

  // Transaction mock — executes callback with a tx proxy that uses same mockPrisma
  const txProxy: any = {};

  const mockPrisma: any = {
    lot: { findFirst: jest.fn() },
    plant: { findFirst: jest.fn() },
    company: { findFirst: jest.fn(), findUnique: jest.fn() },
    truck: { findFirst: jest.fn() },
    field: { findFirst: jest.fn() },
    freight: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    freightAssignment: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _max: { queuePosition: 0 } }),
    },
    freightTracking: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    freightDocument: { create: jest.fn(), count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
    weighTicket: { groupBy: jest.fn().mockResolvedValue([]) },
    auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
    conversationParticipant: { upsert: jest.fn().mockResolvedValue({}) },
    userCompany: { findMany: jest.fn() },
    companyAccess: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
    freightPendingChange: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    $transaction: jest.fn((cb: any) => cb(txProxy)),
    $queryRaw: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
  };

  // txProxy delegates to mockPrisma
  Object.keys(mockPrisma).forEach((k) => {
    if (k !== '$transaction') txProxy[k] = mockPrisma[k];
  });

  const mockCompanyRes = {
    resolveProducerCompanyId: jest.fn().mockResolvedValue('comp-prod'),
    resolveCompanyType: jest.fn().mockResolvedValue('producer'),
    hasCompanyType: jest.fn().mockResolvedValue(false),
    resolveAllCompanyIds: jest.fn().mockResolvedValue(['comp-prod']),
    resolvePlantCompanyId: jest.fn(),
    resolveAllProducerCompanyIds: jest.fn(),
  };

  const mockStateMachine = {
    validateTransition: jest.fn(),
    getAllowedTransitions: jest.fn(),
  };

  const mockNotifications = {
    notifyCompany: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreightsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CompanyResolutionService, useValue: mockCompanyRes },
        { provide: FreightStateMachine, useValue: mockStateMachine },
        { provide: NotificationService, useValue: mockNotifications },
        { provide: SseService, useValue: { broadcastFreightUpdate: jest.fn().mockResolvedValue(undefined), invalidateParticipantsCache: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: StockService, useValue: { recordFreightIncome: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(FreightsService);
    (service as any).sse = module.get(SseService);
    prisma = module.get(PrismaService);
    companyRes = module.get(CompanyResolutionService);
    stateMachine = module.get(FreightStateMachine);
    notifications = module.get(NotificationService);
  });

  // ================================================================
  // CREATE
  // ================================================================
  describe('create', () => {
    const createDto = {
      originLotId: 'lot-1',
      destPlantId: 'plant-1',
      loadDate: '2026-03-01',
      loadTime: '08:00',
      items: [{ grain: 'Soja', tons: 30 }],
    };

    const mockLot = {
      id: 'lot-1', name: 'Lote Norte', lat: -34.5, lng: -56.2,
      fieldId: 'field-1', field: { id: 'field-1' },
    };

    const mockPlant = {
      id: 'plant-1', name: 'Planta Sur', lat: -34.8, lng: -56.0,
      companyId: 'comp-plant', company: { id: 'comp-plant' },
    };

    beforeEach(() => {
      mockPrisma.lot.findFirst.mockResolvedValue(mockLot);
      mockPrisma.plant.findFirst.mockResolvedValue(mockPlant);
      mockPrisma.company.findUnique.mockResolvedValue({ hasInternalFleet: false });
      mockPrisma.freight.findUnique.mockResolvedValue(null); // code uniqueness check
      mockPrisma.freight.create.mockResolvedValue({
        id: 'freight-1', code: 'F26-ABC.1234', status: 'pending_assignment',
        originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
        items: [{ grain: 'Soja', tons: 30 }],
        conversation: { id: 'conv-1' },
      });
      mockPrisma.auditLog.create.mockResolvedValue({});
    });

    it('creates freight with lot origin and plant dest', async () => {
      const result = await service.create(createDto as any, user);

      expect(result.status).toBe('pending_assignment');
      expect(mockPrisma.freight.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'pending_assignment',
            originCompanyId: 'comp-prod',
            destCompanyId: 'comp-plant',
            destPlantId: 'plant-1',
          }),
        }),
      );
    });

    it('creates freight when destination is resolved as a plant company id', async () => {
      mockPrisma.plant.findFirst.mockResolvedValue(null);
      mockPrisma.company.findFirst.mockResolvedValue({
        id: 'comp-plant',
        name: 'Cradeco',
        type: 'plant',
        lat: -34.8,
        lng: -56.0,
      });

      await service.create({ ...createDto, destPlantId: 'comp-plant' } as any, user);

      expect(mockPrisma.freight.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            destCompanyId: 'comp-plant',
            destPlantId: null,
            destName: 'Cradeco',
          }),
        }),
      );
    });

    it('generates random code (F + year + letters + digits)', async () => {
      const result = await service.create(createDto as any, user);

      // Code format: F{YY}-{3 letters}.{4 digits}
      expect(mockPrisma.freight.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            code: expect.stringMatching(/^F\d{2}-[A-Z]{3}\.\d{4}$/),
          }),
        }),
      );
    });

    it('throws when no dest provided', async () => {
      await expect(
        service.create({ ...createDto, destPlantId: undefined, customDestName: undefined } as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when lot not found', async () => {
      mockPrisma.lot.findFirst.mockResolvedValue(null);

      await expect(
        service.create(createDto as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when no lot and no override coords', async () => {
      await expect(
        service.create({
          ...createDto, originLotId: undefined,
        } as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates audit log', async () => {
      await service.create(createDto as any, user);

      expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entityType: 'freight',
            action: 'created',
            toValue: 'pending_assignment',
            userId: 'user-1',
          }),
        }),
      );
    });

    it('auto-assigns truck when truckId provided', async () => {
      const dtoWithTruck = { ...createDto, truckId: 'truck-1' };
      mockPrisma.truck.findFirst.mockResolvedValue({
        id: 'truck-1', plate: 'ABC-1234', assignedUserId: 'driver-1',
        assignedUser: { id: 'driver-1', name: 'Driver' },
      });
      mockPrisma.freightAssignment.create.mockResolvedValue({});
      mockPrisma.freightAssignment.count.mockResolvedValue(1);
      mockPrisma.freight.update.mockResolvedValue({});

      await service.create(dtoWithTruck as any, user);

      expect(mockPrisma.freightAssignment.create).toHaveBeenCalled();
    });

    it('notifies dest company', async () => {
      await service.create(createDto as any, user);

      expect(mockNotifications.notifyCompany).toHaveBeenCalledWith(
        'comp-plant', 'freight_created',
        expect.any(String), expect.any(String),
        'freight-1', 'user-1', false,
      );
    });
  });

  // ================================================================
  // FIND ALL
  // ================================================================
  describe('findAll', () => {
    it('returns paginated freights', async () => {
      mockPrisma.freight.findMany.mockResolvedValue([{ id: 'f1' }]);
      mockPrisma.freight.count.mockResolvedValue(1);

      const result = await service.findAll(user, {});

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.pages).toBe(1);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('f1');
    });

    it('platform_admin sees all (no company filter)', async () => {
      const admin = { sub: 'admin-1', role: 'platform_admin' };
      mockPrisma.freight.findMany.mockResolvedValue([]);
      mockPrisma.freight.count.mockResolvedValue(0);

      await service.findAll(admin, {});

      // findMany should be called without OR filter
      const findManyCall = mockPrisma.freight.findMany.mock.calls[0][0];
      expect(findManyCall.where.OR).toBeUndefined();
    });

    it('regular user filters by company IDs', async () => {
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod', 'comp-other']);
      mockPrisma.freight.findMany.mockResolvedValue([]);
      mockPrisma.freight.count.mockResolvedValue(0);

      await service.findAll(user, {});

      const findManyCall = mockPrisma.freight.findMany.mock.calls[0][0];
      expect(findManyCall.where.OR).toBeDefined();
      expect(findManyCall.where.OR).toHaveLength(2); // participantCompanyIds hasSome + driver assignment
    });

    it('caps limit at 100', async () => {
      mockPrisma.freight.findMany.mockResolvedValue([]);
      mockPrisma.freight.count.mockResolvedValue(0);

      await service.findAll(user, { limit: 500 });

      const findManyCall = mockPrisma.freight.findMany.mock.calls[0][0];
      expect(findManyCall.take).toBe(100);
    });

    it('filters by status', async () => {
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.findMany.mockResolvedValue([]);
      mockPrisma.freight.count.mockResolvedValue(0);

      await service.findAll(user, { status: 'in_progress' });

      const findManyCall = mockPrisma.freight.findMany.mock.calls[0][0];
      expect(findManyCall.where.status).toBe('in_progress');
    });
  });

  // ================================================================
  // FIND ONE
  // ================================================================
  describe('findOne', () => {
    it('returns freight with includes', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({ id: 'f1', code: 'FLT-0001' });

      const result = await service.findOne('f1');

      expect(result.id).toBe('f1');
    });

    it('throws when not found', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ================================================================
  // ASSIGN
  // ================================================================
  describe('assign', () => {
    const freight = {
      id: 'f1', code: 'FLT-0001', status: 'pending_assignment',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      conversation: { id: 'conv-1' },
    };

    beforeEach(() => {
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.company.findFirst.mockResolvedValue({
        id: 'comp-trans', type: 'transporter', types: ['transporter'], active: true,
      });
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freightAssignment.create.mockResolvedValue({ id: 'assign-1' });
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'assigned' });
      mockPrisma.conversationParticipant.upsert.mockResolvedValue({});
      mockPrisma.auditLog.create.mockResolvedValue({});
    });

    it('assigns transporter successfully', async () => {
      const result = await service.assign('f1', { transportCompanyId: 'comp-trans' } as any, plantUser);

      expect(result.status).toBe('assigned');
    });

    it('throws when user is not plant', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);

      await expect(
        service.assign('f1', { transportCompanyId: 'comp-trans' } as any, user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws when freight not found', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(null);

      await expect(
        service.assign('missing', { transportCompanyId: 'comp-trans' } as any, plantUser),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws when transport company not found', async () => {
      mockPrisma.company.findFirst.mockResolvedValue(null);

      await expect(
        service.assign('f1', { transportCompanyId: 'invalid' } as any, plantUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('cancels previous assignments', async () => {
      await service.assign('f1', { transportCompanyId: 'comp-trans' } as any, plantUser);

      expect(mockPrisma.freightAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'canceled' }),
        }),
      );
    });

    it('adds transporter to conversation', async () => {
      await service.assign('f1', { transportCompanyId: 'comp-trans' } as any, plantUser);

      expect(mockPrisma.conversationParticipant.upsert).toHaveBeenCalled();
    });

    it('notifies transporter', async () => {
      await service.assign('f1', { transportCompanyId: 'comp-trans' } as any, plantUser);

      expect(mockNotifications.notifyCompany).toHaveBeenCalledWith(
        'comp-trans', 'freight_assigned',
        expect.any(String), expect.any(String),
        'f1', plantUser.sub, true,
      );
    });
  });

  // ================================================================
  // RESPOND (accept/reject)
  // ================================================================
  describe('respond', () => {
    const assignedFreight = {
      id: 'f1', code: 'FLT-0001', status: 'assigned',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      assignments: [{ id: 'a1', transportCompanyId: 'comp-trans', status: 'active' }],
    };

    beforeEach(() => {
      mockPrisma.freight.findUnique.mockResolvedValue(assignedFreight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
    });

    it('throws on accept (accept is done via updateAssignment now)', async () => {
      await expect(
        service.respond('f1', { action: 'accepted' } as any, transportUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects assignment with reason', async () => {
      mockPrisma.freightAssignment.update.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...assignedFreight, status: 'pending_assignment' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.respond('f1', { action: 'rejected', reason: 'No disponible' } as any, transportUser);

      expect(result.status).toBe('pending_assignment');
    });

    it('throws when rejecting without reason', async () => {
      await expect(
        service.respond('f1', { action: 'rejected', reason: '' } as any, transportUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when not transporter (reject action)', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);

      await expect(
        service.respond('f1', { action: 'rejected', reason: 'No disponible' } as any, user),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws when company not assigned (reject action)', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-other']);

      await expect(
        service.respond('f1', { action: 'rejected', reason: 'No disponible' } as any, transportUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ================================================================
  // START
  // ================================================================
  describe('start', () => {
    const acceptedFreight = {
      id: 'f1', code: 'FLT-0001', status: 'accepted',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      assignments: [{ transportCompanyId: 'comp-trans', truckId: 'truck-1', driverId: 'driver-1', status: 'accepted' }],
    };

    it('starts freight', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(acceptedFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...acceptedFreight, status: 'in_progress' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.start('f1', transportUser);

      expect(result.status).toBe('in_progress');
      expect(mockStateMachine.validateTransition).toHaveBeenCalledWith(
        'accepted', 'in_progress', 'transporter',
      );
    });

    it('producer with own fleet can start (effectiveType = transporter)', async () => {
      const ownFleetFreight = {
        ...acceptedFreight,
        assignments: [{ transportCompanyId: 'comp-prod', truckId: 'truck-1', driverId: 'driver-1', status: 'accepted' }],
      };
      mockPrisma.freight.findUnique.mockResolvedValue(ownFleetFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.update.mockResolvedValue({ ...ownFleetFreight, status: 'in_progress' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await service.start('f1', user);

      expect(mockStateMachine.validateTransition).toHaveBeenCalledWith(
        'accepted', 'in_progress', 'transporter',
      );
    });

    it('throws when freight not found', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(null);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      // First findUnique (access check) returns null
      await expect(service.start('missing', transportUser)).rejects.toThrow(NotFoundException);
    });
  });

  // ================================================================
  // CANCEL
  // ================================================================
  describe('cancel', () => {
    const pendingFreight = {
      id: 'f1', code: 'FLT-0001', status: 'pending_assignment',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      assignments: [],
    };

    it('cancels pending freight', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(pendingFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...pendingFreight, status: 'canceled' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.cancel('f1', { reason: 'Ya no necesito' } as any, user);

      expect(result.status).toBe('canceled');
    });

    it('throws when in_progress', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...pendingFreight, status: 'in_progress', assignments: [],
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when loaded', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...pendingFreight, status: 'loaded', assignments: [],
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('notifies all parties', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...pendingFreight,
        assignments: [{ transportCompanyId: 'comp-trans' }],
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...pendingFreight, status: 'canceled' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      await service.cancel('f1', { reason: 'Cambio de planes' } as any, user);

      // Should notify origin, dest, and transporter
      expect(mockNotifications.notifyCompany).toHaveBeenCalledTimes(3);
    });
  });

  // ================================================================
  // CONFIRM LOADED
  // ================================================================
  describe('confirmLoaded', () => {
    const inProgressFreight = {
      id: 'f1', code: 'FLT-0001', status: 'in_progress',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      transporterLoadedConfirmedAt: null,
      producerLoadedConfirmedAt: null,
      assignments: [{ transportCompanyId: 'comp-trans' }],
    };

    it('transporter confirms load', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(inProgressFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...inProgressFreight, status: 'loaded' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', transportUser);

      expect(result.status).toBe('loaded');
    });

    it('transporter cannot confirm twice', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...inProgressFreight, transporterLoadedConfirmedAt: new Date(),
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);

      await expect(service.confirmLoaded('f1', transportUser)).rejects.toThrow(BadRequestException);
    });

    it('producer confirms after transporter (status stays loaded)', async () => {
      const loadedFreight = {
        ...inProgressFreight, status: 'loaded',
        transporterLoadedConfirmedAt: new Date(),
      };
      mockPrisma.freight.findUnique.mockResolvedValue(loadedFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.update.mockResolvedValue(loadedFreight);
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', user);

      expect(mockPrisma.freight.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ producerLoadedConfirmedAt: expect.any(Date) }),
        }),
      );
    });

    it('throws for plant', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(inProgressFreight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');

      await expect(service.confirmLoaded('f1', plantUser)).rejects.toThrow(ForbiddenException);
    });
  });

  // ================================================================
  // CONFIRM FINISHED
  // ================================================================
  describe('confirmFinished', () => {
    const loadedFreight = {
      id: 'f1', code: 'FLT-0001', status: 'loaded',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      transporterFinishedConfirmedAt: null,
      plantFinishedConfirmedAt: null,
    };

    it('transporter confirms — plant not yet → stays loaded', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({ ...loadedFreight, assignments: [{ transportCompanyId: 'comp-trans', status: 'accepted' }] });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue(loadedFreight);
      mockPrisma.auditLog.create.mockResolvedValue({});

      await service.confirmFinished('f1', transportUser);

      expect(mockPrisma.freight.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transporterFinishedConfirmedAt: expect.any(Date),
          }),
        }),
      );
      // Status should NOT change to finished
      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.status).toBeUndefined();
    });

    it('plant confirms after transporter → finishes', async () => {
      const f = {
        ...loadedFreight,
        transporterFinishedConfirmedAt: new Date(),
        assignments: [{ transportCompanyId: 'comp-trans', status: 'accepted' }],
      };
      mockPrisma.freight.findUnique.mockResolvedValue(f);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.freight.update.mockResolvedValue({ ...f, status: 'finished' });
      mockPrisma.auditLog.create.mockResolvedValue({});
      mockPrisma.freightAssignment.findFirst.mockResolvedValue({ transportCompanyId: 'comp-trans' });

      const result = await service.confirmFinished('f1', plantUser);

      expect(result.status).toBe('finished');
      expect(mockStateMachine.validateTransition).toHaveBeenCalled();
    });

    it('transporter confirms after plant → finishes', async () => {
      const f = {
        ...loadedFreight,
        plantFinishedConfirmedAt: new Date(),
        assignments: [{ transportCompanyId: 'comp-trans', status: 'accepted' }],
      };
      mockPrisma.freight.findUnique.mockResolvedValue(f);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...f, status: 'finished' });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.confirmFinished('f1', transportUser);

      expect(result.status).toBe('finished');
    });

    it('throws when not loaded', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...loadedFreight, status: 'in_progress',
      });

      await expect(service.confirmFinished('f1', transportUser)).rejects.toThrow(BadRequestException);
    });

    it('transporter cannot confirm twice', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...loadedFreight, transporterFinishedConfirmedAt: new Date(),
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');

      await expect(service.confirmFinished('f1', transportUser)).rejects.toThrow(BadRequestException);
    });

    it('plant cannot confirm twice', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...loadedFreight, plantFinishedConfirmedAt: new Date(),
        assignments: [{ transportCompanyId: 'comp-trans', status: 'accepted' }],
      });
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);

      await expect(service.confirmFinished('f1', plantUser)).rejects.toThrow(BadRequestException);
    });
  });

  // ================================================================
  // UPDATE FREIGHT
  // ================================================================
  describe('updateFreight', () => {
    const pendingFreight = {
      id: 'f1', status: 'pending_assignment', requestedById: 'user-1',
      originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
      loadTime: '08:00',
      assignments: [],
      items: [{ tons: 30 }],
    };

    it('updates pending freight', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(pendingFreight);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.update.mockResolvedValue({
        ...pendingFreight, notes: 'Updated',
      });
      mockPrisma.auditLog.create.mockResolvedValue({});

      const result = await service.updateFreight('f1', { notes: 'Updated' }, user);

      expect(result.notes).toBe('Updated');
    });

    it('throws when freight is finished', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        ...pendingFreight, status: 'finished',
      });
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.updateFreight('f1', { notes: 'x' }, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when different user', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue(pendingFreight);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-other']);

      await expect(
        service.updateFreight('f1', { notes: 'x' }, { sub: 'other-user' }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ================================================================
  // TRACKING
  // ================================================================
  describe('tracking', () => {
    it('addTrackingPoint creates point for in_progress freight', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        id: 'f1', status: 'in_progress',
      });
      mockPrisma.freightTracking.create.mockResolvedValue({
        id: 'tp-1', lat: -34.5, lng: -56.2,
      });

      const result = await service.addTrackingPoint('f1', { lat: -34.5, lng: -56.2 }, user);

      expect(result.lat).toBe(-34.5);
    });

    it('addTrackingPoint throws when not in_progress or loaded', async () => {
      mockPrisma.freight.findUnique.mockResolvedValue({
        id: 'f1', status: 'pending_assignment',
      });

      await expect(
        service.addTrackingPoint('f1', { lat: -34.5, lng: -56.2 }, user),
      ).rejects.toThrow(BadRequestException);
    });

    it('getTrackingPoints returns ordered list', async () => {
      const points = [{ id: 'tp1' }, { id: 'tp2' }];
      mockPrisma.freightTracking.findMany.mockResolvedValue(points);

      const result = await service.getTrackingPoints('f1');

      expect(result).toHaveLength(2);
    });

    it('getLastPosition returns most recent', async () => {
      mockPrisma.freightTracking.findFirst.mockResolvedValue({ id: 'tp2', lat: -34.6 });

      const result = await service.getLastPosition('f1');

      expect(result.lat).toBe(-34.6);
    });
  });

  // ================================================================
  // ADD DOCUMENT
  // ================================================================
  describe('addDocument', () => {
    it('creates document', async () => {
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.findUnique.mockResolvedValue({
        id: 'f1', originCompanyId: 'comp-prod', destCompanyId: 'comp-plant',
        assignments: [],
      });
      mockPrisma.freightDocument.count.mockResolvedValue(0);
      mockPrisma.freightDocument.create.mockResolvedValue({
        id: 'doc-1', name: 'Carta porte', url: 'https://storage/doc.jpg',
      });

      const result = await service.addDocument('f1', {
        name: 'Carta porte', url: 'https://storage/doc.jpg',
      }, user);

      expect(result.name).toBe('Carta porte');
    });

    it('throws when freight not found', async () => {
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.findUnique.mockResolvedValue(null);

      await expect(
        service.addDocument('missing', { name: 'x', url: 'x' }, user),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ================================================================
  // AUDIT LOG
  // ================================================================
  describe('getAuditLog', () => {
    it('returns audit entries', async () => {
      mockPrisma.auditLog.findMany.mockResolvedValue([
        { action: 'created' },
        { action: 'assigned' },
      ]);

      const result = await service.getAuditLog('f1');

      expect(result).toHaveLength(2);
    });
  });
});
