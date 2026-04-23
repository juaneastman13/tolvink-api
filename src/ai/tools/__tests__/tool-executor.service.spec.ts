jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

jest.mock('../../../freights/freights.service', () => ({
  FreightsService: class FreightsService {},
}));

import { ToolExecutorService } from '../tool-executor';

describe('ToolExecutorService', () => {
  let service: ToolExecutorService;
  let prisma: any;
  let freights: any;

  const transporterDriver = {
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

  const session = {
    id: 'session-1',
    flowState: {},
  };

  const scopedDriverSession = {
    id: 'session-2',
    flowState: { selectedCompanyId: 'transporter-2' },
  };

  const multiCompanyUser = {
    id: 'user-1',
    role: 'gerente',
    companyId: 'producer-1',
    activeCompanyId: 'producer-1',
    company: { type: 'producer', types: ['producer'] },
    memberships: [
      {
        companyId: 'producer-1',
        active: true,
        role: 'gerente',
        company: { type: 'producer', types: ['producer'] },
      },
      {
        companyId: 'transporter-2',
        active: true,
        role: 'chofer',
        company: { type: 'transporter', types: ['transporter'] },
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      freight: {
        findFirst: jest.fn(),
      },
      freightAssignment: {
        findMany: jest.fn(),
      },
      whatsAppSession: {
        findUnique: jest.fn().mockResolvedValue({ flowState: {} }),
        update: jest.fn().mockResolvedValue({}),
      },
      truck: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      userCompany: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      company: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      field: {
        findMany: jest.fn(),
      },
      lot: {
        findMany: jest.fn(),
      },
      plantProducerAccess: {
        findMany: jest.fn(),
      },
      tolvinkPlant: {
        findMany: jest.fn(),
      },
    };

    freights = {
      confirmTripLoaded: jest.fn().mockResolvedValue({ code: 'F26-AAA.0001' }),
      confirmLoaded: jest.fn().mockResolvedValue({ code: 'F26-AAA.0001' }),
    };

    service = new ToolExecutorService(prisma, freights);
  });

  describe('driver permissions and actions', () => {
    it('should only expose driver-safe tools to a transporter driver profile', () => {
      const visibleTools = service.filterTools(
        [
          { name: 'list_freights' },
          { name: 'assign_driver_and_truck' },
          { name: 'finish_freight' },
          { name: 'create_freight_request' },
        ],
        transporterDriver,
        session,
      );

      expect(visibleTools.map((tool) => tool.name)).toEqual([
        'list_freights',
        'finish_freight',
      ]);
    });

    it('should reject admin-style tools for the driver role', async () => {
      const result = await service.executeTool(
        'assign_driver_and_truck',
        { code: 'F26-AAA.0001' },
        transporterDriver,
        session,
      );

      expect(JSON.parse(result)).toEqual({
        error: 'Esa accion no esta habilitada para tu rol en la empresa activa.',
      });
    });

    it('should stage a load confirmation for the driver assigned trip', async () => {
      prisma.freightAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-1',
          driverId: 'driver-1',
          freight: {
            id: 'freight-1',
            code: 'F26-AAA.0001',
            status: 'in_progress',
            isAutonomous: false,
            originName: 'Campo Norte',
            originFreeText: null,
            destName: 'Planta Centro',
            destinationFreeText: null,
          },
        },
      ]);

      const result = await service.executeTool(
        'confirm_freight_loaded',
        { weightKg: 30500 },
        transporterDriver,
        session,
      );

      const parsed = JSON.parse(result);
      expect(parsed.status).toBe('pending_confirmation');
      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: {
            flowState: expect.objectContaining({
              pendingAiAction: expect.objectContaining({
                tool: 'confirm_freight_loaded',
                params: expect.objectContaining({
                  freightId: 'freight-1',
                  assignmentId: 'assignment-1',
                  loadedTons: 30.5,
                }),
              }),
            }),
          },
        }),
      );
    });

    it('should execute confirmTripLoaded when the staged action belongs to a specific assignment', async () => {
      prisma.freightAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-1',
          driverId: 'driver-1',
          freight: {
            id: 'freight-1',
            code: 'F26-AAA.0001',
            status: 'in_progress',
            isAutonomous: false,
            originName: 'Campo Norte',
            originFreeText: null,
            destName: 'Planta Centro',
            destinationFreeText: null,
          },
        },
      ]);
      await service.executeTool(
        'confirm_freight_loaded',
        { weightKg: 28000 },
        transporterDriver,
        session,
      );
      prisma.whatsAppSession.findUnique.mockResolvedValue({
        flowState: { pendingAiAction: service['pendingActions'].get('session-1') },
      });
      const result = await service.confirmPendingAction(session, transporterDriver);

      expect(freights.confirmTripLoaded).toHaveBeenCalledWith(
        'freight-1',
        'assignment-1',
        expect.objectContaining({
          sub: 'driver-1',
          companyId: 'transporter-1',
        }),
        28,
      );
      expect(freights.confirmLoaded).not.toHaveBeenCalled();
      expect(JSON.parse(result)).toEqual({
        status: 'loaded',
        code: 'F26-AAA.0001',
      });
    });

    it('should ask for the freight code when the driver has multiple active trips', async () => {
      prisma.freightAssignment.findMany.mockResolvedValue([
        {
          id: 'assignment-1',
          driverId: 'driver-1',
          freight: { id: 'freight-1', code: 'F26-AAA.0001', status: 'in_progress', isAutonomous: false },
        },
        {
          id: 'assignment-2',
          driverId: 'driver-1',
          freight: { id: 'freight-2', code: 'F26-BBB.0002', status: 'in_progress', isAutonomous: false },
        },
      ]);

      const result = await service.executeTool(
        'confirm_freight_loaded',
        {},
        transporterDriver,
        session,
      );

      expect(JSON.parse(result)).toEqual({
        error: 'No encontre un viaje elegible para confirmar carga. Decime el codigo del flete.',
      });
    });

    it('should filter tools by the WhatsApp-selected company membership, not the global role', () => {
      const visibleTools = service.filterTools(
        [
          { name: 'list_freights' },
          { name: 'assign_driver_and_truck' },
          { name: 'finish_freight' },
          { name: 'create_freight_request' },
        ],
        multiCompanyUser,
        scopedDriverSession,
      );

      expect(visibleTools.map((tool) => tool.name)).toEqual([
        'list_freights',
        'finish_freight',
      ]);
    });

    it('should invalidate a persisted pending action when the session company changes', async () => {
      prisma.whatsAppSession.findUnique.mockResolvedValue({
        flowState: {
          selectedCompanyId: 'producer-1',
          pendingAiAction: {
            actionId: 'action-1',
            tool: 'confirm_freight_loaded',
            params: { freightId: 'freight-1' },
            summary: 'Confirmar carga',
            createdAt: Date.now(),
            companyId: 'transporter-2',
          },
        },
      });

      const result = await service.confirmPendingAction(scopedDriverSession, multiCompanyUser);

      expect(JSON.parse(result)).toEqual({
        error: 'No hay accion pendiente para confirmar.',
      });
      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-2' },
          data: { flowState: { selectedCompanyId: 'producer-1' } },
        }),
      );
    });
  });
});
