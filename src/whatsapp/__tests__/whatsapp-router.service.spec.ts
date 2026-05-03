jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

jest.mock('../../freights/freights.service', () => ({
  FreightsService: class FreightsService {},
}));

jest.mock('../whatsapp-flow.service', () => ({
  WhatsAppFlowService: class WhatsAppFlowService {},
}));

jest.mock('../../ai/agent.service', () => ({
  AgentService: class AgentService {},
}));

import { WhatsAppRouterService } from '../whatsapp-router.service';

describe('WhatsAppRouterService', () => {
  let service: WhatsAppRouterService;
  let prisma: any;
  let wa: any;
  let flow: any;
  let freights: any;
  let ai: any;
  let agentV2: any;

  const phone = '59899111222';
  const driverUser = {
    id: 'driver-1',
    role: 'operator',
    companyId: 'transporter-1',
    activeCompanyId: 'transporter-1',
    company: { types: ['transporter'] },
    memberships: [
      {
        companyId: 'transporter-1',
        active: true,
        role: 'chofer',
        company: { types: ['transporter'] },
      },
    ],
  };

  const multiCompanyUser = {
    id: 'multi-1',
    role: 'chofer',
    companyId: 'producer-1',
    activeCompanyId: 'producer-1',
    company: { type: 'producer', types: ['producer'], autonomousDriverEnabled: false },
    memberships: [
      {
        companyId: 'producer-1',
        active: true,
        role: 'gerente',
        company: { type: 'producer', types: ['producer'], autonomousDriverEnabled: false, name: 'Prod Uno' },
      },
      {
        companyId: 'producer-2',
        active: true,
        role: 'chofer',
        company: { type: 'producer', types: ['producer'], autonomousDriverEnabled: true, name: 'Prod Dos' },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      freight: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
      },
      whatsAppSession: {
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      whatsAppMessageLog: {
        count: jest.fn().mockResolvedValue(0),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    };

    wa = {
      sendText: jest.fn().mockResolvedValue(null),
      sendButtons: jest.fn().mockResolvedValue(null),
      sendSelection: jest.fn().mockResolvedValue({
        shownItems: [],
        page: 1,
        totalPages: 1,
        totalItems: 1,
      }),
      normalizePhone: jest.fn((value: string) => value),
    };

    flow = {
      startFlow: jest.fn().mockResolvedValue(undefined),
    };

    freights = {
      start: jest.fn().mockResolvedValue({}),
      confirmFinished: jest.fn().mockResolvedValue({}),
    };

    ai = {
      isEnabled: jest.fn().mockReturnValue(true),
      chat: jest.fn(),
      cancelPendingAction: jest.fn().mockResolvedValue(true),
    };

    agentV2 = {
      isEnabled: jest.fn().mockReturnValue(false),
      getMode: jest.fn().mockReturnValue('legacy'),
      chat: jest.fn(),
      handleLocation: jest.fn().mockResolvedValue({ text: 'Ubicacion recibida' }),
    };

    service = new WhatsAppRouterService(prisma, wa, flow, freights, ai, agentV2 as any);
  });

  describe('driver actions', () => {
    it('should show driver-only active trips with the proper selection copy', async () => {
      prisma.freight.findMany.mockResolvedValue([
        {
          id: 'freight-1',
          code: 'F26-AAA.0001',
          status: 'accepted',
          items: [{ grain: 'Soja', tons: 30 }],
          assignments: [{ transportCompany: { id: 'transporter-1', name: 'Trans Uy' } }],
        },
      ]);

      await service.showActiveFreights(phone, driverUser);

      expect(prisma.freight.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { notIn: ['finished', 'canceled'] },
            OR: expect.arrayContaining([
              expect.objectContaining({
                assignments: {
                  some: {
                    driverId: 'driver-1',
                    status: { in: ['active', 'accepted'] },
                  },
                },
              }),
              expect.objectContaining({
                requestedById: 'driver-1',
                isAutonomous: true,
              }),
            ]),
          }),
        }),
      );
      expect(wa.sendSelection).toHaveBeenCalledWith(
        phone,
        expect.arrayContaining([
          expect.objectContaining({
            id: 'freight:freight-1',
            title: 'F26-AAA.0001',
          }),
        ]),
        expect.objectContaining({
          listButtonLabel: 'VER VIAJES',
          sectionTitle: 'VIAJES ACTIVOS',
        }),
      );
    });

    it('should return the right buttons for a driver across operational states', () => {
      const acceptedButtons = service['getActionButtons'](
        {
          id: 'freight-1',
          status: 'accepted',
          originCompanyId: 'producer-1',
          destCompanyId: 'plant-1',
          assignments: [{ transportCompanyId: 'transporter-1', driverId: 'driver-1' }],
        },
        driverUser,
        'transporter-1',
      );

      const loadedButtons = service['getActionButtons'](
        {
          id: 'freight-1',
          status: 'loaded',
          originCompanyId: 'producer-1',
          destCompanyId: 'plant-1',
          transporterFinishedConfirmedAt: null,
          plantFinishedConfirmedAt: null,
          producerLoadedConfirmedAt: null,
          assignments: [{ transportCompanyId: 'transporter-1', driverId: 'driver-1' }],
        },
        driverUser,
        'transporter-1',
      );

      expect(acceptedButtons).toEqual([
        { id: 'start:freight-1', title: 'INICIAR VIAJE' },
      ]);
      expect(loadedButtons).toEqual([
        { id: 'confirm_finished:freight-1', title: 'CONFIRMAR ENTREGA' },
      ]);
    });

    it('should route confirm_loaded button presses into the load confirmation flow', async () => {
      prisma.freight.findUnique.mockResolvedValue({
        id: 'freight-1',
        code: 'F-1',
        status: 'in_progress',
        originCompanyId: 'producer-1',
        destCompanyId: 'plant-1',
        transporterFinishedConfirmedAt: null,
        plantFinishedConfirmedAt: null,
        producerLoadedConfirmedAt: null,
        assignments: [{ transportCompanyId: 'transporter-1', driverId: 'driver-1' }],
      });

      await service['handleButtonReply'](phone, driverUser, 'confirm_loaded:freight-1', 'CONFIRMAR CARGA');

      expect(flow.startFlow).toHaveBeenCalledWith(
        'confirm_loaded',
        phone,
        driverUser,
        { freightId: 'freight-1' },
      );
    });

    it('should deny buttons for freights outside the driver scope', async () => {
      prisma.freight.findUnique.mockResolvedValue({
        originCompanyId: 'producer-9',
        destCompanyId: 'plant-9',
        assignments: [{ transportCompanyId: 'transporter-9', driverId: 'driver-9' }],
      });

      await service['handleButtonReply'](phone, driverUser, 'confirm_loaded:freight-9', 'CONFIRMAR CARGA');

      expect(flow.startFlow).not.toHaveBeenCalled();
      expect(wa.sendText).toHaveBeenCalledWith(phone, 'No tiene acceso a este flete.');
    });

    it('should reject stale operational buttons before executing mutation', async () => {
      prisma.freight.findUnique.mockResolvedValue({
        id: 'freight-1',
        code: 'F-1',
        status: 'loaded',
        originCompanyId: 'producer-1',
        destCompanyId: 'plant-1',
        transporterFinishedConfirmedAt: null,
        plantFinishedConfirmedAt: null,
        producerLoadedConfirmedAt: null,
        assignments: [{ transportCompanyId: 'transporter-1', driverId: 'driver-1' }],
      });

      await service['handleButtonReply'](phone, driverUser, 'start:freight-1', 'INICIAR VIAJE');

      expect(freights.start).not.toHaveBeenCalled();
      expect(wa.sendText).toHaveBeenCalledWith(
        phone,
        expect.stringContaining('ya no esta disponible'),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'whatsapp_freight_button',
            metadata: expect.objectContaining({
              buttonAction: 'start',
              result: 'blocked_stale_or_invalid_state',
            }),
          }),
        }),
      );
    });
  });

  describe('AI scope', () => {
    it('should keep mechanic assistant requests out of WhatsApp AI', async () => {
      await service['handleText'](phone, driverUser, 'Necesito registrar mantenimiento del tractor');

      expect(ai.chat).not.toHaveBeenCalled();
      expect(wa.sendText).toHaveBeenCalledWith(
        phone,
        expect.stringContaining('modulo mecanico'),
      );
    });

    it('should resolve autonomous driver mode from the scoped active company, not the global user role', () => {
      expect(service['isAutonomousDriver'](multiCompanyUser, 'producer-1')).toBe(false);
      expect(service['isAutonomousDriver'](multiCompanyUser, 'producer-2')).toBe(true);
    });

    it('should clear pending documents and pending AI actions from operational context resets', async () => {
      prisma.whatsAppSession.findFirst.mockResolvedValue({
        id: 'session-1',
        flowState: {
          selectedCompanyId: 'producer-1',
          companyConfirmed: true,
          aiMessages: ['hola'],
          activeContext: { freightId: 'freight-1' },
          selectionContext: { purpose: 'attach_document_freight' },
          _pendingMessage: 'Adjuntar archivo',
          _pendingAction: { id: 'action-1' },
          pendingDocument: { url: 'https://doc', companyId: 'producer-1', createdAt: Date.now() },
          pendingAiAction: { actionId: 'action-1', companyId: 'producer-1' },
        },
      });

      await service['clearAiOperationalContext']('multi-1');

      expect(ai.cancelPendingAction).toHaveBeenCalledWith('session-1');
      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: {
          flowState: {
            selectedCompanyId: 'producer-1',
            companyConfirmed: true,
          },
        },
      });
    });

    it('should expose safe help text and explicit state guidance for active profiles', () => {
      const help = service['getRoleHelpSectionSafe']('producer', 'producer_manager');
      const guide = service['getRoleStateGuideClean']('producer', 'producer_manager');
      const features = service['getRoleFeatureSummarySafe']('producer', 'producer_manager');

      expect(help).toContain('Solicitar fletes nuevos');
      expect(help).not.toContain('informes PDF');
      expect(help).not.toContain('flota propia');
      expect(features).not.toContain('Equipo');
      expect(guide).toContain('SIN ASIGNAR');
    });
  });

  describe('Agent V2 location capture', () => {
    it('should not save GPS tracking when a location belongs to create_freight V2 capture', async () => {
      agentV2.isEnabled.mockReturnValue(true);
      prisma.whatsAppSession.findFirst.mockResolvedValue({
        id: 'session-v2',
        flowType: null,
        expiresAt: new Date(Date.now() + 60_000),
        flowState: {
          agentV2: {
            currentFlow: 'create_freight',
            currentStep: 'awaiting_location',
          },
        },
      });
      const gpsSpy = jest.spyOn(service as any, 'saveLocationToActiveFreights');

      await service['handleLocation'](
        phone,
        driverUser,
        { latitude: -34.9, longitude: -56.1, name: 'Campo', address: 'Ruta' },
      );

      expect(agentV2.handleLocation).toHaveBeenCalledWith(
        phone,
        driverUser,
        expect.objectContaining({ id: 'session-v2' }),
        expect.objectContaining({ lat: -34.9, lng: -56.1 }),
      );
      expect(gpsSpy).not.toHaveBeenCalled();
      expect(wa.sendText).toHaveBeenCalledWith(phone, 'Ubicacion recibida');
    });

    it('should not save GPS tracking for loose locations while Agent V2 is enabled', async () => {
      agentV2.isEnabled.mockReturnValue(true);
      agentV2.handleLocation.mockResolvedValue({ text: 'Ubicacion recibida sin flujo activo' });
      prisma.whatsAppSession.findFirst.mockResolvedValue({
        id: 'session-v2',
        flowType: null,
        expiresAt: new Date(Date.now() + 60_000),
        flowState: {},
      });
      const gpsSpy = jest.spyOn(service as any, 'saveLocationToActiveFreights');

      await service['handleLocation'](
        phone,
        driverUser,
        { latitude: -34.9, longitude: -56.1, name: 'Campo', address: 'Ruta' },
      );

      expect(agentV2.handleLocation).toHaveBeenCalled();
      expect(gpsSpy).not.toHaveBeenCalled();
      expect(wa.sendText).toHaveBeenCalledWith(phone, 'Ubicacion recibida sin flujo activo');
    });
  });
});
