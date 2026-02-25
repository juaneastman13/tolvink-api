import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = process.env.DATABASE_URL || '';
    const sep = url.includes('?') ? '&' : '?';
    const params: string[] = [];
    if (!url.includes('connection_limit')) params.push('connection_limit=5');
    if (!url.includes('pool_timeout')) params.push('pool_timeout=10');
    if (!url.includes('pgbouncer')) params.push('pgbouncer=true');
    const poolUrl = params.length > 0 ? `${url}${sep}${params.join('&')}` : url;
    super({
      datasources: { db: { url: poolUrl } },
      log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
