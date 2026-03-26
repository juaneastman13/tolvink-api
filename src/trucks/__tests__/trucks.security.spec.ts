/**
 * Security tests for TrucksService — verifies multitenancy isolation.
 * Tests that assertTruckOwnership blocks access to trucks of other companies,
 * and that all CRUD operations respect companyId filtering.
 */

import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TrucksService } from '../trucks.controller';
import { PrismaService } from '../../database/prisma.service';
import { WhatsAppService } from '../../whatsapp/whatsapp.service';
import { CompanyResolutionService } from '../../common/services/company-resolution.service';
import { OcrService } from '../../ocr/ocr.service';

// Minimal mock implementations
const mockPrisma = {
  truck: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  truckDocument: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  truckExpense: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  truckIncome: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), aggregate: jest.fn(), groupBy: jest.fn() },
  truckMovement: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  freightAssignment: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), aggregate: jest.fn() },
  freight: { findFirst: jest.fn() },
  field: { findFirst: jest.fn() },
  lot: { findFirst: jest.fn() },
  companyAccess: { findFirst: jest.fn() },
};
const mockWa = { sendMessage: jest.fn() };
const mockCompanyRes = { resolveAllCompanyIds: jest.fn(), hasCompanyType: jest.fn() };
const mockOcr = { analyzeFromUrl: jest.fn() };

describe('TrucksService — Security', () => {
  let service: TrucksService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        TrucksService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: WhatsAppService, useValue: mockWa },
        { provide: CompanyResolutionService, useValue: mockCompanyRes },
        { provide: OcrService, useValue: mockOcr },
      ],
    }).compile();
    service = module.get(TrucksService);
  });

  const ownUser = { sub: 'user-1', activeCompanyId: 'company-A', companyId: 'company-A', role: 'admin' };
  const otherTruck = { id: 'truck-other', companyId: 'company-B', plate: 'ZZZ999' };
  const ownTruck = { id: 'truck-own', companyId: 'company-A', plate: 'ABC123' };

  // ======================== OWNERSHIP TESTS ========================

  describe('getDetail', () => {
    it('returns truck detail for own truck', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue({ ...ownTruck, assignedUser: null, documents: [] });
      mockPrisma.freightAssignment.findMany.mockResolvedValue([]);
      mockPrisma.freightAssignment.count.mockResolvedValue(0);
      mockPrisma.freightAssignment.aggregate.mockResolvedValue({ _sum: { loadedTons: null } });
      mockPrisma.truckDocument.findMany.mockResolvedValue([]);
      const result = await service.getDetail('truck-own', ownUser);
      expect(result.plate).toBe('ABC123');
      expect(result.isOwn).toBe(true);
    });

    it('returns limited data for linked truck', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue({ ...otherTruck, assignedUser: null });
      const result = await service.getDetail('truck-other', ownUser);
      expect(result.isOwn).toBe(false);
      expect(result.documents).toEqual([]);
    });

    it('throws NotFoundException for unknown truck', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(null);
      await expect(service.getDetail('nonexistent', ownUser)).rejects.toThrow(NotFoundException);
    });
  });

  describe('listDocuments', () => {
    it('throws for truck of another company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(null); // assertTruckOwnership fails
      await expect(service.listDocuments('truck-other', ownUser)).rejects.toThrow(ForbiddenException);
    });

    it('returns docs for own truck', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(ownTruck);
      mockPrisma.truckDocument.findMany.mockResolvedValue([{ id: 'doc-1', type: 'VTV_ITV', expiresAt: null }]);
      const docs = await service.listDocuments('truck-own', ownUser);
      expect(docs).toHaveLength(1);
    });
  });

  describe('addExpense', () => {
    it('throws for truck of another company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(null);
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      await expect(service.addExpense('truck-other', ownUser, { type: 'FUEL', amount: 100, date: '2026-01-01' })).rejects.toThrow();
    });
  });

  describe('addIncome', () => {
    it('throws for truck of another company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(null);
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      await expect(service.addIncome('truck-other', ownUser, { concept: 'Test', amount: 100, date: '2026-01-01' })).rejects.toThrow();
    });
  });

  describe('addMovement', () => {
    it('throws for truck of another company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(null);
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      await expect(service.addMovement('truck-other', ownUser, { type: 'REPOSITIONING' })).rejects.toThrow();
    });
  });

  describe('validateLocationRefs', () => {
    it('throws for field of another company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(ownTruck);
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      mockPrisma.field.findFirst.mockResolvedValue(null); // field not found for this company
      await expect(
        service.addMovement('truck-own', ownUser, { type: 'REPOSITIONING', originFieldId: 'field-other-co' })
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('validateFreightLink', () => {
    it('throws for freight not involving this company', async () => {
      mockPrisma.truck.findFirst.mockResolvedValue(ownTruck);
      mockCompanyRes.hasCompanyType.mockResolvedValue(false);
      mockPrisma.companyAccess.findFirst.mockResolvedValue(null);
      mockPrisma.freightAssignment.findFirst.mockResolvedValue(null);
      mockPrisma.freight.findFirst.mockResolvedValue(null);
      await expect(
        service.addIncome('truck-own', ownUser, { concept: 'Test', amount: 100, date: '2026-01-01', freightId: 'freight-other' })
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
