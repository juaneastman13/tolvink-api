import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    const url = process.env.DATABASE_URL || '';
    const sep = url.includes('?') ? '&' : '?';
    const params: string[] = [];
    if (!url.includes('connection_limit')) params.push('connection_limit=20');
    if (!url.includes('pool_timeout')) params.push('pool_timeout=30');
    if (!url.includes('pgbouncer')) params.push('pgbouncer=true');
    const poolUrl = params.length > 0 ? `${url}${sep}${params.join('&')}` : url;
    super({
      datasources: { db: { url: poolUrl } },
      log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
    });
  }

  async onModuleInit() {
    await this.connectWithRetry();
    await this.ensurePoisTable();
    await this.ensureFreightItemTonsNullable();
  }

  /** Create pois table if it doesn't exist — fallback for when prisma migrate deploy doesn't run */
  private async ensurePoisTable(): Promise<void> {
    try {
      await this.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "pois" (
          "id" TEXT NOT NULL,
          "name" VARCHAR(255) NOT NULL,
          "company_id" TEXT NOT NULL,
          "address" TEXT,
          "lat" DECIMAL(10,6) NOT NULL,
          "lng" DECIMAL(10,6) NOT NULL,
          "comments" TEXT,
          "active" BOOLEAN NOT NULL DEFAULT true,
          "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "updated_at" TIMESTAMP(3) NOT NULL,
          CONSTRAINT "pois_pkey" PRIMARY KEY ("id")
        )
      `);
      await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "pois_company_id_idx" ON "pois"("company_id")`);
      await this.$executeRawUnsafe(`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pois_company_id_fkey') THEN
            ALTER TABLE "pois" ADD CONSTRAINT "pois_company_id_fkey"
              FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
          END IF;
        END $$
      `);
      this.logger.log('ensurePoisTable: pois table ready');
    } catch (err) {
      this.logger.warn('ensurePoisTable failed: ' + err.message);
    }
  }

  private async ensureFreightItemTonsNullable(): Promise<void> {
    try {
      const [col] = await this.$queryRaw<any[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'freight_items' AND column_name = 'tons'
      `;
      if (col && col.is_nullable === 'NO') {
        await this.$executeRaw`ALTER TABLE "freight_items" ALTER COLUMN "tons" DROP NOT NULL`;
        this.logger.log('ensureFreightItemTonsNullable: tons column made nullable');
      }
    } catch (err) {
      this.logger.warn('ensureFreightItemTonsNullable failed: ' + err.message);
    }
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
