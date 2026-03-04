import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sentry = require('@sentry/node');

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Error interno del servidor';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : (body as any).message || message;
      // Report 5xx HttpExceptions to Sentry
      if (status >= 500 && process.env.SENTRY_DSN) {
        Sentry.captureException(exception, {
          extra: { url: req.url, method: req.method, userId: (req as any).user?.sub },
        });
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled: ${exception.message}`, exception.stack);
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(exception, {
          extra: { url: req.url, method: req.method, userId: (req as any).user?.sub },
        });
      }
    } else {
      // Handle non-Error thrown values (strings, plain objects, etc.)
      const desc = typeof exception === 'string' ? exception : JSON.stringify(exception);
      this.logger.error(`Unhandled non-Error: ${desc}`);
      if (process.env.SENTRY_DSN) {
        Sentry.captureMessage(`Non-Error thrown: ${desc}`, {
          level: 'error',
          extra: { url: req.url, method: req.method, userId: (req as any).user?.sub },
        });
      }
    }

    // For 500 errors, return generic message in production (don't leak internals)
    const safeMessage = status >= 500 && process.env.NODE_ENV !== 'development'
      ? 'Error interno del servidor'
      : message;

    res.status(status).json({
      statusCode: status,
      message: safeMessage,
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
