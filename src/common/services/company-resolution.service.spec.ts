import { Test, TestingModule } from '@nestjs/testing';
import { CompanyResolutionService } from './company-resolution.service';
import { PrismaService } from '../../database/prisma.service';

// Mock requestCache — simulates AsyncLocalStorage per-request cache
const mockStore = new Map<string, any>();
jest.mock('../request-cache', () => ({
  requestCache: { getStore: () => mockStore },
}));

describe('CompanyResolutionService', () => {
  let service: CompanyResolutionService;
  let prisma: any;

  const mockPrisma = {
    user: { findUnique: jest.fn() },
    userCompany: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    mockStore.clear();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompanyResolutionService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(CompanyResolutionService);
    prisma = module.get(PrismaService);
  });

  describe('resolveAllCompanyIds', () => {
    const user = { sub: 'user-1', companyId: 'comp-A' };

    it('returns all company IDs from memberships', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'comp-A' },
        { companyId: 'comp-B' },
      ]);

      const result = await service.resolveAllCompanyIds(user);

      expect(result).toContain('comp-A');
      expect(result).toContain('comp-B');
      expect(result.length).toBe(2);
    });

    it('falls back to User.companyId and companyByType when few memberships', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);
      prisma.user.findUnique.mockResolvedValue({
        companyId: 'comp-legacy',
        companyByType: { producer: 'comp-prod', plant: 'comp-plant' },
      });

      const result = await service.resolveAllCompanyIds({ sub: 'user-1' });

      expect(result).toContain('comp-legacy');
      expect(result).toContain('comp-prod');
      expect(result).toContain('comp-plant');
    });

    it('caches result per request', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([{ companyId: 'comp-A' }]);

      await service.resolveAllCompanyIds(user);
      await service.resolveAllCompanyIds(user);

      // Only one DB call — second hit cache
      expect((prisma as any).userCompany.findMany).toHaveBeenCalledTimes(1);
    });

    it('includes companyId from JWT even if no memberships', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);
      prisma.user.findUnique.mockResolvedValue({ companyId: null, companyByType: {} });

      const result = await service.resolveAllCompanyIds({ sub: 'u1', companyId: 'jwt-comp' });

      expect(result).toContain('jwt-comp');
    });
  });

  describe('resolveProducerCompanyId', () => {
    it('returns first producer membership company', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'comp-plant', company: { id: 'comp-plant', type: 'plant' } },
        { companyId: 'comp-prod', company: { id: 'comp-prod', type: 'producer' } },
      ]);

      const result = await service.resolveProducerCompanyId({ sub: 'u1' });

      expect(result).toBe('comp-prod');
    });

    it('falls back to JWT companyId when companyType is producer', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);

      const result = await service.resolveProducerCompanyId({
        sub: 'u1', companyId: 'jwt-comp', companyType: 'producer',
      });

      expect(result).toBe('jwt-comp');
    });

    it('caches result', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'c1', company: { id: 'c1', type: 'producer' } },
      ]);

      await service.resolveProducerCompanyId({ sub: 'u1' });
      await service.resolveProducerCompanyId({ sub: 'u1' });

      expect((prisma as any).userCompany.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolvePlantCompanyId', () => {
    it('returns first plant membership company', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'comp-prod', company: { id: 'comp-prod', type: 'producer' } },
        { companyId: 'comp-plant', company: { id: 'comp-plant', type: 'plant' } },
      ]);

      const result = await service.resolvePlantCompanyId({ sub: 'u1' });

      expect(result).toBe('comp-plant');
    });

    it('falls back to JWT companyId', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);

      const result = await service.resolvePlantCompanyId({ sub: 'u1', companyId: 'fallback' });

      expect(result).toBe('fallback');
    });
  });

  describe('hasCompanyType', () => {
    it('returns true from JWT companyType', async () => {
      const result = await service.hasCompanyType({ sub: 'u1', companyType: 'plant' }, 'plant');

      expect(result).toBe(true);
      expect((prisma as any).userCompany.findMany).not.toHaveBeenCalled();
    });

    it('returns true from memberships', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { company: { type: 'transporter' } },
      ]);

      const result = await service.hasCompanyType({ sub: 'u1' }, 'transporter');

      expect(result).toBe(true);
    });

    it('returns false when no matching type', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { company: { type: 'producer' } },
      ]);

      const result = await service.hasCompanyType({ sub: 'u1' }, 'plant');

      expect(result).toBe(false);
    });
  });

  describe('resolveCompanyType', () => {
    it('returns JWT companyType if present', async () => {
      const result = await service.resolveCompanyType({ sub: 'u1', companyType: 'producer' });

      expect(result).toBe('producer');
    });

    it('queries memberships when no JWT companyType', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { company: { type: 'plant' } },
      ]);

      const result = await service.resolveCompanyType({ sub: 'u1' });

      expect(result).toBe('plant');
    });

    it('returns unknown when no memberships', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);

      const result = await service.resolveCompanyType({ sub: 'u1' });

      expect(result).toBe('unknown');
    });
  });

  describe('resolveAllProducerCompanyIds', () => {
    it('returns producer company IDs', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'c1', company: { id: 'c1', type: 'producer' } },
        { companyId: 'c2', company: { id: 'c2', type: 'plant' } },
        { companyId: 'c3', company: { id: 'c3', type: 'producer' } },
      ]);

      const result = await service.resolveAllProducerCompanyIds({ sub: 'u1' });

      expect(result).toEqual(expect.arrayContaining(['c1', 'c3']));
      expect(result).not.toContain('c2');
    });

    it('admin gets all companies', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([
        { companyId: 'c1', company: { id: 'c1', type: 'producer' } },
        { companyId: 'c2', company: { id: 'c2', type: 'plant' } },
      ]);

      const result = await service.resolveAllProducerCompanyIds({ sub: 'u1', role: 'admin' });

      expect(result).toContain('c1');
      expect(result).toContain('c2');
    });

    it('falls back to JWT companyId when empty', async () => {
      (prisma as any).userCompany.findMany.mockResolvedValue([]);

      const result = await service.resolveAllProducerCompanyIds({ sub: 'u1', companyId: 'fb' });

      expect(result).toEqual(['fb']);
    });
  });
});
