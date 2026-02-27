import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomInt } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { LoginDto, RegisterDto, SwitchCompanyDto, RefreshTokenDto, RequestCodeDto, VerifyCodeDto, ResetPasswordDto, ChangePasswordDto } from './auth.dto';

const REFRESH_TOKEN_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const CODE_EXPIRY_MINUTES = 10;
const MAX_CODE_ATTEMPTS = 3;
const MAX_CODES_PER_HOUR = 3;

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
    private whatsapp: WhatsAppService,
  ) {}

  async login(dto: LoginDto) {
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Email o teléfono requerido');
    }

    if (dto.email) dto.email = dto.email.toLowerCase().trim();
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

    // Generic error — same whether user exists or not
    if (!user || !user.active) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Check lockout
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      throw new UnauthorizedException(
        `Cuenta bloqueada temporalmente. Intentá de nuevo en ${minutesLeft} minuto${minutesLeft !== 1 ? 's' : ''}.`,
      );
    }

    // User has no password set — return special error for first-time setup
    if (!user.passwordHash) {
      const maskedPhone = this.maskPhone(user.phone);
      throw new UnauthorizedException({
        statusCode: 401,
        message: 'Necesitás configurar tu contraseña',
        code: 'NO_PASSWORD',
        maskedPhone,
      });
    }

    // Password is required
    if (!dto.password) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Verify password
    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      const newAttempts = (user.failedLoginAttempts || 0) + 1;
      const updateData: any = { failedLoginAttempts: newAttempts };
      if (newAttempts >= MAX_FAILED_ATTEMPTS) {
        updateData.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000);
        this.logger.warn(`User ${user.id} locked out after ${newAttempts} failed attempts`);
      }
      await this.prisma.user.update({ where: { id: user.id }, data: updateData });
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Auto-migrate: if user has no memberships but has companyId, create one
    if (user.memberships.length === 0 && user.companyId) {
      await this.prisma.userCompany.create({
        data: {
          userId: user.id,
          companyId: user.companyId,
          role: user.role === 'admin' || user.role === 'platform_admin' ? 'gerente' : 'operario',
        },
      }).catch(e => this.logger.warn(e.message));
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
        data: { activeCompanyId: firstCompanyId, companyId: firstCompanyId },
      });
      user.activeCompanyId = firstCompanyId;
      user.companyId = firstCompanyId;
    }

    // Successful login — reset failed attempts + update lastLogin
    const activeId = user.activeCompanyId || user.companyId;
    const loginUpdate: any = { lastLogin: new Date(), failedLoginAttempts: 0, lockedUntil: null };
    if (activeId && user.companyId !== activeId) {
      loginUpdate.companyId = activeId;
    }
    await this.prisma.user.update({ where: { id: user.id }, data: loginUpdate });
    if (activeId) user.companyId = activeId;

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
    dto.email = dto.email.toLowerCase().trim();
    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) throw new ConflictException('Email ya registrado');

    const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (phoneExists) throw new ConflictException('Teléfono ya registrado');

    const hash = await bcrypt.hash(dto.password, 10);

    // Validate userTypes values
    const validTypes = ['producer', 'plant', 'transporter'];
    const userTypes = (dto.userTypes || []).filter((t: string) => validTypes.includes(t));

    let user: any;
    try {
      user = await (this.prisma.user as any).create({
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
    } catch (err: any) {
      if (err.code === 'P2002') {
        const field = err.meta?.target?.includes('email') ? 'Email' : 'Teléfono';
        throw new ConflictException(`${field} ya registrado`);
      }
      throw err;
    }

    const token = await this.signToken(user);
    const refreshToken = await this.createRefreshToken(user.id);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  // ======================== PASSWORD RESET VIA WHATSAPP ==================

  async requestCode(dto: RequestCodeDto) {
    const genericResponse = { ok: true, message: 'Si el número está registrado, recibirás un código por WhatsApp.' };

    const user = await this.prisma.user.findFirst({ where: { phone: dto.phone, active: true } });
    if (!user) {
      this.logger.debug(`requestCode: no active user for phone ${dto.phone}`);
      return genericResponse;
    }

    // Rate limit: max codes per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCodes = await (this.prisma as any).passwordResetCode.count({
      where: { userId: user.id, createdAt: { gt: oneHourAgo } },
    });
    if (recentCodes >= MAX_CODES_PER_HOUR) {
      this.logger.warn(`requestCode: rate limit for user ${user.id}`);
      return genericResponse;
    }

    // Invalidate previous unused codes
    await (this.prisma as any).passwordResetCode.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Generate 6-digit code
    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, 10);

    await (this.prisma as any).passwordResetCode.create({
      data: {
        userId: user.id,
        codeHash,
        expiresAt: new Date(Date.now() + CODE_EXPIRY_MINUTES * 60 * 1000),
      },
    });

    // Send via WhatsApp
    const sent = await this.whatsapp.sendText(
      dto.phone,
      `Tu código de verificación Tolvink es: *${code}*\n\nExpira en ${CODE_EXPIRY_MINUTES} minutos.\nSi no solicitaste esto, ignorá este mensaje.`,
    );
    if (!sent) {
      this.logger.error(`requestCode: WhatsApp send failed for user ${user.id}`);
    }

    return genericResponse;
  }

  async verifyCode(dto: VerifyCodeDto) {
    const user = await this.prisma.user.findFirst({ where: { phone: dto.phone, active: true } });
    if (!user) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    const resetCode = await (this.prisma as any).passwordResetCode.findFirst({
      where: { userId: user.id, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!resetCode) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    if (resetCode.attempts >= MAX_CODE_ATTEMPTS) {
      await (this.prisma as any).passwordResetCode.update({
        where: { id: resetCode.id },
        data: { used: true },
      });
      throw new UnauthorizedException('Código inválido o expirado');
    }

    const valid = await bcrypt.compare(dto.code, resetCode.codeHash);
    if (!valid) {
      await (this.prisma as any).passwordResetCode.update({
        where: { id: resetCode.id },
        data: { attempts: resetCode.attempts + 1 },
      });
      const remaining = MAX_CODE_ATTEMPTS - resetCode.attempts - 1;
      throw new UnauthorizedException(
        remaining > 0
          ? `Código incorrecto. Te quedan ${remaining} intento${remaining !== 1 ? 's' : ''}.`
          : 'Código inválido o expirado',
      );
    }

    // Mark code as used
    await (this.prisma as any).passwordResetCode.update({
      where: { id: resetCode.id },
      data: { used: true },
    });

    // Issue short-lived reset token
    const resetToken = await this.jwt.signAsync(
      { sub: user.id, purpose: 'password-reset' },
      { expiresIn: '10m' },
    );

    return { ok: true, resetToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(dto.resetToken);
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    if (payload.purpose !== 'password-reset') {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const user = await (this.prisma.user as any).findUnique({
      where: { id: payload.sub },
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
      throw new UnauthorizedException('Token inválido o expirado');
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, failedLoginAttempts: 0, lockedUntil: null },
    });

    // Revoke all refresh tokens (force re-login on other devices)
    await (this.prisma as any).refreshToken.deleteMany({ where: { userId: user.id } }).catch(e => this.logger.warn(e.message));

    // Auto-login
    const token = await this.signToken(user);
    const refreshToken = await this.createRefreshToken(user.id);
    this.logger.log(`User ${user.id} reset password successfully`);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.active) {
      throw new UnauthorizedException('Usuario no encontrado');
    }

    if (user.passwordHash) {
      const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
      if (!valid) {
        throw new UnauthorizedException('Contraseña actual incorrecta');
      }
    }

    const hash = await bcrypt.hash(dto.newPassword, 10);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hash },
    });

    this.logger.log(`User ${userId} changed password`);
    return { ok: true, message: 'Contraseña actualizada correctamente' };
  }

  // ======================== EXISTING METHODS =============================

  async switchCompany(userId: string, dto: SwitchCompanyDto) {
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

    await (this.prisma as any).refreshToken.deleteMany({ where: { userId } }).catch(e => this.logger.warn(e.message));

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
    const { storedUser } = await this.prisma.$transaction(async (tx) => {
      const stored = await (tx as any).refreshToken.findUnique({
        where: { token: dto.refreshToken },
      });

      if (!stored || stored.expiresAt < new Date()) {
        if (stored) await (tx as any).refreshToken.delete({ where: { id: stored.id } });
        throw new UnauthorizedException('Token de refresco inválido o expirado');
      }

      await (tx as any).refreshToken.delete({ where: { id: stored.id } });

      const storedUser = await (tx.user as any).findUnique({
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

      if (!storedUser || !storedUser.active) throw new UnauthorizedException('Usuario inactivo');

      return { storedUser };
    });

    const accessToken = await this.signToken(storedUser);
    const newRefreshToken = await this.createRefreshToken(storedUser.id);
    this.logger.log(`User ${storedUser.id} refreshed token`);

    return {
      access_token: accessToken,
      refresh_token: newRefreshToken,
      user: this.buildUserResponse(storedUser),
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

  async completeOnboarding(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { onboardingCompletedAt: new Date() },
    });
    return { ok: true };
  }

  // ======================== PRIVATE ====================================

  private maskPhone(phone: string | null): string | null {
    if (!phone || phone.length < 5) return null;
    return phone.slice(0, 3) + '*'.repeat(phone.length - 5) + phone.slice(-2);
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    await (this.prisma as any).refreshToken.create({ data: { token, userId, expiresAt } });
    (this.prisma as any).refreshToken.deleteMany({
      where: { userId, expiresAt: { lt: new Date() } },
    }).catch(e => this.logger.warn(e.message));
    return token;
  }

  private buildUserResponse(user: any) {
    const memberships = (user.memberships || []).filter((m: any) => m.active);
    const activeCompanyId = user.activeCompanyId || user.companyId || memberships[0]?.companyId || null;
    const activeMembership = memberships.find((m: any) => m.companyId === activeCompanyId);
    const activeCompany = activeMembership?.company || user.company || null;

    const typeSet = new Set<string>();
    for (const m of memberships) {
      for (const t of getCompanyTypes(m.company)) typeSet.add(t);
    }
    const userTypes = Array.from(typeSet);

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
      isNew: !user.onboardingCompletedAt,
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

    const companyTypes = getCompanyTypes(activeCompany);
    const companyType = companyTypes[0] || activeCompany?.type || null;

    const payload = {
      sub: user.id,
      role: user.isSuperAdmin ? 'platform_admin' : (activeMembership?.role || user.role || 'operario'),
      companyId: activeCompanyId,
      companyType,
      companyTypes,
    };
    return this.jwt.signAsync(payload);
  }
}
