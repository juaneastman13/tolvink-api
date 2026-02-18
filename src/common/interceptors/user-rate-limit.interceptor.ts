import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpException } from '@nestjs/common';
import { Observable } from 'rxjs';

const LIMIT = 20;
const WINDOW_MS = 60000;

@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  private store = new Map<string, { count: number; resetAt: number }>();
  private lastCleanup = Date.now();

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const userId = req.user?.sub;
    if (!userId) return next.handle();

    const now = Date.now();

    // Periodic cleanup (every 5 min)
    if (now - this.lastCleanup > 300000) {
      for (const [k, v] of this.store) {
        if (now > v.resetAt) this.store.delete(k);
      }
      this.lastCleanup = now;
    }

    let entry = this.store.get(userId);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + WINDOW_MS };
      this.store.set(userId, entry);
    }
    entry.count++;

    if (entry.count > LIMIT) {
      throw new HttpException('Demasiadas solicitudes, intenta en un minuto', 429);
    }

    return next.handle();
  }
}
