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
    if (!dto.email && !dto.phone) {
      throw new BadRequestException('Email o teléfono requerido');
    }

    // Find user by email or phone
    const where = dto.phone
      ? { phone: dto.phone }
      : { email: dto.email };

    const user = await this.prisma.user.findFirst({
      where,
      include: { company: { select: { id: true, name: true, type: true, hasInternalFleet: true } } },
    });

    if (!user || !user.active) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    const valid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Credenciales inválidas');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    const token = await this.signToken(user);

    return {
      access_token: token,
      user: this.buildUserResponse(user),
    };
  }

  async register(dto: RegisterDto) {
    // Check email uniqueness
    const emailExists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (emailExists) {
      throw new ConflictException('Email ya registrado');
    }

    // Check phone uniqueness
    const phoneExists = await this.prisma.user.findFirst({ where: { phone: dto.phone } });
    if (phoneExists) {
      throw new ConflictException('Teléfono ya registrado');
    }

    const hash = await bcrypt.hash(dto.password, 10);

    // Create user WITHOUT company — admin assigns company later
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        phone: dto.phone,
        passwordHash: hash,
        name: dto.name,
        role: 'operator',
        userTypes: dto.userTypes,
        // companyId stays null — user is "free" until admin links them
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
      isSuperAdmin: user.isSuperAdmin || false,
      company: user.company || null,
    };
  }

  private async signToken(user: any): Promise<string> {
    return this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      companyId: user.companyId || user.company?.id,
      companyType: user.company?.type,
    });
  }
}
