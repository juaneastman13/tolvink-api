import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';

// Short-lived in-memory cache for user active/role checks (avoids DB hit per request)
const userActiveCache = new Map<string, { active: boolean; role: string; ts: number }>();
const USER_CACHE_TTL = 15_000; // 15 seconds
const CACHE_CLEANUP_INTERVAL = 5 * 60_000; // 5 minutes

// Periodic cleanup of expired cache entries
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of userActiveCache) {
    if (now - v.ts > USER_CACHE_TTL) userActiveCache.delete(k);
  }
}, CACHE_CLEANUP_INTERVAL).unref();

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(private jwt: JwtService, private prisma: PrismaService) {}

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

      // After JWT validation, verify user is still active (cached 30s to avoid per-request DB hit)
      const now = Date.now();
      const cached = userActiveCache.get(payload.sub);
      if (cached && now - cached.ts < USER_CACHE_TTL) {
        if (!cached.active) throw new UnauthorizedException('Usuario desactivado');
        (request as any).user = { ...(request as any).user, dbRole: cached.role };
      } else {
        const dbUser = await this.prisma.user.findUnique({
          where: { id: payload.sub },
          select: { active: true, role: true },
        });
        if (!dbUser || !dbUser.active) {
          userActiveCache.set(payload.sub, { active: false, role: '', ts: now });
          throw new UnauthorizedException('Usuario desactivado');
        }
        userActiveCache.set(payload.sub, { active: true, role: dbUser.role, ts: now });
        (request as any).user = { ...(request as any).user, dbRole: dbUser.role };
      }

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

// Export for cache invalidation (e.g., when deactivating a user)
export function invalidateUserActiveCache(userId: string) {
  userActiveCache.delete(userId);
}
