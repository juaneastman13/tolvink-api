import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');
import { PrismaService } from '../database/prisma.service';
import { LoginDto, RegisterDto, SwitchCompanyDto, RefreshTokenDto } from './auth.dto';

const REFRESH_TOKEN_DAYS = 7;

// Company select with types field (Json field not yet in generated Prisma client)
const COMPANY_SELECT = { id: true, name: true, type: true, types: true, hasInternalFleet: true } as any;

/** Helper: get all types for a company (from types[] array or fallback to type) */
function getCompanyTypes(company: any): string[] {
  if (!company) return [];
  const arr = Array.isArray(company.types) && company.types.length > 0
    ? company.types
    : (company.type ? [company.type] : []);
  return arr;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Email o telefono requerido');
    }

    const where = dto.phone
      ? { phone: dto.phone }
      : { email: dto.email };

    const user = await (this.prisma.user as any).findFirst({
      where,
      include: {
        company: { select: COMPANY_SELECT },
        memberships: {
          where: { active: true },
          include: { company: { select: COMPANY_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException('Credenciales invalidas');
    }

    // Auto-migrate: if user has no memberships but has companyId, create one
    if (user.memberships.length === 0 && user.companyId) {
      await this.prisma.userCompany.create({
        data: {
          userId: user.id,
          companyId: user.companyId,
          role: user.role === 'admin' || user.role === 'platform_admin' ? 'gerente' : 'operario',
        },
      }).catch(() => {});
      user.memberships = await (this.prisma.userCompany as any).findMany({
        where: { userId: user.id, active: true },
        include: { company: { select: COMPANY_SELECT } },
        orderBy: { createdAt: 'asc' },
      });
    }

    if (!user.activeCompanyId && user.memberships.length > 0) {
      const firstCompanyId = user.memberships[0].companyId;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeCompanyId: firstCompanyId, companyId: firstCompanyId }, // Legacy field — kept in sync with activeCompanyId
      });
      user.activeCompanyId = firstCompanyId;
      user.companyId = firstCompanyId;
    }

    // Legacy field — kept in sync with activeCompanyId
    const activeId = user.activeCompanyId || user.companyId;
    if (activeId && user.companyId !== activeId) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date(), companyId: activeId },
      });
      user.companyId = activeId;
    } else {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });
    }

    const token = await this.signToken(user);
    const refreshToken = await this.createRefreshToken(user.id);
    this.logger.log(`User ${user.id} logged in`);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async register(dto: RegisterDto) {
    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) throw new ConflictException('Email ya registrado');

    const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (phoneExists) throw new ConflictException('Telefono ya registrado');

    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    // Validate userTypes values
    const validTypes = ['producer', 'plant', 'transporter'];
    const userTypes = (dto.userTypes || []).filter((t: string) => validTypes.includes(t));

    const user = await (this.prisma.user as any).create({
      data: {
        email: dto.email, phone: dto.phone, passwordHash: hash,
        name: dto.name, role: 'operator', userTypes,
      },
      include: {
        company: { select: COMPANY_SELECT },
        memberships: {
          where: { active: true },
          include: { company: { select: COMPANY_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const token = await this.signToken(user);
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async switchCompany(userId: string, dto: SwitchCompanyDto) {
    // Get old activeCompanyId for audit log
    const currentUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeCompanyId: true, companyId: true },
    });
    const oldCompanyId = currentUser?.activeCompanyId || currentUser?.companyId || null;

    const membership = await (this.prisma.userCompany as any).findFirst({
      where: { userId, companyId: dto.companyId, active: true },
      include: { company: { select: COMPANY_SELECT } },
    });
    if (!membership) throw new BadRequestException('No pertenecés a esta empresa');

    // Legacy field — kept in sync with activeCompanyId
    const user = await (this.prisma.user as any).update({
      where: { id: userId },
      data: { activeCompanyId: dto.companyId, companyId: dto.companyId },
      include: {
        company: { select: COMPANY_SELECT },
        memberships: {
          where: { active: true },
          include: { company: { select: COMPANY_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Invalidate ALL existing refresh tokens for this user (security: old sessions)
    await (this.prisma as any).refreshToken.deleteMany({ where: { userId } }).catch(() => {});

    // Audit log entry for company switch
    await this.prisma.auditLog.create({
      data: {
        entityType: 'user',
        entityId: userId,
        action: 'switch_company',
        fromValue: oldCompanyId || undefined,
        toValue: dto.companyId,
        userId,
      },
    }).catch((err: any) => this.logger.warn(`Audit log failed: ${err.message}`));

    const token = await this.signToken(user);
    const refreshToken = await this.createRefreshToken(user.id);
    this.logger.log(`User ${userId} switched to company ${dto.companyId}`);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async refresh(dto: RefreshTokenDto) {
    const stored = await (this.prisma as any).refreshToken.findUnique({
      where: { token: dto.refreshToken },
    });

    if (!stored || stored.expiresAt < new Date()) {
      if (stored) await (this.prisma as any).refreshToken.delete({ where: { id: stored.id } }).catch(() => {});
      throw new UnauthorizedException('Token de refresco inválido o expirado');
    }

    // Rotation: delete used token
    await (this.prisma as any).refreshToken.delete({ where: { id: stored.id } }).catch(() => {});

    const user = await (this.prisma.user as any).findUnique({
      where: { id: stored.userId },
      include: {
        company: { select: COMPANY_SELECT },
        memberships: {
          where: { active: true },
          include: { company: { select: COMPANY_SELECT } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!user || !user.active) throw new UnauthorizedException('Usuario inactivo');

    const accessToken = await this.signToken(user);
    const newRefreshToken = await this.createRefreshToken(user.id);
    this.logger.log(`User ${user.id} refreshed token`);

    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async revokeRefreshTokens(userId: string) {
    const { count } = await (this.prisma as any).refreshToken.deleteMany({ where: { userId } });
    this.logger.log(`Revoked ${count} refresh tokens for user ${userId}`);
    return { ok: true };
  }

  async getMyCompanies(userId: string) {
    return (this.prisma.userCompany as any).findMany({
      where: { userId, active: true },
      include: { company: { select: COMPANY_SELECT } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ======================== PRIVATE ====================================

  private async createRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    await (this.prisma as any).refreshToken.create({ data: { token, userId, expiresAt } });
    // Clean expired tokens (fire-and-forget)
    (this.prisma as any).refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    }).catch(() => {});
    return token;
  }

  private buildUserResponse(user: any) {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCompanyId = user.activeCompanyId || user.companyId || memberships[0]?.companyId || null;
    const activeMembership = memberships.find((m: any) => m.companyId === activeCompanyId);
    const activeCompany = activeMembership?.company || user.company || null;

    // Derive userTypes from actual memberships (not stored field) — includes multi-type support
    const typeSet = new Set<string>();
    for (const m of memberships) {
      for (const t of getCompanyTypes(m.company)) typeSet.add(t);
    }
    const userTypes = Array.from(typeSet);

    // Derive companyByType from actual memberships
    const companyByType: any = {};
    for (const m of memberships) {
      for (const t of getCompanyTypes(m.company)) {
        if (!companyByType[t]) companyByType[t] = m.companyId;
      }
    }

    const roleByType: any = {};
    for (const m of memberships) {
      for (const t of getCompanyTypes(m.company)) {
        roleByType[t] = m.role;
      }
    }

    // Include company types if available
    const companyResponse = activeCompany ? {
      ...activeCompany,
      types: getCompanyTypes(activeCompany),
    } : null;

    return {
      id: user.id, name: user.name, email: user.email, phone: user.phone || null,
      role: user.isSuperAdmin ? 'platform_admin' : (activeMembership?.role || user.role || 'operario'),
      userTypes: userTypes.length > 0 ? userTypes : (user.userTypes || []),
      companyByType, roleByType,
      isSuperAdmin: user.isSuperAdmin || false,
      company: companyResponse, activeCompanyId,
      companies: memberships.map((m: any) => ({
        id: m.id, companyId: m.companyId, companyName: m.company?.name || '',
        companyType: m.company?.type || '', role: m.role,
        companyTypes: getCompanyTypes(m.company),
        hasInternalFleet: m.company?.hasInternalFleet || false,
      })),
    };
  }

  private async signToken(user: any): Promise<string> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCompanyId = user.activeCompanyId || user.companyId || memberships[0]?.companyId || null;
    const activeMembership = memberships.find((m: any) => m.companyId === activeCompanyId);
    const activeCompany = activeMembership?.company || user.company;

    // companyType: use primary type from the active company
    const companyTypes = getCompanyTypes(activeCompany);
    const companyType = companyTypes[0] || activeCompany?.type || null;

    const payload = {
      sub: user.id,
      role: user.isSuperAdmin ? 'platform_admin' : (activeMembership?.role || user.role || 'operario'),
      companyId: activeCompanyId,
      companyType,
      companyTypes, // Include all types in JWT for multi-type context
    };
    return this.jwt.signAsync(payload);
  }
}
