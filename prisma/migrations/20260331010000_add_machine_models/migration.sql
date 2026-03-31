-- CreateTable: machine_templates
CREATE TABLE IF NOT EXISTS "machine_templates" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "brand" VARCHAR(100) NOT NULL,
    "series" VARCHAR(100),
    "model" VARCHAR(100) NOT NULL,
    "machine_type" VARCHAR(50) NOT NULL,
    "engine_brand" VARCHAR(100),
    "engine_model" VARCHAR(100),
    "engine_power" VARCHAR(50),
    "engine_displacement" VARCHAR(50),
    "transmission_type" VARCHAR(100),
    "fuel_type" VARCHAR(50),
    "hydraulic_system" VARCHAR(100),
    "maintenance_intervals" JSONB,
    "specs" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "machine_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable: machines
CREATE TABLE IF NOT EXISTS "machines" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "company_id" TEXT NOT NULL,
    "template_id" TEXT,
    "machine_type" VARCHAR(50) NOT NULL,
    "brand" VARCHAR(100) NOT NULL,
    "model" VARCHAR(100) NOT NULL,
    "year" INTEGER,
    "serial_number" VARCHAR(100) NOT NULL,
    "engine_brand" VARCHAR(100),
    "engine_model" VARCHAR(100),
    "engine_power" VARCHAR(50),
    "engine_displacement" VARCHAR(50),
    "transmission_type" VARCHAR(100),
    "fuel_type" VARCHAR(50),
    "hydraulic_system" VARCHAR(100),
    "hydraulic_capacity" VARCHAR(50),
    "tire_size" VARCHAR(50),
    "tire_brand" VARCHAR(50),
    "current_horometer" DOUBLE PRECISION,
    "current_odometer" DOUBLE PRECISION,
    "qr_code" TEXT,
    "photos" JSONB,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "machines_pkey" PRIMARY KEY ("id")
);

-- CreateTable: machine_modifications
CREATE TABLE IF NOT EXISTS "machine_modifications" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "machine_modifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable: machine_repair_history
CREATE TABLE IF NOT EXISTS "machine_repair_history" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "workshop" TEXT,
    "cost" DOUBLE PRECISION,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "machine_repair_history_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX IF NOT EXISTS "machine_templates_brand_model_machine_type_key" ON "machine_templates"("brand", "model", "machine_type");
CREATE UNIQUE INDEX IF NOT EXISTS "machines_qr_code_key" ON "machines"("qr_code");
CREATE UNIQUE INDEX IF NOT EXISTS "machines_company_id_serial_number_key" ON "machines"("company_id", "serial_number");

-- Indexes
CREATE INDEX IF NOT EXISTS "machines_company_id_idx" ON "machines"("company_id");
CREATE INDEX IF NOT EXISTS "machine_modifications_machine_id_idx" ON "machine_modifications"("machine_id");
CREATE INDEX IF NOT EXISTS "machine_repair_history_machine_id_idx" ON "machine_repair_history"("machine_id");

-- Foreign keys
ALTER TABLE "machines" ADD CONSTRAINT "machines_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "machines" ADD CONSTRAINT "machines_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "machine_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "machine_modifications" ADD CONSTRAINT "machine_modifications_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "machine_repair_history" ADD CONSTRAINT "machine_repair_history_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
