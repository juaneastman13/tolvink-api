-- CreateTable: maintenance_records
CREATE TABLE IF NOT EXISTS "maintenance_records" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "horometer_reading" DOUBLE PRECISION,
    "odometer_reading" DOUBLE PRECISION,
    "description" TEXT NOT NULL,
    "parts_used" JSONB,
    "labor_cost" DOUBLE PRECISION,
    "total_cost" DOUBLE PRECISION,
    "workshop" TEXT,
    "mechanic" TEXT,
    "documents" JSONB,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable: maintenance_plans
CREATE TABLE IF NOT EXISTS "maintenance_plans" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "intervals" JSONB NOT NULL,
    "custom_intervals" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable: maintenance_alerts
CREATE TABLE IF NOT EXISTS "maintenance_alerts" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" VARCHAR(30) NOT NULL,
    "maintenance_type" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "message" TEXT NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'warning',
    "due_date" TIMESTAMP(3),
    "due_horometer" DOUBLE PRECISION,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "maintenance_alerts_pkey" PRIMARY KEY ("id")
);

-- Unique + Indexes
CREATE UNIQUE INDEX IF NOT EXISTS "maintenance_plans_machine_id_key" ON "maintenance_plans"("machine_id");
CREATE INDEX IF NOT EXISTS "maintenance_records_machine_id_idx" ON "maintenance_records"("machine_id");
CREATE INDEX IF NOT EXISTS "maintenance_records_company_id_idx" ON "maintenance_records"("company_id");
CREATE INDEX IF NOT EXISTS "maintenance_alerts_machine_id_idx" ON "maintenance_alerts"("machine_id");
CREATE INDEX IF NOT EXISTS "maintenance_alerts_company_id_status_idx" ON "maintenance_alerts"("company_id", "status");

-- Foreign keys
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "maintenance_plans" ADD CONSTRAINT "maintenance_plans_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "maintenance_alerts" ADD CONSTRAINT "maintenance_alerts_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
