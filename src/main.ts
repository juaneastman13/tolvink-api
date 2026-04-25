import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import * as compression from 'compression';
import * as cookieParser from 'cookie-parser';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bodyParser = require('body-parser');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sentry = require('@sentry/node');
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { UserRateLimitInterceptor } from './common/interceptors/user-rate-limit.interceptor';
import { DecimalTransformInterceptor } from './common/interceptors/decimal-transform.interceptor';
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
  if (!process.env.SENTRY_DSN && process.env.NODE_ENV === 'production') console.warn('[Tolvink] SENTRY_DSN not set — error tracking disabled in production');

  // Startup validation — server must not start without critical env vars
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

  logger.log('Creating Nest application');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false, // Disable built-in parser — we configure our own below
  });

  logger.log('Nest application created');

  // Security
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // NOTE: 'unsafe-inline' is required for styles because the React frontend
        // uses inline styles extensively (theme.jsx, component style props). Removing
        // it would break the app. Won't-fix unless migrating to CSS-in-JS with nonces.
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
    limit: '2mb',
    verify: (req: any, _res: any, buf: Buffer) => { req.rawBody = buf; },
  }));
  app.use(bodyParser.urlencoded({ limit: '2mb', extended: true }));

  // Cookie parser — for HttpOnly auth cookies
  app.use(cookieParser());

  // Request-scoped cache (AsyncLocalStorage) — must be before guards/interceptors
  app.use((req: any, res: any, next: any) => {
    requestCache.run(new Map(), () => next());
  });

  // Request timeout — 30s max per request (skip SSE streams)
  app.use((req: any, res: any, next: any) => {
    if (req.url?.startsWith('/api/sse/stream')) return next();
    res.setTimeout(30000, () => {
      if (!res.headersSent) {
        res.status(408).json({ message: 'Request timeout' });
      }
    });
    next();
  });

  // CORS — explicit whitelist only
  const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(s => s.trim()) || ['http://localhost:3000'];
  if (!process.env.CORS_ORIGIN) console.warn('[Tolvink] CORS_ORIGIN not set — using localhost fallback');
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cache-Control'],
    exposedHeaders: [],
    maxAge: 7200,
  });

  // CSRF protection — validate Origin/Referer on state-changing requests
  // Skip webhooks (Meta WhatsApp) and analytics (fire-and-forget)
  const csrfSkipPaths = ['/api/whatsapp/webhook', '/api/analytics/event'];
  const allowedOrigins = new Set(corsOrigins);
  app.use((req: any, res: any, next: any) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      if (csrfSkipPaths.some(p => req.url?.startsWith(p))) return next();
      const origin = req.headers['origin'];
      if (origin) {
        if (!allowedOrigins.has(origin)) {
          return res.status(403).json({ message: 'Origin not allowed' });
        }
      } else {
        // Fallback: check Referer when Origin is absent
        const referer = req.headers['referer'];
        if (referer) {
          try {
            const refOrigin = new URL(referer).origin;
            if (!allowedOrigins.has(refOrigin)) {
              return res.status(403).json({ message: 'Origin not allowed' });
            }
          } catch {
            return res.status(403).json({ message: 'Invalid Referer' });
          }
        } else {
          // No Origin and no Referer — allow if using Bearer auth (non-browser client)
          const authHeader = req.headers['authorization'];
          if (!authHeader?.startsWith('Bearer ')) {
            return res.status(403).json({ message: 'Origin header required' });
          }
        }
      }
    }
    next();
  });

  // Global prefix
  app.setGlobalPrefix('api');

  // Global exception filter + request logging
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new UserRateLimitInterceptor(), new DecimalTransformInterceptor());

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
  logger.log(`Starting HTTP listener on 0.0.0.0:${port}`);
  await app.listen(port, '0.0.0.0');
  logger.log(`Tolvink API running on port ${port}`);
}

bootstrap();
