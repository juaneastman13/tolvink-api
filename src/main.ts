import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyParser = require('body-parser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sentry = require('@sentry/node');
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { UserRateLimitInterceptor } from './common/interceptors/user-rate-limit.interceptor';
import { requestCache } from './common/request-cache';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Initialize Sentry error tracking
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV || 'development',
      tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_RATE || '0.2'),
    });
    logger.log('Sentry initialized');
  }

  // Validate critical env vars at startup
  const required = ['DATABASE_URL', 'DIRECT_URL', 'JWT_SECRET', 'WHATSAPP_APP_SECRET'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  // Process-level error handlers — log, report to Sentry, then exit so Railway restarts
  let _exiting = false;
  process.on('uncaughtException', (err) => {
    if (_exiting) return;
    _exiting = true;
    logger.error(`Uncaught exception: ${err.message}`, err.stack);
    if (process.env.SENTRY_DSN) Sentry.captureException(err);
    const flushP = process.env.SENTRY_DSN ? Sentry.flush(2000) : Promise.resolve();
    flushP.catch(() => {}).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason: any) => {
    if (_exiting) return;
    _exiting = true;
    logger.error(`Unhandled rejection: ${reason?.message || reason}`, reason?.stack);
    if (process.env.SENTRY_DSN && reason instanceof Error) Sentry.captureException(reason);
    const flushP = process.env.SENTRY_DSN ? Sentry.flush(2000) : Promise.resolve();
    flushP.catch(() => {}).finally(() => process.exit(1));
  });

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false, // Disable built-in parser — we configure our own below
  });

  // Security
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://maps.googleapis.com', 'https://maps.gstatic.com'],
        connectSrc: ["'self'", 'https://mlmecljidioymujsazrs.supabase.co', 'https://maps.googleapis.com', 'https://graph.facebook.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }));

  // Gzip compression — ~60-70% bandwidth reduction on JSON responses
  app.use(compression());

  // Body parsing with raw body capture for WhatsApp HMAC-SHA256 verification
  app.use(bodyParser.json({
    limit: '10mb',
    verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; },
  }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  // Request-scoped cache (AsyncLocalStorage) — must be before guards/interceptors
  app.use((req: any, res: any, next: any) => {
    requestCache.run(new Map(), () => next());
  });

  // Request timeout — 30s max per request (skip SSE streams)
  app.use((req: any, res: any, next: any) => {
    if (req.url?.includes('/sse/stream')) return next();
    res.setTimeout(30000, () => {
      if (!res.headersSent) {
        res.status(408).json({ message: 'Request timeout' });
      }
    });
    next();
  });

  // CORS — explicit whitelist only
  const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) || ['http://localhost:3000'];
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
    exposedHeaders: [],
    maxAge: 86400,
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Global exception filter + request logging
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new UserRateLimitInterceptor());

  // Validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));

  // Swagger — only in development
  if (process.env.NODE_ENV === 'development') {
    const config = new DocumentBuilder()
      .setTitle('Tolvink API')
      .setDescription('API de gestión de fletes de granos')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const doc = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, doc);
    logger.log('Swagger enabled at /docs');
  }

  // Graceful shutdown (Prisma disconnect, etc.)
  app.enableShutdownHooks();

  // Railway requires binding to 0.0.0.0
  const port = process.env.PORT || 4000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Tolvink API running on port ${port}`);
}

bootstrap();
