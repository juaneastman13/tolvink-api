import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { FreightsService } from '../freights.service';
import { PrismaService } from '../../database/prisma.service';
import { CompanyResolutionService } from '../../common/services/company-resolution.service';
import { FreightStateMachine } from '../freight-state-machine.service';
import { NotificationService } from '../../notifications/notification.service';
import { ConfigService } from '@nestjs/config';
import { SseService } from '../../sse/sse.service';

// Mock @prisma/client enums
jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
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

// =====================================================================
// HELPERS
// =====================================================================

const plantUser = { sub: 'user-plant', companyId: 'comp-plant', companyType: 'plant', role: 'gerente' };
const transportUser = { sub: 'user-trans', companyId: 'comp-trans', companyType: 'transporter', role: 'operario' };
const producerUser = { sub: 'user-prod', companyId: 'comp-prod', companyType: 'producer', role: 'gerente' };
const choferUser = { sub: 'user-chofer', companyId: 'comp-trans', companyType: 'transporter', role: 'chofer' };

function makeFreight(overrides: Record<string, any> = {}) {
  return {
    id: 'f1',
    code: 'F26-ABC.0001',
    status: 'pending_assignment',
    originCompanyId: 'comp-prod',
    destCompanyId: 'comp-plant',
    isMultiTruck: false,
    truckCount: 1,
    assignedTruckCount: 0,
    transporterLoadedConfirmedAt: null,
    producerLoadedConfirmedAt: null,
    transporterFinishedConfirmedAt: null,
    plantFinishedConfirmedAt: null,
    startedAt: null,
    loadedAt: null,
    finishedAt: null,
    conversation: { id: 'conv-1' },
    assignments: [],
    ...overrides,
  };
}

function makeAssignment(overrides: Record<string, any> = {}) {
  return {
    id: 'a1',
    freightId: 'f1',
    transportCompanyId: 'comp-trans',
    status: 'active',
    tripStatus: 'pending',
    tripNumber: 1,
    driverId: null,
    transporterLoadedConfirmedAt: null,
    producerLoadedConfirmedAt: null,
    transporterFinishedConfirmedAt: null,
    plantFinishedConfirmedAt: null,
    ...overrides,
  };
}

// =====================================================================
// TEST SUITE
// =====================================================================

describe('Freight State Machine — Integration Tests', () => {
  let service: FreightsService;
  let stateMachine: FreightStateMachine;
  let mockPrisma: any;
  let mockCompanyRes: any;

  // Transaction proxy — delegates to mockPrisma
  const txProxy: any = {};

  function setupMocks() {
    mockPrisma = {
      lot: { findFirst: jest.fn() },
      plant: { findFirst: jest.fn() },
      company: { findFirst: jest.fn() },
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
        aggregate: jest.fn().mockResolvedValue({ _max: { queuePosition: 0 } }),
      },
      freightTracking: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn() },
      freightDocument: { create: jest.fn(), count: jest.fn().mockResolvedValue(0) },
      auditLog: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn() },
      conversationParticipant: { upsert: jest.fn().mockResolvedValue({}) },
      userCompany: { findMany: jest.fn() },
      companyAccess: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
      freightPendingChange: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
      $transaction: jest.fn((cb: any) => cb(txProxy)),
      $queryRaw: jest.fn().mockResolvedValue([{ maxPos: 0 }]),
    };
    // txProxy delegates to mockPrisma (minus $transaction)
    Object.keys(mockPrisma).forEach((k) => {
      if (k !== '$transaction') txProxy[k] = mockPrisma[k];
    });

    mockCompanyRes = {
      resolveCompanyType: jest.fn(),
      hasCompanyType: jest.fn(),
      resolveAllCompanyIds: jest.fn(),
      resolveProducerCompanyId: jest.fn(),
      resolvePlantCompanyId: jest.fn(),
      resolveAllProducerCompanyIds: jest.fn(),
    };
  }

  beforeEach(async () => {
    setupMocks();

    // Use a REAL FreightStateMachine — tests validate actual transition rules
    stateMachine = new FreightStateMachine();

    const mockNotifications = {
      notifyCompany: jest.fn().mockResolvedValue(undefined),
      notify: jest.fn().mockResolvedValue(undefined),
    };

    const mockSse = {
      broadcastFreightUpdate: jest.fn().mockResolvedValue(undefined),
      invalidateParticipantsCache: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FreightsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CompanyResolutionService, useValue: mockCompanyRes },
        { provide: FreightStateMachine, useValue: stateMachine },
        { provide: NotificationService, useValue: mockNotifications },
        { provide: SseService, useValue: mockSse },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();

    service = module.get(FreightsService);

    // Inject SSE mock (private property)
    (service as any).sse = mockSse;
  });

  // ================================================================
  // 1. TRANSICIONES VÁLIDAS — CICLO FELIZ
  // ================================================================
  describe('1. Transiciones válidas — ciclo feliz', () => {

    it('pending_assignment → assigned (planta asigna transportista)', async () => {
      const freight = makeFreight({ status: 'pending_assignment' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true); // is plant
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.company.findFirst.mockResolvedValue({ id: 'comp-trans', type: 'transporter', types: ['transporter'] });
      mockPrisma.freightAssignment.create.mockResolvedValue({ id: 'a1' });
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'assigned' });

      const result = await service.assign('f1', { transportCompanyId: 'comp-trans' } as any, plantUser);

      expect(result.status).toBe('assigned');
    });

    it('assigned → accepted (now done via updateAssignment, respond(accepted) throws)', async () => {
      // respond('accepted') is no longer valid — trips accept by assigning truck+driver
      await expect(
        service.respond('f1', { action: 'accepted' } as any, transportUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepted → in_progress (transportista inicia viaje)', async () => {
      const freight = makeFreight({
        status: 'accepted',
        assignments: [makeAssignment({ status: 'accepted', truckId: 'truck-1', driverId: 'driver-1' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'in_progress' });

      const result = await service.start('f1', transportUser);

      expect(result.status).toBe('in_progress');
    });

    it('in_progress → loaded (transportista confirma carga)', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'loaded' });
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', transportUser);

      expect(result.status).toBe('loaded');
    });

    it('loaded → finished (ambos confirman entrega)', async () => {
      // Transporter confirms first
      const freight = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
        transporterFinishedConfirmedAt: null,
        plantFinishedConfirmedAt: null,
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, transporterFinishedConfirmedAt: new Date() });

      await service.confirmFinished('f1', transportUser);

      // Plant confirms second → finished
      const freightAfterTransporter = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
        transporterFinishedConfirmedAt: new Date(),
        plantFinishedConfirmedAt: null,
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freightAfterTransporter);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.freight.update.mockResolvedValue({ ...freightAfterTransporter, status: 'finished' });

      const result = await service.confirmFinished('f1', plantUser);

      expect(result.status).toBe('finished');
    });
  });

  // ================================================================
  // 2. TRANSICIONES INVÁLIDAS — ROLES INCORRECTOS
  // ================================================================
  describe('2. Transiciones inválidas — roles incorrectos', () => {

    it('productor NO puede asignar transportista (solo planta)', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);

      await expect(
        service.assign('f1', { transportCompanyId: 'comp-trans' } as any, producerUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('productor NO puede aceptar asignación (respond(accepted) throws for all)', async () => {
      await expect(
        service.respond('f1', { action: 'accepted' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('productor NO puede iniciar viaje (solo transportista)', async () => {
      const freight = makeFreight({
        status: 'accepted',
        assignments: [makeAssignment({ status: 'accepted', truckId: 'truck-1', driverId: 'driver-1' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      // State machine should reject producer → in_progress
      await expect(service.start('f1', producerUser)).rejects.toThrow(BadRequestException);
    });

    it('planta NO puede confirmar carga (solo transportista/productor)', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null); // not CONSULTA

      await expect(service.confirmLoaded('f1', plantUser)).rejects.toThrow(ForbiddenException);
    });

    it('productor NO puede confirmar finalización (solo transportista/planta)', async () => {
      const freight = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(service.confirmFinished('f1', producerUser)).rejects.toThrow(ForbiddenException);
    });

    it('chofer NO puede cancelar', async () => {
      await expect(
        service.cancel('f1', { reason: 'test' } as any, choferUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('in_progress NO permite saltar a finished directamente', () => {
      expect(() =>
        stateMachine.validateTransition('in_progress' as any, 'finished' as any, 'transporter'),
      ).toThrow(BadRequestException);
    });

    it('loaded NO permite cancelar', () => {
      expect(() =>
        stateMachine.validateTransition('loaded' as any, 'canceled' as any, 'transporter', 'motivo'),
      ).toThrow(BadRequestException);
    });

    it('in_progress NO permite cancelar', () => {
      expect(() =>
        stateMachine.validateTransition('in_progress' as any, 'canceled' as any, 'transporter', 'motivo'),
      ).toThrow(BadRequestException);
    });
  });

  // ================================================================
  // 3. CROSS-CONFIRMATIONS DE CARGA (loaded)
  // ================================================================
  describe('3. Cross-confirmations de carga', () => {

    it('transportista confirma → estado cambia a loaded', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'loaded' });
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', transportUser);

      expect(result.status).toBe('loaded');
      // Verify transporterLoadedConfirmedAt is set
      expect(mockPrisma.freight.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transporterLoadedConfirmedAt: expect.any(Date),
            status: 'loaded',
          }),
        }),
      );
    });

    it('productor confirma DESPUÉS del transportista (estado queda loaded, se registra)', async () => {
      const freight = makeFreight({
        status: 'loaded',
        transporterLoadedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.update.mockResolvedValue(freight);

      await service.confirmLoaded('f1', producerUser);

      expect(mockPrisma.freight.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            producerLoadedConfirmedAt: expect.any(Date),
          }),
        }),
      );
      // Status should NOT be in the update data (stays loaded)
      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.status).toBeUndefined();
    });

    it('una sola confirmación (transportista) NO es suficiente para finished', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'loaded' });
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', transportUser);

      // Should be loaded, NOT finished
      expect(result.status).toBe('loaded');
      expect(result.status).not.toBe('finished');
    });

    it('transportista NO puede confirmar carga dos veces', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        transporterLoadedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);

      await expect(service.confirmLoaded('f1', transportUser)).rejects.toThrow(BadRequestException);
    });

    it('productor NO puede confirmar carga dos veces', async () => {
      const freight = makeFreight({
        status: 'loaded',
        transporterLoadedConfirmedAt: new Date(),
        producerLoadedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(service.confirmLoaded('f1', producerUser)).rejects.toThrow(BadRequestException);
    });

    it('productor con flota propia actúa como transportista al confirmar carga', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        originCompanyId: 'comp-prod',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-prod' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'loaded' });
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});

      const result = await service.confirmLoaded('f1', producerUser);

      expect(result.status).toBe('loaded');
      // Both confirmations should be set (own fleet)
      expect(mockPrisma.freight.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            transporterLoadedConfirmedAt: expect.any(Date),
            producerLoadedConfirmedAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  // ================================================================
  // 4. CROSS-CONFIRMATIONS DE ENTREGA (finished)
  // ================================================================
  describe('4. Cross-confirmations de entrega', () => {

    it('transportista confirma primero → estado queda loaded', async () => {
      const freight = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue(freight);

      await service.confirmFinished('f1', transportUser);

      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.transporterFinishedConfirmedAt).toBeInstanceOf(Date);
      expect(updateData.status).toBeUndefined(); // stays loaded
    });

    it('planta confirma después del transportista → estado cambia a finished', async () => {
      const freight = makeFreight({
        status: 'loaded',
        transporterFinishedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'finished' });

      const result = await service.confirmFinished('f1', plantUser);

      expect(result.status).toBe('finished');
      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.status).toBe('finished');
      expect(updateData.finishedAt).toBeInstanceOf(Date);
    });

    it('planta confirma primero → estado queda loaded', async () => {
      const freight = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);
      mockPrisma.freight.update.mockResolvedValue(freight);

      await service.confirmFinished('f1', plantUser);

      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.plantFinishedConfirmedAt).toBeInstanceOf(Date);
      expect(updateData.status).toBeUndefined(); // stays loaded
    });

    it('transportista confirma después de planta → estado cambia a finished', async () => {
      const freight = makeFreight({
        status: 'loaded',
        plantFinishedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'finished' });

      const result = await service.confirmFinished('f1', transportUser);

      expect(result.status).toBe('finished');
      const updateData = mockPrisma.freight.update.mock.calls[0][0].data;
      expect(updateData.status).toBe('finished');
    });

    it('transportista NO puede confirmar entrega dos veces', async () => {
      const freight = makeFreight({
        status: 'loaded',
        transporterFinishedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);

      await expect(service.confirmFinished('f1', transportUser)).rejects.toThrow(BadRequestException);
    });

    it('planta NO puede confirmar entrega dos veces', async () => {
      const freight = makeFreight({
        status: 'loaded',
        plantFinishedConfirmedAt: new Date(),
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('plant');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-plant']);

      await expect(service.confirmFinished('f1', plantUser)).rejects.toThrow(BadRequestException);
    });

    it('confirmFinished requiere estado loaded (falla si in_progress)', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);

      await expect(service.confirmFinished('f1', transportUser)).rejects.toThrow(BadRequestException);
    });
  });

  // ================================================================
  // 5. MULTI-TRUCK — deriveFreightStatus
  // ================================================================
  describe('5. Multi-truck — freight finishes only when ALL trips finish', () => {

    it('3 trucks: 2 finished + 1 loaded → freight stays loaded', async () => {
      // Test deriveFreightStatus logic via the private method
      const freight = makeFreight({
        status: 'loaded',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 3,
      });

      // Mock for deriveFreightStatus internal calls
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'finished' },
        { tripStatus: 'finished' },
        { tripStatus: 'loaded' },
      ]);

      // Call deriveFreightStatus via reflection
      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('loaded');
    });

    it('3 trucks: ALL finished → freight moves to finished', async () => {
      const freight = makeFreight({
        status: 'loaded',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 3,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'finished' },
        { tripStatus: 'finished' },
        { tripStatus: 'finished' },
      ]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('finished');
    });

    it('3 trucks: mixed states → freight takes MINIMUM status', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 3,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'finished' },
        { tripStatus: 'in_progress' },
        { tripStatus: 'accepted' },
      ]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      // min is accepted (rank 1) → FreightStatus.accepted
      // But monotonic guard prevents regression from in_progress
      expect(result).toBe('in_progress');
    });

    it('3 trucks: all in_progress → freight is in_progress', async () => {
      const freight = makeFreight({
        status: 'accepted',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 3,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'in_progress' },
        { tripStatus: 'in_progress' },
        { tripStatus: 'in_progress' },
      ]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('in_progress');
    });

    it('3 trucks: all pending → freight is assigned', async () => {
      const freight = makeFreight({
        status: 'assigned',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 3,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'pending' },
        { tripStatus: 'pending' },
        { tripStatus: 'pending' },
      ]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('assigned');
    });

    it('fewer assignments than truckCount → regresses to pending_assignment', async () => {
      const freight = makeFreight({
        status: 'assigned',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 2,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([
        { tripStatus: 'pending' },
        { tripStatus: 'pending' },
      ]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('pending_assignment');
    });

    it('no assignments → regresses to pending_assignment', async () => {
      const freight = makeFreight({
        status: 'assigned',
        isMultiTruck: true,
        truckCount: 3,
        assignedTruckCount: 0,
      });

      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockPrisma.freightAssignment.findMany.mockResolvedValue([]);

      const result = await (service as any).deriveFreightStatus(txProxy, 'f1');

      expect(result).toBe('pending_assignment');
    });

    it('confirmTripFinished: multi-truck freight rejects single-truck endpoint', async () => {
      const freight = makeFreight({
        status: 'loaded',
        isMultiTruck: true,
        assignments: [makeAssignment({ status: 'accepted', transportCompanyId: 'comp-trans' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);

      // Single-truck confirmFinished should reject multi-truck freights
      await expect(service.confirmFinished('f1', transportUser)).rejects.toThrow(BadRequestException);
    });
  });

  // ================================================================
  // 6. CANCELACIÓN
  // ================================================================
  describe('6. Cancelación', () => {

    it('cancela desde draft', async () => {
      const freight = makeFreight({ status: 'draft' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'canceled' });

      const result = await service.cancel('f1', { reason: 'Ya no necesito' } as any, producerUser);

      expect(result.status).toBe('canceled');
    });

    it('cancela desde pending_assignment', async () => {
      const freight = makeFreight({ status: 'pending_assignment' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'canceled' });

      const result = await service.cancel('f1', { reason: 'Cambio de planes' } as any, producerUser);

      expect(result.status).toBe('canceled');
    });

    it('cancela desde assigned', async () => {
      const freight = makeFreight({
        status: 'assigned',
        assignments: [makeAssignment()],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'canceled' });

      const result = await service.cancel('f1', { reason: 'Cancelado' } as any, producerUser);

      expect(result.status).toBe('canceled');
    });

    it('cancela desde accepted', async () => {
      const freight = makeFreight({
        status: 'accepted',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'canceled' });

      const result = await service.cancel('f1', { reason: 'Cancelado' } as any, producerUser);

      expect(result.status).toBe('canceled');
    });

    it('NO se puede cancelar desde in_progress', async () => {
      const freight = makeFreight({
        status: 'in_progress',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('NO se puede cancelar desde loaded', async () => {
      const freight = makeFreight({
        status: 'loaded',
        assignments: [makeAssignment({ status: 'accepted' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('NO se puede cancelar un flete ya finished', async () => {
      const freight = makeFreight({ status: 'finished' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('NO se puede cancelar un flete ya cancelado', async () => {
      const freight = makeFreight({ status: 'canceled' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('cancelación en cascada: assignments activas se cancelan', async () => {
      const freight = makeFreight({
        status: 'assigned',
        assignments: [makeAssignment(), makeAssignment({ id: 'a2', transportCompanyId: 'comp-trans-2' })],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);
      mockPrisma.freightAssignment.updateMany.mockResolvedValue({ count: 2 });
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'canceled' });

      await service.cancel('f1', { reason: 'Cancelado' } as any, producerUser);

      expect(mockPrisma.freightAssignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            freightId: 'f1',
            status: { in: ['active', 'accepted'] },
          }),
          data: expect.objectContaining({
            status: 'canceled',
            reason: 'Flete cancelado',
          }),
        }),
      );
    });

    it('cancelación requiere motivo', async () => {
      const freight = makeFreight({ status: 'pending_assignment' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('producer');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-prod']);

      // State machine requires reason for cancel
      await expect(
        service.cancel('f1', { reason: '' } as any, producerUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('solo participantes pueden cancelar', async () => {
      const freight = makeFreight({ status: 'pending_assignment' });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.resolveCompanyType.mockResolvedValue('transporter');
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-unrelated']);

      await expect(
        service.cancel('f1', { reason: 'test' } as any, transportUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ================================================================
  // 7. RECHAZO
  // ================================================================
  describe('7. Rechazo — transportista rechaza asignación', () => {

    it('rechazo → freight vuelve a pending_assignment', async () => {
      const freight = makeFreight({
        status: 'assigned',
        assignments: [makeAssignment()],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freightAssignment.update.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'pending_assignment' });

      const result = await service.respond('f1', { action: 'rejected', reason: 'No disponible' } as any, transportUser);

      expect(result.status).toBe('pending_assignment');
    });

    it('rechazo requiere motivo', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);

      await expect(
        service.respond('f1', { action: 'rejected', reason: '' } as any, transportUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechazo sin motivo falla', async () => {
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);

      await expect(
        service.respond('f1', { action: 'rejected' } as any, transportUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('rechazo actualiza assignment a rejected', async () => {
      const freight = makeFreight({
        status: 'assigned',
        assignments: [makeAssignment()],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-trans']);
      mockPrisma.freightAssignment.update.mockResolvedValue({});
      mockPrisma.freight.update.mockResolvedValue({ ...freight, status: 'pending_assignment' });

      await service.respond('f1', { action: 'rejected', reason: 'Sin camiones' } as any, transportUser);

      expect(mockPrisma.freightAssignment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'rejected',
            reason: 'Sin camiones',
          }),
        }),
      );
    });

    it('empresa no asignada NO puede rechazar', async () => {
      const freight = makeFreight({
        status: 'assigned',
        assignments: [makeAssignment()],
      });
      mockPrisma.freight.findUnique.mockResolvedValue(freight);
      mockCompanyRes.hasCompanyType.mockResolvedValue(true);
      mockCompanyRes.resolveAllCompanyIds.mockResolvedValue(['comp-other']);

      await expect(
        service.respond('f1', { action: 'rejected', reason: 'test' } as any, transportUser),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ================================================================
  // 8. STATE MACHINE PURA — Transiciones exhaustivas
  // ================================================================
  describe('8. FreightStateMachine — validaciones puras', () => {

    describe('getAllowedTransitions', () => {
      it.each([
        ['draft', ['pending_assignment', 'canceled']],
        ['pending_assignment', ['assigned', 'accepted', 'canceled']],
        ['assigned', ['accepted', 'pending_assignment', 'canceled']],
        ['accepted', ['in_progress', 'pending_assignment', 'canceled']],
        ['in_progress', ['loaded']],
        ['loaded', ['finished']],
        ['finished', []],
        ['canceled', []],
      ])('%s → %j', (status, expected) => {
        const allowed = stateMachine.getAllowedTransitions(status as any);
        expect(allowed).toEqual(expected);
      });
    });

    describe('validateTransition — roles', () => {
      it('pending_assignment → assigned requiere plant', () => {
        expect(() => stateMachine.validateTransition('pending_assignment' as any, 'assigned' as any, 'plant')).not.toThrow();
        expect(() => stateMachine.validateTransition('pending_assignment' as any, 'assigned' as any, 'transporter')).toThrow();
        expect(() => stateMachine.validateTransition('pending_assignment' as any, 'assigned' as any, 'producer')).toThrow();
      });

      it('assigned → accepted requiere transporter o plant', () => {
        expect(() => stateMachine.validateTransition('assigned' as any, 'accepted' as any, 'transporter')).not.toThrow();
        expect(() => stateMachine.validateTransition('assigned' as any, 'accepted' as any, 'plant')).not.toThrow();
        expect(() => stateMachine.validateTransition('assigned' as any, 'accepted' as any, 'producer')).toThrow();
      });

      it('accepted → in_progress requiere transporter o plant', () => {
        expect(() => stateMachine.validateTransition('accepted' as any, 'in_progress' as any, 'transporter')).not.toThrow();
        expect(() => stateMachine.validateTransition('accepted' as any, 'in_progress' as any, 'plant')).not.toThrow();
        expect(() => stateMachine.validateTransition('accepted' as any, 'in_progress' as any, 'producer')).toThrow();
      });

      it('in_progress → loaded requiere transporter o plant', () => {
        expect(() => stateMachine.validateTransition('in_progress' as any, 'loaded' as any, 'transporter')).not.toThrow();
        expect(() => stateMachine.validateTransition('in_progress' as any, 'loaded' as any, 'plant')).not.toThrow();
        expect(() => stateMachine.validateTransition('in_progress' as any, 'loaded' as any, 'producer')).toThrow();
      });

      it('loaded → finished requiere transporter o plant', () => {
        expect(() => stateMachine.validateTransition('loaded' as any, 'finished' as any, 'transporter')).not.toThrow();
        expect(() => stateMachine.validateTransition('loaded' as any, 'finished' as any, 'plant')).not.toThrow();
        expect(() => stateMachine.validateTransition('loaded' as any, 'finished' as any, 'producer')).toThrow();
      });
    });

    describe('validateTransition — estados terminales', () => {
      it('finished no admite transiciones', () => {
        expect(() => stateMachine.validateTransition('finished' as any, 'draft' as any)).toThrow();
        expect(() => stateMachine.validateTransition('finished' as any, 'canceled' as any)).toThrow();
      });

      it('canceled no admite transiciones', () => {
        expect(() => stateMachine.validateTransition('canceled' as any, 'draft' as any)).toThrow();
        expect(() => stateMachine.validateTransition('canceled' as any, 'pending_assignment' as any)).toThrow();
      });
    });

    describe('validateTripTransition', () => {
      it('pending → accepted', () => {
        expect(() => stateMachine.validateTripTransition('pending', 'accepted')).not.toThrow();
      });

      it('accepted → in_progress', () => {
        expect(() => stateMachine.validateTripTransition('accepted', 'in_progress')).not.toThrow();
      });

      it('in_progress → loaded', () => {
        expect(() => stateMachine.validateTripTransition('in_progress', 'loaded')).not.toThrow();
      });

      it('loaded → finished', () => {
        expect(() => stateMachine.validateTripTransition('loaded', 'finished')).not.toThrow();
      });

      it('finished es terminal', () => {
        expect(() => stateMachine.validateTripTransition('finished', 'pending')).toThrow();
      });

      it('canceled es terminal', () => {
        expect(() => stateMachine.validateTripTransition('canceled', 'pending')).toThrow();
      });

      it('salto inválido pending → in_progress', () => {
        expect(() => stateMachine.validateTripTransition('pending', 'in_progress')).toThrow();
      });

      it('salto inválido in_progress → finished', () => {
        expect(() => stateMachine.validateTripTransition('in_progress', 'finished')).toThrow();
      });
    });
  });
});
