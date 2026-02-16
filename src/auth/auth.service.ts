import { Injectable, UnauthorizedException, ConflictException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bcrypt = require('bcryptjs');
import { PrismaService } from '../database/prisma.service';
import { LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    try {
      if (!dto.email && !dto.phone) {
        throw new BadRequestException('Email o telefono requerido');
      }

      const where = dto.phone
        ? { phone: dto.phone }
        : { email: dto.email };

      console.log('[AUTH SERVICE] Login attempt:', where);

      const user = await this.prisma.user.findFirst({
        where,
        include: {
          company: {
            select: { id: true, name: true, type: true, hasInternalFleet: true }
          }
        },
      });

      console.log('[AUTH SERVICE] User found:', user ? { id: user.id, hasCompany: !!user.company } : 'null');

      if (!user || !user.active) {
        throw new UnauthorizedException('Credenciales invalidas');
      }

      const valid = await bcrypt.compare(dto.password, user.passwordHash);
      if (!valid) {
        throw new UnauthorizedException('Credenciales invalidas');
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { lastLogin: new Date() },
      });

      const token = await this.signToken(user);

      console.log('[AUTH SERVICE] Login successful for user:', user.id);

      return {
        access_token: token,
        user: this.buildUserResponse(user),
      };
    } catch (error) {
      console.error('[AUTH SERVICE] Login error:', error);
      throw error;
    }
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

    const hash = await bcrypt.hash(dto.password, 10);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash: hash,
        name: dto.name,
        role: 'operator',
        userTypes: dto.userTypes,
      },
      include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
    });

    const token = await this.signToken(user);

    return {
      access_token: token,
      user: this.buildUserResponse(user),
    };
  }

  private buildUserResponse(user: any) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      role: user.role,
      userTypes: user.userTypes || [],
      companyByType: user.companyByType || {},
      roleByType: user.roleByType || {},
      isSuperAdmin: user.isSuperAdmin || false,
      company: user.company || null,
    };
  }

  private async signToken(user: any): Promise<string> {
    try {
      const payload = {
        sub: user.id,
        role: user.role,
        companyId: user.companyId || user.company?.id || null,
        companyType: user.company?.type || null,
      };

      console.log('[AUTH SERVICE] Signing token with payload:', payload);

      return this.jwt.signAsync(payload);
    } catch (error) {
      console.error('[AUTH SERVICE] Token signing error:', error);
      throw error;
    }
  }
}
