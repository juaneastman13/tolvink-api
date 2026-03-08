import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { Observable } from 'rxjs';

const LIMIT_AUTH = 500;      // authenticated users: 500 req/min
const LIMIT_ANON = 100;      // unauthenticated (IP-based): 100 req/min
const WINDOW_MS = 60000;

/**
 * SCALING NOTE: In-memory store. Limits are per-instance, not global.
 * For multi-instance deployments, replace with Redis-based rate limiting.
 */
@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  private store = new Map<string, { count: number; resetAt: number }>();
  private lastCleanup = Date.now();

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.sub;
    // Fall back to IP-based rate limiting for unauthenticated requests
    const key = userId || `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const limit = userId ? LIMIT_AUTH : LIMIT_ANON;

    const now = Date.now();

    // Periodic cleanup (every 5 min) + hard cap at 10k entries
    if (now - this.lastCleanup > 300000 || this.store.size > 10_000) {
      for (const [k, v] of this.store) {
        if (now > v.resetAt) this.store.delete(k);
      }
      if (this.store.size > 10_000) {
        const iter = this.store.keys();
        while (this.store.size > 8_000) {
          const k = iter.next().value;
          if (k) this.store.delete(k); else break;
        }
      }
      this.lastCleanup = now;
    }

    let entry = this.store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.store.set(key, entry);
    }
    entry.count++;

    if (entry.count > limit) {
      throw new HttpException('Demasiadas solicitudes, intenta en un minuto', 429);
    }

    return next.handle();
  }
}
