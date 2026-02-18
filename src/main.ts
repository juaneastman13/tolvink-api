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
      tracesSampleRate: 0.1,
    });
    logger.log('Sentry initialized');
  }

  // Validate critical env vars at startup
  const required = ['DATABASE_URL', 'JWT_SECRET'];
  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  // Security
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true },
  }));

  // Gzip compression — ~60-70% bandwidth reduction on JSON responses
  app.use(compression());

  // Body size limits (prevent DoS with large payloads)
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ limit: '10mb', extended: true }));

  // Request-scoped cache (AsyncLocalStorage) — must be before guards/interceptors
  app.use((req: any, res: any, next: any) => {
    requestCache.run(new Map(), () => next());
  });

  // Request timeout — 30s max per request
  app.use((req: any, res: any, next: any) => {
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
