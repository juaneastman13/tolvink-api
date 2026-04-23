jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

jest.mock('../../freights/freights.service', () => ({
  FreightsService: class FreightsService {},
}));

import { WhatsAppFlowService } from '../whatsapp-flow.service';

describe('WhatsAppFlowService', () => {
  let service: WhatsAppFlowService;
  let prisma: any;
  let wa: any;
  let freights: any;

  const phone = '59899111222';
  const user = {
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
      whatsAppSession: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      freight: {
        findUnique: jest.fn(),
      },
    };

    wa = {
      normalizePhone: jest.fn((value: string) => value),
      sendText: jest.fn().mockResolvedValue(null),
      sendButtons: jest.fn().mockResolvedValue(null),
    };

    freights = {
      confirmLoaded: jest.fn().mockResolvedValue({ id: 'freight-1' }),
      respond: jest.fn(),
      cancel: jest.fn(),
    };

    service = new WhatsAppFlowService(prisma, wa, freights);
  });

  describe('confirm_loaded flow', () => {
    it('should start the flow with planned tons context', async () => {
      prisma.whatsAppSession.create.mockResolvedValue({
        id: 'session-1',
        flowState: { freightId: 'freight-1' },
      });
      prisma.freight.findUnique.mockResolvedValue({
        id: 'freight-1',
        items: [{ tons: 30 }],
      });

      await service.startFlow('confirm_loaded', phone, user, { freightId: 'freight-1' });

      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: { flowStep: 'awaiting_tons' },
      });
      expect(wa.sendText).toHaveBeenCalledWith(
        phone,
        expect.stringContaining('Planificadas: 30 tn'),
      );
    });

    it('should confirm the load immediately for normal tonnage', async () => {
      const session = {
        id: 'session-1',
        flowType: 'confirm_loaded',
        flowStep: 'awaiting_tons',
        flowState: { freightId: 'freight-1' },
        expiresAt: new Date(Date.now() + 60_000),
      };

      await service.continueFlow(session, 'text', { body: '25,5' }, phone, user);

      expect(freights.confirmLoaded).toHaveBeenCalledWith(
        'freight-1',
        expect.objectContaining({
          sub: 'driver-1',
          companyId: 'transporter-1',
          companyType: 'transporter',
        }),
        25.5,
      );
      expect(wa.sendText).toHaveBeenCalledWith(phone, '✅ Carga confirmada: 25.5 tn.');
      expect(prisma.whatsAppSession.delete).toHaveBeenCalledWith({
        where: { id: 'session-1' },
      });
    });

    it('should ask for confirmation when tonnage is unusually high', async () => {
      const session = {
        id: 'session-1',
        flowType: 'confirm_loaded',
        flowStep: 'awaiting_tons',
        flowState: { freightId: 'freight-1' },
        expiresAt: new Date(Date.now() + 60_000),
      };

      await service.continueFlow(session, 'text', { body: '120' }, phone, user);

      expect(prisma.whatsAppSession.update).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        data: {
          flowStep: 'awaiting_tons_confirm',
          flowState: {
            freightId: 'freight-1',
            pendingTons: 120,
          },
        },
      });
      expect(wa.sendButtons).toHaveBeenCalledWith(
        phone,
        expect.stringContaining('120 tn'),
        expect.arrayContaining([
          expect.objectContaining({ id: 'tons_confirm:yes' }),
          expect.objectContaining({ id: 'tons_confirm:no' }),
        ]),
      );
      expect(freights.confirmLoaded).not.toHaveBeenCalled();
    });

    it('should execute the load confirmation after high-tonnage approval', async () => {
      const session = {
        id: 'session-1',
        flowType: 'confirm_loaded',
        flowStep: 'awaiting_tons_confirm',
        flowState: { freightId: 'freight-1', pendingTons: 120 },
        expiresAt: new Date(Date.now() + 60_000),
      };

      await service.continueFlow(session, 'button_reply', { id: 'tons_confirm:yes' }, phone, user);

      expect(freights.confirmLoaded).toHaveBeenCalledWith(
        'freight-1',
        expect.objectContaining({ sub: 'driver-1' }),
        120,
      );
      expect(wa.sendText).toHaveBeenCalledWith(phone, '✅ Carga confirmada: 120 tn.');
      expect(prisma.whatsAppSession.delete).toHaveBeenCalledWith({
        where: { id: 'session-1' },
      });
    });
  });
});
