import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { PrismaService } from '../database/prisma.service';

// Mock bcryptjs
jest.mock('bcryptjs', () => ({
  hash: jest.fn().mockResolvedValue('hashed-pw'),
  compare: jest.fn().mockResolvedValue(true),
}));

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let jwt: JwtService;

  const mockJwt = {
    signAsync: jest.fn().mockResolvedValue('mock-jwt-token'),
  };

  const mockPrisma = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userCompany: {
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const mockUser = {
    id: 'user-1',
    name: 'Test User',
    email: 'test@test.com',
    phone: '099123456',
    role: 'operator',
    active: true,
    isSuperAdmin: false,
    companyId: 'comp-1',
    activeCompanyId: 'comp-1',
    userTypes: ['producer'],
    company: { id: 'comp-1', name: 'Farm Co', type: 'producer', hasInternalFleet: false },
    memberships: [{
      id: 'uc-1',
      companyId: 'comp-1',
      role: 'gerente',
      active: true,
      company: { id: 'comp-1', name: 'Farm Co', type: 'producer', hasInternalFleet: false },
      createdAt: new Date(),
    }],
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    // Reset mockPrisma refresh token mocks
    mockPrisma.refreshToken.create.mockResolvedValue({});
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.refreshToken.delete.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: JwtService, useValue: mockJwt },
      ],
    }).compile();

    service = module.get(AuthService);
    prisma = module.get(PrismaService);
    jwt = module.get(JwtService);
  });

  // ================================================================
  // LOGIN
  // ================================================================
  describe('login', () => {
    it('succeeds with email', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser });
      prisma.user.update.mockResolvedValue(mockUser);

      const result = await service.login({ email: 'test@test.com' });

      expect(result).toHaveProperty('access_token', 'mock-jwt-token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('user');
      expect(result.user.id).toBe('user-1');
    });

    it('succeeds with phone', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser });
      prisma.user.update.mockResolvedValue(mockUser);

      const result = await service.login({ phone: '099123456' });

      expect(result.access_token).toBe('mock-jwt-token');
    });

    it('throws when no email or phone', async () => {
      await expect(service.login({} as any)).rejects.toThrow(BadRequestException);
    });

    it('throws when user not found', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.login({ email: 'x@x.com' })).rejects.toThrow(UnauthorizedException);
    });

    it('throws when user inactive', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser, active: false });

      await expect(service.login({ email: 'test@test.com' })).rejects.toThrow(UnauthorizedException);
    });

    it('auto-migrates user without memberships', async () => {
      const userNoMemberships = { ...mockUser, memberships: [] };
      prisma.user.findFirst.mockResolvedValue(userNoMemberships);
      prisma.userCompany.create.mockResolvedValue({});
      prisma.userCompany.findMany.mockResolvedValue(mockUser.memberships);
      prisma.user.update.mockResolvedValue(mockUser);

      const result = await service.login({ email: 'test@test.com' });

      expect(prisma.userCompany.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'user-1',
            companyId: 'comp-1',
          }),
        }),
      );
      expect(result.access_token).toBe('mock-jwt-token');
    });

    it('sets activeCompanyId if not set', async () => {
      const userNoActive = { ...mockUser, activeCompanyId: null };
      prisma.user.findFirst.mockResolvedValue(userNoActive);
      prisma.user.update.mockResolvedValue(mockUser);

      await service.login({ email: 'test@test.com' });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: expect.objectContaining({ activeCompanyId: 'comp-1' }),
        }),
      );
    });

    it('updates lastLogin', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser });
      prisma.user.update.mockResolvedValue(mockUser);

      await service.login({ email: 'test@test.com' });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastLogin: expect.any(Date) }),
        }),
      );
    });

    it('JWT payload includes sub, role, companyId, companyType', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser });
      prisma.user.update.mockResolvedValue(mockUser);

      await service.login({ email: 'test@test.com' });

      expect(mockJwt.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        role: 'gerente',
        companyId: 'comp-1',
        companyType: 'producer',
      });
    });

    it('superAdmin gets platform_admin role in JWT', async () => {
      const superAdmin = { ...mockUser, isSuperAdmin: true };
      prisma.user.findFirst.mockResolvedValue(superAdmin);
      prisma.user.update.mockResolvedValue(superAdmin);

      await service.login({ email: 'test@test.com' });

      expect(mockJwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'platform_admin' }),
      );
    });
  });

  // ================================================================
  // REGISTER
  // ================================================================
  describe('register', () => {
    const dto = {
      name: 'New User',
      email: 'new@test.com',
      phone: '099999999',
      userTypes: ['producer'],
    };

    it('creates user and returns tokens', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({
        ...mockUser, id: 'new-user', name: 'New User', email: 'new@test.com',
        memberships: [],
      });

      const result = await service.register(dto as any);

      expect(result).toHaveProperty('access_token');
      expect(result).toHaveProperty('refresh_token');
      expect(result).toHaveProperty('user');
    });

    it('throws on duplicate email', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      await expect(service.register(dto as any)).rejects.toThrow(ConflictException);
    });

    it('throws on duplicate phone', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue({ id: 'existing' });

      await expect(service.register(dto as any)).rejects.toThrow(ConflictException);
    });

    it('hashes password when provided', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ ...mockUser, memberships: [] });

      await service.register({ ...dto, password: 'secret123' } as any);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: 'hashed-pw' }),
        }),
      );
    });

    it('passwordHash is null when no password', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ ...mockUser, memberships: [] });

      await service.register(dto as any);

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: null }),
        }),
      );
    });
  });

  // ================================================================
  // SWITCH COMPANY
  // ================================================================
  describe('switchCompany', () => {
    it('switches to valid company', async () => {
      prisma.userCompany.findFirst.mockResolvedValue({
        companyId: 'comp-2',
        company: { id: 'comp-2', name: 'Plant Co', type: 'plant', hasInternalFleet: false },
      });
      prisma.user.update.mockResolvedValue({
        ...mockUser,
        activeCompanyId: 'comp-2',
        memberships: [
          ...mockUser.memberships,
          {
            id: 'uc-2', companyId: 'comp-2', role: 'operario', active: true,
            company: { id: 'comp-2', name: 'Plant Co', type: 'plant', hasInternalFleet: false },
            createdAt: new Date(),
          },
        ],
      });

      const result = await service.switchCompany('user-1', { companyId: 'comp-2' });

      expect(result).toHaveProperty('access_token');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { activeCompanyId: 'comp-2' },
        }),
      );
    });

    it('throws when not member', async () => {
      prisma.userCompany.findFirst.mockResolvedValue(null);

      await expect(
        service.switchCompany('user-1', { companyId: 'invalid' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ================================================================
  // REFRESH TOKEN
  // ================================================================
  describe('refresh', () => {
    it('rotates token successfully', async () => {
      const stored = {
        id: 'rt-1',
        token: 'old-token',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 86400000), // tomorrow
      };
      mockPrisma.refreshToken.findUnique.mockResolvedValue(stored);
      prisma.user.findUnique.mockResolvedValue({ ...mockUser });

      const result = await service.refresh({ refreshToken: 'old-token' });

      expect(result).toHaveProperty('access_token');
      expect(result).toHaveProperty('refresh_token');
      // Old token deleted (rotation)
      expect(mockPrisma.refreshToken.delete).toHaveBeenCalledWith({ where: { id: 'rt-1' } });
    });

    it('throws on non-existent token', async () => {
      mockPrisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(
        service.refresh({ refreshToken: 'invalid' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws on expired token', async () => {
      const expired = {
        id: 'rt-2',
        token: 'expired-token',
        userId: 'user-1',
        expiresAt: new Date(Date.now() - 86400000), // yesterday
      };
      mockPrisma.refreshToken.findUnique.mockResolvedValue(expired);

      await expect(
        service.refresh({ refreshToken: 'expired-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('throws when user is inactive', async () => {
      const stored = {
        id: 'rt-3',
        token: 'valid-token',
        userId: 'user-1',
        expiresAt: new Date(Date.now() + 86400000),
      };
      mockPrisma.refreshToken.findUnique.mockResolvedValue(stored);
      prisma.user.findUnique.mockResolvedValue({ ...mockUser, active: false });

      await expect(
        service.refresh({ refreshToken: 'valid-token' }),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  // ================================================================
  // REVOKE
  // ================================================================
  describe('revokeRefreshTokens', () => {
    it('deletes all tokens for user', async () => {
      mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.revokeRefreshTokens('user-1');

      expect(result).toEqual({ ok: true });
      expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });
  });

  // ================================================================
  // GET MY COMPANIES
  // ================================================================
  describe('getMyCompanies', () => {
    it('returns active memberships', async () => {
      const memberships = [
        { companyId: 'c1', company: { id: 'c1', name: 'Farm' } },
        { companyId: 'c2', company: { id: 'c2', name: 'Plant' } },
      ];
      prisma.userCompany.findMany.mockResolvedValue(memberships);

      const result = await service.getMyCompanies('user-1');

      expect(result).toHaveLength(2);
      expect(prisma.userCompany.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user-1', active: true } }),
      );
    });
  });

  // ================================================================
  // buildUserResponse
  // ================================================================
  describe('buildUserResponse (via login)', () => {
    it('derives userTypes from memberships', async () => {
      const multiUser = {
        ...mockUser,
        memberships: [
          { ...mockUser.memberships[0] },
          {
            id: 'uc-2', companyId: 'comp-2', role: 'operario', active: true,
            company: { id: 'comp-2', name: 'Plant Co', type: 'plant', hasInternalFleet: false },
            createdAt: new Date(),
          },
        ],
      };
      prisma.user.findFirst.mockResolvedValue(multiUser);
      prisma.user.update.mockResolvedValue(multiUser);

      const result = await service.login({ email: 'test@test.com' });

      expect(result.user.userTypes).toContain('producer');
      expect(result.user.userTypes).toContain('plant');
      expect(result.user.companyByType).toHaveProperty('producer', 'comp-1');
      expect(result.user.companyByType).toHaveProperty('plant', 'comp-2');
    });

    it('includes companies array', async () => {
      prisma.user.findFirst.mockResolvedValue({ ...mockUser });
      prisma.user.update.mockResolvedValue(mockUser);

      const result = await service.login({ email: 'test@test.com' });

      expect(result.user.companies).toHaveLength(1);
      expect(result.user.companies[0]).toHaveProperty('companyId', 'comp-1');
      expect(result.user.companies[0]).toHaveProperty('role', 'gerente');
    });
  });
});
