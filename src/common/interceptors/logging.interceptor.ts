import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<any> {
    const req = ctx.switchToHttp().getRequest();
    const { method, url } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = ctx.switchToHttp().getResponse();
          this.logger.log(`${method} ${url} ${res.statusCode} ${Date.now() - start}ms`);
        },
        error: () => {
          this.logger.warn(`${method} ${url} ERR ${Date.now() - start}ms`);
        },
      }),
    );
  }
}
