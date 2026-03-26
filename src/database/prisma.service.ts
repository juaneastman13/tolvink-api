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
    await this.ensureTruckTables();
    await this.ensureTruckEconomicTables();
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

  /** Create truck_documents and truck_expenses tables if they don't exist */
  private async ensureTruckTables(): Promise<void> {
    try {
      await this.$executeRawUnsafe(`DO $$ BEGIN CREATE TYPE "TruckDocumentType" AS ENUM ('VTV_ITV','INSURANCE','TRANSPORT_LICENSE','GREEN_CARD','DRIVER_LICENSE','RUAT','SENASA','FUMIGATION','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
      // Add new enum values (idempotent)
      for (const v of ['BPS_DGI','GET_CERTIFICATE','CIRCULATION_PERMIT']) {
        await this.$executeRawUnsafe(`ALTER TYPE "TruckDocumentType" ADD VALUE IF NOT EXISTS '${v}'`).catch(() => {});
      }
      await this.$executeRawUnsafe(`DO $$ BEGIN CREATE TYPE "TruckExpenseType" AS ENUM ('FUEL','TOLL','MAINTENANCE','TIRE','INSURANCE','FINE','PARKING','MEAL','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await this.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "truck_documents" ("id" TEXT NOT NULL,"truck_id" TEXT NOT NULL,"company_id" TEXT NOT NULL,"type" "TruckDocumentType" NOT NULL,"name" VARCHAR(255),"file_url" VARCHAR(500) NOT NULL,"file_name" VARCHAR(255) NOT NULL,"mime_type" VARCHAR(100),"issued_at" TIMESTAMP(3),"expires_at" TIMESTAMP(3),"notes" TEXT,"uploaded_by_id" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,CONSTRAINT "truck_documents_pkey" PRIMARY KEY ("id"))`);
      await this.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "truck_expenses" ("id" TEXT NOT NULL,"truck_id" TEXT NOT NULL,"company_id" TEXT NOT NULL,"freight_id" TEXT,"type" "TruckExpenseType" NOT NULL,"description" VARCHAR(500),"amount" DECIMAL(12,2) NOT NULL,"currency" VARCHAR(3) NOT NULL DEFAULT 'UYU',"date" TIMESTAMP(3) NOT NULL,"receipt_url" VARCHAR(500),"receipt_name" VARCHAR(255),"created_by_id" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,CONSTRAINT "truck_expenses_pkey" PRIMARY KEY ("id"))`);
      await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "truck_documents_truck_id_company_id_idx" ON "truck_documents"("truck_id","company_id")`);
      await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "truck_documents_expires_at_idx" ON "truck_documents"("expires_at")`);
      await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "truck_expenses_truck_id_company_id_idx" ON "truck_expenses"("truck_id","company_id")`);
      await this.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "truck_expenses_date_idx" ON "truck_expenses"("date")`);
      // Foreign keys
      for (const fk of [
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
        `ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      ]) {
        await this.$executeRawUnsafe(`DO $$ BEGIN ${fk}; EXCEPTION WHEN duplicate_object THEN null; END $$`).catch(() => {});
      }
      this.logger.log('ensureTruckTables: truck_documents + truck_expenses ready');
    } catch (err) {
      this.logger.warn('ensureTruckTables failed: ' + err.message);
    }
  }

  /** Create truck_incomes, truck_movements tables + trip data columns on freight_assignments */
  private async ensureTruckEconomicTables(): Promise<void> {
    try {
      // Enums
      await this.$executeRawUnsafe(`DO $$ BEGIN CREATE TYPE "IncomeStatus" AS ENUM ('PENDING','PAID','OVERDUE'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
      await this.$executeRawUnsafe(`DO $$ BEGIN CREATE TYPE "MovementType" AS ENUM ('REPOSITIONING','MAINTENANCE_TRIP','INTERNAL_TRANSFER','PERSONAL','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$`);
      // Truck odometer
      await this.$executeRawUnsafe(`ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "current_odometer" INTEGER`);
      await this.$executeRawUnsafe(`ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "last_odometer_date" TIMESTAMP(3)`);
      // FreightAssignment trip data
      for (const col of [
        `"km_loaded" DECIMAL(10,1)`, `"km_empty" DECIMAL(10,1)`, `"km_total" DECIMAL(10,1)`,
        `"trip_departure_at" TIMESTAMP(3)`, `"trip_arrival_at" TIMESTAMP(3)`,
        `"loading_minutes" INTEGER`, `"unloading_minutes" INTEGER`,
        `"fuel_liters" DECIMAL(10,1)`, `"fuel_cost_per_liter" DECIMAL(8,2)`, `"toll_cost" DECIMAL(12,2)`,
        `"odometer_start" INTEGER`, `"odometer_end" INTEGER`,
      ]) {
        await this.$executeRawUnsafe(`ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
      }
      // Tables
      await this.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "truck_incomes" ("id" TEXT NOT NULL,"truck_id" TEXT NOT NULL,"company_id" TEXT NOT NULL,"freight_id" TEXT,"concept" VARCHAR(500) NOT NULL,"amount" DECIMAL(12,2) NOT NULL,"currency" VARCHAR(3) NOT NULL DEFAULT 'UYU',"date" TIMESTAMP(3) NOT NULL,"invoice_number" VARCHAR(100),"invoice_url" VARCHAR(500),"status" "IncomeStatus" NOT NULL DEFAULT 'PENDING',"notes" TEXT,"created_by_id" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,CONSTRAINT "truck_incomes_pkey" PRIMARY KEY ("id"))`);
      await this.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "truck_movements" ("id" TEXT NOT NULL,"truck_id" TEXT NOT NULL,"company_id" TEXT NOT NULL,"driver_id" TEXT,"type" "MovementType" NOT NULL,"description" VARCHAR(500),"origin_name" VARCHAR(255),"dest_name" VARCHAR(255),"departure_at" TIMESTAMP(3),"arrival_at" TIMESTAMP(3),"km_driven" DECIMAL(10,1),"fuel_liters" DECIMAL(10,1),"fuel_cost" DECIMAL(12,2),"toll_cost" DECIMAL(12,2),"notes" TEXT,"created_by_id" TEXT NOT NULL,"created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updated_at" TIMESTAMP(3) NOT NULL,CONSTRAINT "truck_movements_pkey" PRIMARY KEY ("id"))`);
      // Indexes
      for (const idx of [
        `CREATE INDEX IF NOT EXISTS "truck_incomes_truck_id_company_id_idx" ON "truck_incomes"("truck_id","company_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_incomes_truck_id_date_idx" ON "truck_incomes"("truck_id","date")`,
        `CREATE INDEX IF NOT EXISTS "truck_incomes_freight_id_idx" ON "truck_incomes"("freight_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_movements_truck_id_company_id_idx" ON "truck_movements"("truck_id","company_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_movements_truck_id_departure_at_idx" ON "truck_movements"("truck_id","departure_at")`,
      ]) { await this.$executeRawUnsafe(idx).catch(() => {}); }
      // Foreign keys
      for (const fk of [
        `ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
        `ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE`,
        `ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE`,
      ]) { await this.$executeRawUnsafe(`DO $$ BEGIN ${fk}; EXCEPTION WHEN duplicate_object THEN null; END $$`).catch(() => {}); }
      // TruckDocument cross-linking columns
      for (const col of [`"expense_id" TEXT`, `"income_id" TEXT`, `"freight_id" TEXT`, `"movement_id" TEXT`]) {
        await this.$executeRawUnsafe(`ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
      }
      for (const idx of [
        `CREATE INDEX IF NOT EXISTS "truck_documents_expense_id_idx" ON "truck_documents"("expense_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_documents_income_id_idx" ON "truck_documents"("income_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_documents_freight_id_idx" ON "truck_documents"("freight_id")`,
        `CREATE INDEX IF NOT EXISTS "truck_documents_movement_id_idx" ON "truck_documents"("movement_id")`,
      ]) { await this.$executeRawUnsafe(idx).catch(() => {}); }
      for (const fk of [
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "truck_expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_income_id_fkey" FOREIGN KEY ("income_id") REFERENCES "truck_incomes"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
        `ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "truck_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE`,
      ]) { await this.$executeRawUnsafe(`DO $$ BEGIN ${fk}; EXCEPTION WHEN duplicate_object THEN null; END $$`).catch(() => {}); }
      // TruckMovement location columns
      for (const col of [`"origin_lat" DECIMAL(10,6)`, `"origin_lng" DECIMAL(10,6)`, `"origin_field_id" TEXT`, `"origin_lot_id" TEXT`, `"dest_lat" DECIMAL(10,6)`, `"dest_lng" DECIMAL(10,6)`, `"dest_field_id" TEXT`, `"dest_lot_id" TEXT`]) {
        await this.$executeRawUnsafe(`ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS ${col}`).catch(() => {});
      }
      this.logger.log('ensureTruckEconomicTables: truck_incomes + truck_movements + trip data + cross-links ready');
    } catch (err) {
      this.logger.warn('ensureTruckEconomicTables failed: ' + err.message);
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
