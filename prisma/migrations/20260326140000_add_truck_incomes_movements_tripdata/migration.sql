-- Truck: add odometer fields
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "current_odometer" INTEGER;
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "last_odometer_date" TIMESTAMP(3);

-- FreightAssignment: add trip data fields
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "km_loaded" DECIMAL(10,1);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "km_empty" DECIMAL(10,1);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "km_total" DECIMAL(10,1);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "trip_departure_at" TIMESTAMP(3);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "trip_arrival_at" TIMESTAMP(3);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "loading_minutes" INTEGER;
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "unloading_minutes" INTEGER;
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "fuel_liters" DECIMAL(10,1);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "fuel_cost_per_liter" DECIMAL(8,2);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "toll_cost" DECIMAL(12,2);
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "odometer_start" INTEGER;
ALTER TABLE "freight_assignments" ADD COLUMN IF NOT EXISTS "odometer_end" INTEGER;

-- TruckIncome
DO $$ BEGIN CREATE TYPE "IncomeStatus" AS ENUM ('PENDING','PAID','OVERDUE'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "truck_incomes" (
    "id" TEXT NOT NULL,
    "truck_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "freight_id" TEXT,
    "concept" VARCHAR(500) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'UYU',
    "date" TIMESTAMP(3) NOT NULL,
    "invoice_number" VARCHAR(100),
    "invoice_url" VARCHAR(500),
    "status" "IncomeStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "truck_incomes_pkey" PRIMARY KEY ("id")
);

-- TruckMovement
DO $$ BEGIN CREATE TYPE "MovementType" AS ENUM ('REPOSITIONING','MAINTENANCE_TRIP','INTERNAL_TRANSFER','PERSONAL','OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "truck_movements" (
    "id" TEXT NOT NULL,
    "truck_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "type" "MovementType" NOT NULL,
    "description" VARCHAR(500),
    "origin_name" VARCHAR(255),
    "dest_name" VARCHAR(255),
    "departure_at" TIMESTAMP(3),
    "arrival_at" TIMESTAMP(3),
    "km_driven" DECIMAL(10,1),
    "fuel_liters" DECIMAL(10,1),
    "fuel_cost" DECIMAL(12,2),
    "toll_cost" DECIMAL(12,2),
    "notes" TEXT,
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "truck_movements_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX IF NOT EXISTS "truck_incomes_truck_id_company_id_idx" ON "truck_incomes"("truck_id","company_id");
CREATE INDEX IF NOT EXISTS "truck_incomes_truck_id_date_idx" ON "truck_incomes"("truck_id","date");
CREATE INDEX IF NOT EXISTS "truck_incomes_freight_id_idx" ON "truck_incomes"("freight_id");
CREATE INDEX IF NOT EXISTS "truck_movements_truck_id_company_id_idx" ON "truck_movements"("truck_id","company_id");
CREATE INDEX IF NOT EXISTS "truck_movements_truck_id_departure_at_idx" ON "truck_movements"("truck_id","departure_at");

-- Foreign keys
DO $$ BEGIN ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_incomes" ADD CONSTRAINT "truck_incomes_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_movements" ADD CONSTRAINT "truck_movements_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
