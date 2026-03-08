import { Injectable, UnauthorizedException, ConflictException, BadRequestException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, randomInt, randomUUID, createHash } from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');
import { PrismaService } from '../database/prisma.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { LoginDto, RegisterDto, SwitchCompanyDto, RefreshTokenDto, IdentifyForResetDto, RequestCodeDto, VerifyCodeDto, ResetPasswordDto, ChangePasswordDto } from './auth.dto';
import { BCRYPT_ROUNDS } from '../common/constants';

// Pre-computed valid bcrypt hash for constant-time comparison against non-existent users
// Use synchronous hashSync to guarantee DUMMY_HASH is ready before any request
const DUMMY_HASH = bcrypt.hashSync(randomBytes(16).toString('hex'), 10);
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
    const user = await (this.prisma.user as any).findUnique({
      where: dto.phone ? { phone: dto.phone } : { email: dto.email },
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
      await bcrypt.compare(dto.password || 'x', DUMMY_HASH);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Check lockout
    if (user.lockedUntil) {
      if (user.lockedUntil > new Date()) {
        await bcrypt.compare(dto.password || 'x', DUMMY_HASH); // constant-time to prevent timing oracle
        throw new UnauthorizedException('Credenciales inválidas');
      }
      // Lockout expired — reset counter so user gets full 5 attempts again
      await this.prisma.user.updateMany({
        where: { id: user.id, lockedUntil: { not: null, lt: new Date() } },
        data: { failedLoginAttempts: 0, lockedUntil: null },
      });
      user.failedLoginAttempts = 0;
      user.lockedUntil = null;
    }

    // User has no password set — generic message + header hint (not in JSON body)
    if (!user.passwordHash) {
      await bcrypt.compare(dto.password || 'x', DUMMY_HASH);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Password is required — dummy compare to prevent timing oracle
    if (!dto.password) {
      await bcrypt.compare('x', DUMMY_HASH);
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Verify password
    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      const newAttempts = (user.failedLoginAttempts || 0) + 1;
      const updateData: any = { failedLoginAttempts: { increment: 1 } };
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
    if (emailExists) throw new ConflictException('Email o teléfono ya registrado');

    const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (phoneExists) throw new ConflictException('Email o teléfono ya registrado');

    const hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Validate userTypes values
    const validTypes = ['producer', 'plant', 'transporter'];
    const userTypes = (dto.userTypes || []).filter((t: string) => validTypes.includes(t));
    if (userTypes.length === 0) {
      throw new BadRequestException('Seleccioná al menos un tipo válido (producer, plant, transporter)');
    }

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

  /** Step 1: Identify user by email/phone → return masked phone */
  async identifyForReset(dto: IdentifyForResetDto) {
    const identifier = dto.identifier.trim().toLowerCase();
    const isPhone = /^09\d{7}$/.test(identifier.replace(/[\s\-()]/g, ''));
    const where = isPhone
      ? { phone: identifier.replace(/[\s\-()]/g, ''), active: true }
      : { email: identifier, active: true };

    const user = await this.prisma.user.findFirst({ where, select: { phone: true } });

    // Constant-time: compare against dummy hash to prevent timing-based user enumeration
    await bcrypt.compare('x', DUMMY_HASH);

    if (!user || !user.phone) {
      // Match maskPhone output format for standard 9-digit UY phone: slice(0,3) + repeat(4) + slice(-2)
      return { ok: true, maskedPhone: '09x****00' };
    }

    return { ok: true, maskedPhone: this.maskPhone(user.phone) };
  }

  /** Step 2: Confirm phone matches → send WhatsApp code */
  async requestCode(dto: RequestCodeDto) {
    const identifier = dto.identifier.trim().toLowerCase();
    const isPhone = /^09\d{7}$/.test(identifier.replace(/[\s\-()]/g, ''));
    const where = isPhone
      ? { phone: identifier.replace(/[\s\-()]/g, ''), active: true }
      : { email: identifier, active: true };

    const user = await this.prisma.user.findFirst({ where });
    if (!user) {
      throw new BadRequestException('No se pudo verificar la información. Revisá los datos e intentá de nuevo.');
    }

    // Verify the confirmed phone matches the registered phone
    if (user.phone !== dto.phone) {
      throw new BadRequestException('No se pudo verificar la información. Revisá los datos e intentá de nuevo.');
    }

    // Rate limit: max codes per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCodes = await (this.prisma as any).passwordResetCode.count({
      where: { userId: user.id, createdAt: { gt: oneHourAgo } },
    });
    if (recentCodes >= MAX_CODES_PER_HOUR) {
      throw new BadRequestException('Demasiados intentos. Esperá un rato antes de pedir otro código.');
    }

    // Invalidate previous unused codes
    await (this.prisma as any).passwordResetCode.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    });

    // Generate 6-digit code
    const code = String(randomInt(100000, 999999));
    const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);

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
      throw new BadRequestException('No se pudo enviar el código por WhatsApp. Intentá de nuevo.');
    }

    return { ok: true, message: 'Código enviado por WhatsApp.' };
  }

  async verifyCode(dto: VerifyCodeDto) {
    const user = await this.prisma.user.findFirst({ where: { phone: dto.phone, active: true } });
    if (!user) {
      await bcrypt.compare(dto.code || 'x', DUMMY_HASH); // constant-time to prevent timing oracle
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

    // Atomically increment attempts BEFORE comparing — prevents race condition
    const updated = await (this.prisma as any).passwordResetCode.updateMany({
      where: { id: resetCode.id, attempts: { lt: MAX_CODE_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (updated.count === 0) {
      throw new UnauthorizedException('Código inválido o expirado');
    }

    const valid = await bcrypt.compare(dto.code, resetCode.codeHash);
    if (!valid) {
      throw new UnauthorizedException('Código incorrecto.');
    }

    // Mark code as used and store jti for replay prevention
    const jti = randomUUID();
    await (this.prisma as any).passwordResetCode.update({
      where: { id: resetCode.id },
      data: { used: true, resetJti: jti },
    });

    // Issue short-lived reset token with jti nonce
    const resetToken = await this.jwt.signAsync(
      { sub: user.id, purpose: 'password-reset', jti },
      { expiresIn: '10m' },
    );

    return { ok: true, resetToken };
  }

  async resetPassword(dto: ResetPasswordDto) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(dto.resetToken, { algorithms: ['HS256'] });
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    if (payload.purpose !== 'password-reset') {
      throw new UnauthorizedException('Token inválido o expirado');
    }

    // Atomically consume the jti — prevents replay
    const jti = payload.jti;
    if (!jti) {
      throw new UnauthorizedException('Token inválido o expirado');
    }
    const consumed = await (this.prisma as any).passwordResetCode.updateMany({
      where: { userId: payload.sub, resetJti: jti, used: true },
      data: { resetJti: null },
    });
    if (consumed.count === 0) {
      throw new UnauthorizedException('Token ya utilizado');
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

    const hash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
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

    if (!user.passwordHash) {
      throw new BadRequestException('No tenés contraseña configurada. Usá el flujo de recuperación por WhatsApp.');
    }
    const valid = await bcrypt.compare(dto.currentPassword, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Contraseña actual incorrecta');
    }

    if (dto.newPassword === dto.currentPassword) {
      throw new BadRequestException('La nueva contraseña debe ser diferente a la actual');
    }

    const hash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash: hash },
    });

    // Revoke all refresh tokens (force re-login on other devices)
    await (this.prisma as any).refreshToken.deleteMany({ where: { userId } });

    // Issue new tokens for the current session
    const [newAccessToken, newRefreshToken] = await Promise.all([
      this.signToken(user),
      this.createRefreshToken(userId),
    ]);

    this.logger.log(`User ${userId} changed password`);
    return { ok: true, message: 'Contraseña actualizada correctamente', access_token: newAccessToken, refresh_token: newRefreshToken };
  }

  // ======================== EXISTING METHODS =============================

  async switchCompany(userId: string, dto: SwitchCompanyDto) {
    // Verify membership first
    const membership = await (this.prisma.userCompany as any).findFirst({
      where: { userId, companyId: dto.companyId, active: true },
      include: { company: { select: COMPANY_SELECT } },
    });
    if (!membership) throw new BadRequestException('No pertenecés a esta empresa');

    // Atomic: update user + revoke old tokens + audit in a single transaction
    const user = await this.prisma.$transaction(async (tx) => {
      const currentUser = await tx.user.findUnique({
        where: { id: userId },
        select: { activeCompanyId: true, companyId: true },
      });
      const oldCompanyId = currentUser?.activeCompanyId || currentUser?.companyId || null;

      const updated = await (tx.user as any).update({
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

      await (tx as any).refreshToken.deleteMany({ where: { userId } });

      await tx.auditLog.create({
        data: {
          entityType: 'user',
          entityId: userId,
          action: 'switch_company',
          fromValue: oldCompanyId || undefined,
          toValue: dto.companyId,
          userId,
        },
      }).catch((err: any) => this.logger.warn(`Audit log failed: ${err.message}`));

      return updated;
    });

    const [token, refreshToken] = await Promise.all([
      this.signToken(user),
      this.createRefreshToken(user.id),
    ]);
    this.logger.log(`User ${userId} switched to company ${dto.companyId}`);

    return {
      access_token: token,
      refresh_token: refreshToken,
      user: this.buildUserResponse(user),
    };
  }

  async refresh(dto: RefreshTokenDto | { refreshToken: string }) {
    const tokenHash = this.hashToken(dto.refreshToken);
    const { storedUser } = await this.prisma.$transaction(async (tx) => {
      const stored = await (tx as any).refreshToken.findUnique({
        where: { token: tokenHash },
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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async createRefreshToken(userId: string): Promise<string> {
    const token = randomBytes(40).toString('hex');
    const tokenHash = this.hashToken(token);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000);
    // Limit active refresh tokens per user (max 10)
    const activeCount = await (this.prisma as any).refreshToken.count({ where: { userId, expiresAt: { gt: new Date() } } });
    if (activeCount >= 10) {
      const oldest = await (this.prisma as any).refreshToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' }, take: activeCount - 9, select: { id: true } });
      if (oldest.length > 0) await (this.prisma as any).refreshToken.deleteMany({ where: { id: { in: oldest.map((t: any) => t.id) } } });
    }
    await (this.prisma as any).refreshToken.create({ data: { token: tokenHash, userId, expiresAt } });
    await (this.prisma as any).refreshToken.deleteMany({
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
    return this.jwt.signAsync(payload, { expiresIn: '30m' });
  }
}
