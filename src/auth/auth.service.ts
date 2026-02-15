import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { LoginDto, RegisterDto } from './auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
  ) {}

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { company: { select: { id: true, name: true, type: true } } },
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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company: user.company,
      },
    };
  }

  async register(dto: RegisterDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) {
      throw new ConflictException('Email ya registrado');
    }

    const hash = await bcrypt.hash(dto.password, 10);

    // Create company + user in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const company = await tx.company.create({
        data: {
          name: dto.companyName,
          type: dto.companyType as any,
        },
      });

      const user = await tx.user.create({
        data: {
          email: dto.email,
          passwordHash: hash,
          name: dto.name,
          role: (dto.role as any) || 'admin',
          companyId: company.id,
        },
        include: { company: { select: { id: true, name: true, type: true } } },
      });

      return user;
    });

    const token = await this.signToken(result);

    return {
      access_token: token,
      user: {
        id: result.id,
        name: result.name,
        email: result.email,
        role: result.role,
        company: result.company,
      },
    };
  }

  private async signToken(user: any): Promise<string> {
    // Minimal payload — fetch full data from DB when needed
    return this.jwt.signAsync({
      sub: user.id,
      role: user.role,
      companyId: user.companyId || user.company?.id,
      companyType: user.company?.type,
    });
  }
}
