import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = process.env.DATABASE_URL || '';
    const sep = url.includes('?') ? '&' : '?';
    const params: string[] = [];
    if (!url.includes('connection_limit')) params.push('connection_limit=10');
    if (!url.includes('pool_timeout')) params.push('pool_timeout=10');
    if (!url.includes('pgbouncer')) params.push('pgbouncer=true');
    const poolUrl = params.length > 0 ? `${url}${sep}${params.join('&')}` : url;
    super({
      datasources: { db: { url: poolUrl } },
      log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.connectWithRetry();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Ping DB to verify connection — used by health check */
  async ping(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  private async connectWithRetry(maxRetries = 5): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.$connect();
        this.logger.log('Database connected');
        return;
      } catch (err) {
        this.logger.error(`DB connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt === maxRetries) {
          this.logger.error('All DB connection attempts exhausted — exiting');
          throw err;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}
