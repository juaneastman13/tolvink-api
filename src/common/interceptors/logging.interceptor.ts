import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

const IS_PROD = process.env.NODE_ENV === 'production';
let _reqCount = 0;

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const { method, url } = req;
    const userId = req.user?.sub || '-';
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - start;
          // Production: log slow requests (>500ms) + sample 10%; avoid JSON.stringify overhead
          if (IS_PROD) {
            _reqCount++;
            if (ms > 500 || _reqCount % 10 === 0) {
              this.logger.log(`${method} ${url} ${ctx.switchToHttp().getResponse().statusCode} ${ms}ms uid=${userId}`);
            }
          } else {
            this.logger.log(`${method} ${url} ${ctx.switchToHttp().getResponse().statusCode} ${ms}ms uid=${userId}`);
          }
        },
        error: (err) => {
          const ms = Date.now() - start;
          const status = err?.status || err?.getStatus?.() || 500;
          this.logger.warn(`${method} ${url} ${status} ${ms}ms uid=${userId} err=${err?.message}`);
        },
      }),
    );
  }
}
