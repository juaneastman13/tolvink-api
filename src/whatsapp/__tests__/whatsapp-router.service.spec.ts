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
    };

    service = new WhatsAppRouterService(prisma, wa, flow, freights, ai);
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
        originCompanyId: 'producer-1',
        destCompanyId: 'plant-1',
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
  });
});
