import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');
import { PrismaService } from '../database/prisma.service';
import { LoginDto, RegisterDto, SwitchCompanyDto } from './auth.dto';

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

    const user = await this.prisma.user.findFirst({
      where,
      include: {
        company: { select: { id: true, name: true, type: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
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
      }).catch(() => {}); // ignore if already exists
      // Re-fetch
      (user as any).memberships = await this.prisma.userCompany.findMany({
        where: { userId: user.id, active: true },
        include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
        orderBy: { createdAt: 'asc' },
      });
    }

    // Set activeCompanyId if not set
    if (!user.activeCompanyId && user.memberships.length > 0) {
      const firstCompanyId = user.memberships[0].companyId;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeCompanyId: firstCompanyId },
      });
      (user as any).activeCompanyId = firstCompanyId;
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    const token = await this.signToken(user);
    this.logger.log(`User ${user.id} logged in`);

    return {
      access_token: token,
      user: this.buildUserResponse(user),
    };
  }

  async register(dto: RegisterDto) {
    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) {
      throw new ConflictException('Email ya registrado');
    }

    const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (phoneExists) {
      throw new ConflictException('Telefono ya registrado');
    }

    const hash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash: hash,
        name: dto.name,
        role: 'operator',
        userTypes: dto.userTypes,
      },
      include: {
        company: { select: { id: true, name: true, type: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const token = await this.signToken(user);

    return {
      access_token: token,
      user: this.buildUserResponse(user),
    };
  }

  async switchCompany(userId: string, dto: SwitchCompanyDto) {
    // Verify membership exists
    const membership = await this.prisma.userCompany.findFirst({
      where: { userId, companyId: dto.companyId, active: true },
      include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
    });
    if (!membership) {
      throw new BadRequestException('No pertenecés a esta empresa');
    }

    // Update activeCompanyId
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { activeCompanyId: dto.companyId },
      include: {
        company: { select: { id: true, name: true, type: true, hasInternalFleet: true } },
        memberships: {
          where: { active: true },
          include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    const token = await this.signToken(user);
    this.logger.log(`User ${userId} switched to company ${dto.companyId}`);

    return {
      access_token: token,
      user: this.buildUserResponse(user),
    };
  }

  async getMyCompanies(userId: string) {
    return this.prisma.userCompany.findMany({
      where: { userId, active: true },
      include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  private buildUserResponse(user: any) {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCompanyId = user.activeCompanyId || user.companyId || memberships[0]?.companyId || null;
    const activeMembership = memberships.find((m: any) => m.companyId === activeCompanyId);
    const activeCompany = activeMembership?.company || user.company || null;

    // Derive userTypes from memberships
    const userTypes = [...new Set(memberships.map((m: any) => m.company?.type).filter(Boolean))];

    // Derive companyByType from memberships (backward compat)
    const companyByType: any = {};
    for (const m of memberships) {
      if (m.company?.type && !companyByType[m.company.type]) {
        companyByType[m.company.type] = m.companyId;
      }
    }

    // Derive roleByType from memberships (backward compat)
    const roleByType: any = {};
    for (const m of memberships) {
      if (m.company?.type) {
        roleByType[m.company.type] = m.role;
      }
    }

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      role: user.isSuperAdmin ? 'platform_admin' : (activeMembership?.role || user.role || 'operario'),
      userTypes: userTypes.length > 0 ? userTypes : (user.userTypes || []),
      companyByType,
      roleByType,
      isSuperAdmin: user.isSuperAdmin || false,
      company: activeCompany,
      activeCompanyId,
      companies: memberships.map((m: any) => ({
        id: m.id,
        companyId: m.companyId,
        companyName: m.company?.name || '',
        companyType: m.company?.type || '',
        role: m.role,
        hasInternalFleet: m.company?.hasInternalFleet || false,
      })),
    };
  }

  private async signToken(user: any): Promise<string> {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCompanyId = user.activeCompanyId || user.companyId || memberships[0]?.companyId || null;
    const activeMembership = memberships.find((m: any) => m.companyId === activeCompanyId);
    const activeCompany = activeMembership?.company || user.company;

    const payload = {
      sub: user.id,
      role: user.isSuperAdmin ? 'platform_admin' : (activeMembership?.role || user.role || 'operario'),
      companyId: activeCompanyId,
      companyType: activeCompany?.type || null,
    };
    return this.jwt.signAsync(payload);
  }
}
