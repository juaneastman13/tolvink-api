import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { randomUUID } from 'crypto';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const { method, url } = req;
    const traceId = randomUUID().slice(0, 8);
    const userId = req.user?.sub || '-';
    const start = Date.now();

    // Attach traceId for downstream use
    req.traceId = traceId;

    return next.handle().pipe(
      tap({
        next: () => {
          const res = ctx.switchToHttp().getResponse();
          const ms = Date.now() - start;
          this.logger.log(JSON.stringify({ traceId, userId, method, url, status: res.statusCode, ms }));
        },
        error: (err) => {
          const ms = Date.now() - start;
          const status = err?.status || err?.getStatus?.() || 500;
          this.logger.warn(JSON.stringify({ traceId, userId, method, url, status, ms, error: err?.message }));
        },
      }),
    );
  }
}
