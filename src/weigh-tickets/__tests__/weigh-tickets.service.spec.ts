import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { WeighTicketsService } from '../weigh-tickets.service';
import { PrismaService } from '../../database/prisma.service';
import { OcrService } from '../../ocr/ocr.service';

jest.mock('@prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

describe('WeighTicketsService', () => {
  let service: WeighTicketsService;
  let prisma: any;
  let ocrService: any;

  const producerUser = { sub: 'user-1', companyId: 'comp-prod', companyType: 'producer', role: 'operator' };
  const plantUser = { sub: 'user-2', companyId: 'comp-plant', companyType: 'plant', role: 'operator' };
  const transportUser = { sub: 'user-3', companyId: 'comp-trans', companyType: 'transporter', role: 'operator' };
  const platformAdmin = { sub: 'user-admin', companyId: 'comp-admin', role: 'platform_admin' };

  const freightId = 'freight-1';
  const ticketId = 'ticket-1';
  const assignmentId = 'assignment-1';

  const mockTicket = {
    id: ticketId,
    freightId,
    assignmentId: null,
    type: 'destination',
    ticketNumber: null,
    grossWeight: null,
    tareWeight: null,
    netWeight: null,
    humidity: null,
    impurities: null,
    dockage: null,
    temperature: null,
    observations: null,
    photoUrl: null,
    ocrData: null,
    ocrConfidence: null,
    registeredById: 'user-2',
    registeredAt: new Date(),
    registeredBy: { id: 'user-2', name: 'Plant User' },
  };

  const mockPrisma: any = {
    weighTicket: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    freightAssignment: {
      findFirst: jest.fn(),
    },
  };

  const mockOcrService = {
    analyzeFromUrl: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WeighTicketsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: OcrService, useValue: mockOcrService },
      ],
    }).compile();

    service = module.get(WeighTicketsService);
    prisma = module.get(PrismaService);
    ocrService = module.get(OcrService);
  });

  // ======================== CREATE =====================================

  describe('create', () => {
    it('should create a destination ticket as plant user', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      const result = await service.create(freightId, { grossWeight: 35000, tareWeight: 15000 }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            freightId,
            type: 'destination',
            grossWeight: 35000,
            tareWeight: 15000,
            netWeight: 20000, // auto-calculated
            registeredById: plantUser.sub,
          }),
        }),
      );
      expect(result).toBeDefined();
    });

    it('should create an origin ticket as producer user', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket, type: 'origin' });

      await service.create(freightId, { type: 'origin', grossWeight: 30000, tareWeight: 14000 }, producerUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            freightId,
            type: 'origin',
            netWeight: 16000,
            registeredById: producerUser.sub,
          }),
        }),
      );
    });

    it('should create a ticket as transporter for either type', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      // Destination
      await service.create(freightId, { type: 'destination' }, transportUser);
      expect(mockPrisma.weighTicket.create).toHaveBeenCalled();

      jest.clearAllMocks();

      // Origin
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket, type: 'origin' });
      await service.create(freightId, { type: 'origin' }, transportUser);
      expect(mockPrisma.weighTicket.create).toHaveBeenCalled();
    });

    it('should reject origin ticket creation by plant user', async () => {
      await expect(
        service.create(freightId, { type: 'origin' }, plantUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should reject destination ticket creation by producer user', async () => {
      await expect(
        service.create(freightId, { type: 'destination' }, producerUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should allow platform_admin to create any type', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { type: 'origin' }, platformAdmin);
      expect(mockPrisma.weighTicket.create).toHaveBeenCalled();

      jest.clearAllMocks();
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { type: 'destination' }, platformAdmin);
      expect(mockPrisma.weighTicket.create).toHaveBeenCalled();
    });

    it('should auto-calculate netWeight from gross - tare', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { grossWeight: 40000, tareWeight: 16000 }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ netWeight: 24000 }),
        }),
      );
    });

    it('should use explicit netWeight over calculated', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { grossWeight: 40000, tareWeight: 16000, netWeight: 23500 }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ netWeight: 23500 }),
        }),
      );
    });

    it('should validate assignment belongs to freight', async () => {
      mockPrisma.freightAssignment.findFirst.mockResolvedValue(null);

      await expect(
        service.create(freightId, { assignmentId: 'bad-id' }, plantUser),
      ).rejects.toThrow(BadRequestException);
    });

    it('should accept valid assignment', async () => {
      mockPrisma.freightAssignment.findFirst.mockResolvedValue({ id: assignmentId, freightId });
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket, assignmentId });

      await service.create(freightId, { assignmentId }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ assignmentId }),
        }),
      );
    });
  });

  // ======================== LIST =======================================

  describe('findAll', () => {
    it('should list tickets for a freight ordered by registeredAt desc', async () => {
      const tickets = [mockTicket, { ...mockTicket, id: 'ticket-2' }];
      mockPrisma.weighTicket.findMany.mockResolvedValue(tickets);

      const result = await service.findAll(freightId);

      expect(mockPrisma.weighTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { freightId },
          orderBy: { registeredAt: 'desc' },
        }),
      );
      expect(result).toHaveLength(2);
    });

    it('should filter by type when provided', async () => {
      mockPrisma.weighTicket.findMany.mockResolvedValue([]);

      await service.findAll(freightId, 'origin');

      expect(mockPrisma.weighTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { freightId, type: 'origin' },
        }),
      );
    });

    it('should not filter by type when invalid value', async () => {
      mockPrisma.weighTicket.findMany.mockResolvedValue([]);

      await service.findAll(freightId, 'invalid');

      expect(mockPrisma.weighTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { freightId },
        }),
      );
    });
  });

  // ======================== DETAIL =====================================

  describe('findOne', () => {
    it('should return ticket with relations', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(mockTicket);

      const result = await service.findOne(freightId, ticketId);

      expect(result).toEqual(mockTicket);
    });

    it('should throw NotFoundException if ticket not found', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(null);

      await expect(service.findOne(freightId, 'bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  // ======================== UPDATE =====================================

  describe('update', () => {
    it('should update ticket and recalculate netWeight', async () => {
      const existing = { ...mockTicket, grossWeight: 35000, tareWeight: 15000, netWeight: 20000 };
      mockPrisma.weighTicket.findFirst.mockResolvedValue(existing);
      mockPrisma.weighTicket.update.mockResolvedValue({ ...existing, grossWeight: 36000, netWeight: 21000 });

      await service.update(freightId, ticketId, { grossWeight: 36000 }, plantUser);

      expect(mockPrisma.weighTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grossWeight: 36000,
            netWeight: 21000, // 36000 - 15000
          }),
        }),
      );
    });

    it('should validate role for ticket type on update', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue({ ...mockTicket, type: 'origin' });

      // Plant cannot edit origin ticket
      await expect(
        service.update(freightId, ticketId, { observations: 'test' }, plantUser),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should throw NotFoundException if ticket does not exist', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(null);

      await expect(
        service.update(freightId, 'bad-id', { observations: 'test' }, plantUser),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ======================== DELETE =====================================

  describe('remove', () => {
    it('should delete existing ticket', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(mockTicket);
      mockPrisma.weighTicket.delete.mockResolvedValue(mockTicket);

      const result = await service.remove(freightId, ticketId, plantUser);

      expect(result).toEqual({ deleted: true });
      expect(mockPrisma.weighTicket.delete).toHaveBeenCalledWith({ where: { id: ticketId } });
    });

    it('should throw NotFoundException if ticket not found', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(null);

      await expect(service.remove(freightId, 'bad-id', plantUser)).rejects.toThrow(NotFoundException);
    });
  });

  // ======================== OCR =======================================

  describe('runOcr', () => {
    const ticketWithPhoto = {
      ...mockTicket,
      photoUrl: 'https://example.com/ticket.jpg',
    };

    it('should run OCR and fill empty fields', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(ticketWithPhoto);
      mockOcrService.analyzeFromUrl.mockResolvedValue({
        tipoDocumento: 'pesaje',
        datos: { pesoBruto: 35000, tara: 15000, pesoNeto: 20000, humedad: 14.5 },
        confianza: 0.85,
      });
      mockPrisma.weighTicket.update.mockResolvedValue({
        ...ticketWithPhoto,
        grossWeight: 35000,
        tareWeight: 15000,
        netWeight: 20000,
        humidity: 14.5,
        ocrConfidence: 0.85,
      });

      const result = await service.runOcr(freightId, ticketId);

      expect(mockOcrService.analyzeFromUrl).toHaveBeenCalledWith(ticketWithPhoto.photoUrl, 'pesaje');
      expect(mockPrisma.weighTicket.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grossWeight: 35000,
            tareWeight: 15000,
            netWeight: 20000,
            humidity: 14.5,
            ocrConfidence: 0.85,
          }),
        }),
      );
    });

    it('should NOT overwrite manually entered fields', async () => {
      const manualTicket = {
        ...ticketWithPhoto,
        grossWeight: 34500, // manually entered
        tareWeight: 14800,  // manually entered
        netWeight: 19700,   // manually entered
        humidity: null,     // not yet entered
      };
      mockPrisma.weighTicket.findFirst.mockResolvedValue(manualTicket);
      mockOcrService.analyzeFromUrl.mockResolvedValue({
        tipoDocumento: 'pesaje',
        datos: { pesoBruto: 35000, tara: 15000, pesoNeto: 20000, humedad: 14.5 },
        confianza: 0.9,
      });
      mockPrisma.weighTicket.update.mockResolvedValue(manualTicket);

      await service.runOcr(freightId, ticketId);

      const updateCall = mockPrisma.weighTicket.update.mock.calls[0][0];
      // Should NOT include grossWeight, tareWeight, netWeight (already set)
      expect(updateCall.data.grossWeight).toBeUndefined();
      expect(updateCall.data.tareWeight).toBeUndefined();
      expect(updateCall.data.netWeight).toBeUndefined();
      // Should include humidity (was null)
      expect(updateCall.data.humidity).toBe(14.5);
      expect(updateCall.data.ocrConfidence).toBe(0.9);
    });

    it('should throw if ticket has no photo', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue({ ...mockTicket, photoUrl: null });

      await expect(service.runOcr(freightId, ticketId)).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException if ticket not found', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(null);

      await expect(service.runOcr(freightId, 'bad-id')).rejects.toThrow(NotFoundException);
    });

    it('should handle OCR with English field names', async () => {
      mockPrisma.weighTicket.findFirst.mockResolvedValue(ticketWithPhoto);
      mockOcrService.analyzeFromUrl.mockResolvedValue({
        tipoDocumento: 'pesaje',
        datos: { grossWeight: 40000, tareWeight: 16000, netWeight: 24000, humidity: 13.2, temperature: 25 },
        confianza: 0.92,
      });
      mockPrisma.weighTicket.update.mockResolvedValue({});

      await service.runOcr(freightId, ticketId);

      const updateCall = mockPrisma.weighTicket.update.mock.calls[0][0];
      expect(updateCall.data.grossWeight).toBe(40000);
      expect(updateCall.data.tareWeight).toBe(16000);
      expect(updateCall.data.netWeight).toBe(24000);
      expect(updateCall.data.humidity).toBe(13.2);
      expect(updateCall.data.temperature).toBe(25);
    });
  });

  // ======================== NET WEIGHT CALC ============================

  describe('netWeight calculation', () => {
    it('should set netWeight to 0 when tare > gross', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { grossWeight: 10000, tareWeight: 15000 }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ netWeight: 0 }),
        }),
      );
    });

    it('should leave netWeight null when only gross is provided', async () => {
      mockPrisma.weighTicket.create.mockResolvedValue({ ...mockTicket });

      await service.create(freightId, { grossWeight: 35000 }, plantUser);

      expect(mockPrisma.weighTicket.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ netWeight: null }),
        }),
      );
    });
  });

  // ======================== BOTH TYPES ON SAME FREIGHT =================

  describe('origin + destination on same freight', () => {
    it('should list both types when no filter', async () => {
      const originTicket = { ...mockTicket, id: 'ticket-origin', type: 'origin' };
      const destTicket = { ...mockTicket, id: 'ticket-dest', type: 'destination' };
      mockPrisma.weighTicket.findMany.mockResolvedValue([destTicket, originTicket]);

      const result = await service.findAll(freightId);
      expect(result).toHaveLength(2);
    });

    it('should filter to origin only', async () => {
      mockPrisma.weighTicket.findMany.mockResolvedValue([]);

      await service.findAll(freightId, 'origin');

      expect(mockPrisma.weighTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { freightId, type: 'origin' },
        }),
      );
    });

    it('should filter to destination only', async () => {
      mockPrisma.weighTicket.findMany.mockResolvedValue([]);

      await service.findAll(freightId, 'destination');

      expect(mockPrisma.weighTicket.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { freightId, type: 'destination' },
        }),
      );
    });
  });
});
