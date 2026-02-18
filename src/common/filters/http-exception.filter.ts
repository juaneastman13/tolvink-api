import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import * as Sentry from '@sentry/node';

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
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled: ${exception.message}`, exception.stack);
      // Report unhandled errors to Sentry
      Sentry.captureException(exception, {
        extra: { url: req.url, method: req.method, userId: (req as any).user?.sub },
      });
    }

    // For 500 errors, return generic message in production (don't leak internals)
    const safeMessage = status >= 500 && process.env.NODE_ENV === 'production'
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
