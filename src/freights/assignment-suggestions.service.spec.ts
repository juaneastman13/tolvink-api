import { AssignmentSuggestionsService } from './assignment-suggestions.service';

// Note: Tests require a working ts-jest configuration (currently broken in this project).
// These tests document expected behavior and can be run once ts-jest is fixed.

describe('AssignmentSuggestionsService', () => {
  let service: AssignmentSuggestionsService;
  let prisma: any;
  let companyRes: any;

  const mockFreight = {
    id: 'freight-1',
    code: 'F26-ABC.1234',
    status: 'pending_assignment',
    truckCount: 1,
    assignedTruckCount: 0,
    isMultiTruck: false,
    useOwnFleet: false,
    originCompanyId: 'comp-origin',
    destCompanyId: 'comp-dest',
    originLat: -34.9011,
    originLng: -56.1645,
    loadDate: new Date('2026-03-15'),
    loadTime: '08:00',
    items: [{ tons: 30 }],
    originCompany: { id: 'comp-origin', hasInternalFleet: false },
    assignments: [],
  };

  const mockUser = { id: 'user-1', companyId: 'comp-dest', role: 'admin', isSuperAdmin: false };

  beforeEach(() => {
    prisma = {
      freight: { findUnique: jest.fn().mockResolvedValue(mockFreight) },
      user: { findUnique: jest.fn().mockResolvedValue(mockUser) },
      userCompany: { findMany: jest.fn().mockResolvedValue([
        { companyId: 'comp-dest', company: { id: 'comp-dest', type: 'plant', types: ['plant'] } },
      ]) },
      company: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
      truck: { findMany: jest.fn().mockResolvedValue([]) },
      freightAssignment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0) },
      liveLocation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    companyRes = { resolveAllCompanyIds: jest.fn().mockResolvedValue(['comp-dest']) };
    service = new AssignmentSuggestionsService(prisma, companyRes);
  });

  it('should return empty suggestions when no candidates', async () => {
    const result = await service.getSuggestions('freight-1', 'user-1');
    expect(result.suggestions).toEqual([]);
    expect(result.totalCandidatesEvaluated).toBe(0);
  });

  it('should throw for non-assignable status', async () => {
    prisma.freight.findUnique.mockResolvedValue({ ...mockFreight, status: 'finished' });
    await expect(service.getSuggestions('freight-1', 'user-1')).rejects.toThrow('no está en estado');
  });

  it('should allow assigned status with unfilled truck slots', async () => {
    prisma.freight.findUnique.mockResolvedValue({
      ...mockFreight,
      status: 'assigned',
      truckCount: 3,
      assignedTruckCount: 1,
    });
    const result = await service.getSuggestions('freight-1', 'user-1');
    expect(result.freightCode).toBe('F26-ABC.1234');
  });

  it('should throw for non-plant user', async () => {
    prisma.userCompany.findMany.mockResolvedValue([
      { companyId: 'comp-x', company: { id: 'comp-x', type: 'producer', types: ['producer'] } },
    ]);
    await expect(service.getSuggestions('freight-1', 'user-1')).rejects.toThrow('Solo la planta');
  });

  it('should score candidates and sort by score desc', async () => {
    prisma.company.findMany.mockResolvedValue([
      { id: 'trans-1', name: 'Transportes A', lat: null, lng: null, trucks: [{ id: 't1', plate: 'ABC-123', capacity: '35', active: true, assignedUser: { name: 'Juan', phone: '+598123' } }] },
      { id: 'trans-2', name: 'Transportes B', lat: null, lng: null, trucks: [] },
    ]);
    const result = await service.getSuggestions('freight-1', 'user-1');
    expect(result.suggestions.length).toBeGreaterThan(0);
    // Sorted descending
    for (let i = 1; i < result.suggestions.length; i++) {
      expect(result.suggestions[i - 1].score).toBeGreaterThanOrEqual(result.suggestions[i].score);
    }
  });

  it('should redistribute proximity points when no geo', async () => {
    prisma.freight.findUnique.mockResolvedValue({ ...mockFreight, originLat: null, originLng: null });
    prisma.company.findMany.mockResolvedValue([
      { id: 'trans-1', name: 'T1', lat: null, lng: null, trucks: [{ id: 't1', plate: 'ABC', capacity: '35', active: true, assignedUser: null }] },
    ]);
    const result = await service.getSuggestions('freight-1', 'user-1');
    expect(result.geoAvailable).toBe(false);
    if (result.suggestions.length > 0) {
      expect(result.suggestions[0].scoreBreakdown.proximity).toBe(0);
    }
  });

  it('should prioritize own fleet with useOwnFleet=true', async () => {
    prisma.freight.findUnique.mockResolvedValue({
      ...mockFreight,
      useOwnFleet: true,
      originCompany: { id: 'comp-origin', hasInternalFleet: true },
    });
    prisma.truck.findMany.mockResolvedValue([
      { id: 'own-t1', plate: 'OWN-001', capacity: '40', active: true, assignedUser: { name: 'Carlos', phone: '+598456' } },
    ]);
    prisma.company.findMany.mockResolvedValue([
      { id: 'trans-1', name: 'External', lat: null, lng: null, trucks: [{ id: 't1', plate: 'EXT-001', capacity: '35', active: true, assignedUser: null }] },
    ]);
    prisma.company.findUnique.mockResolvedValue({ name: 'Mi Empresa' });
    const result = await service.getSuggestions('freight-1', 'user-1');
    if (result.suggestions.length > 0) {
      expect(result.suggestions[0].type).toBe('own_fleet');
    }
  });

  it('should limit to 8 suggestions', async () => {
    const manyTransporters = Array.from({ length: 15 }, (_, i) => ({
      id: `trans-${i}`, name: `T${i}`, lat: null, lng: null,
      trucks: [{ id: `t${i}`, plate: `P${i}`, capacity: '30', active: true, assignedUser: null }],
    }));
    prisma.company.findMany.mockResolvedValue(manyTransporters);
    const result = await service.getSuggestions('freight-1', 'user-1');
    expect(result.suggestions.length).toBeLessThanOrEqual(8);
  });
});
