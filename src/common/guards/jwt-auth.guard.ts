import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Token requerido');
    }

    try {
      const payload = await this.jwt.verifyAsync(token, { algorithms: ['HS256'] });
      // Reject special-purpose tokens (e.g. password-reset) — only normal access tokens allowed
      if (payload.purpose) {
        throw new UnauthorizedException('Token inválido o expirado');
      }
      (request as any)['user'] = payload;
      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.warn(`JWT verification failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  private extractToken(request: Request): string | null {
    // 1. Authorization header (Swagger, testing, backward compat)
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.split(' ')[1];
    // 2. HttpOnly cookie fallback
    return (request as any).cookies?.accessToken || null;
  }
}
