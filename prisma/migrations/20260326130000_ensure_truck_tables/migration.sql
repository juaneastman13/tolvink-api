-- Ensure truck_documents and truck_expenses tables exist
-- This is a safety migration in case the previous one was marked as applied but tables weren't created

DO $$ BEGIN CREATE TYPE "TruckDocumentType" AS ENUM ('VTV_ITV', 'INSURANCE', 'TRANSPORT_LICENSE', 'GREEN_CARD', 'DRIVER_LICENSE', 'RUAT', 'SENASA', 'FUMIGATION', 'OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN CREATE TYPE "TruckExpenseType" AS ENUM ('FUEL', 'TOLL', 'MAINTENANCE', 'TIRE', 'INSURANCE', 'FINE', 'PARKING', 'MEAL', 'OTHER'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "truck_documents" (
    "id" TEXT NOT NULL,
    "truck_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "type" "TruckDocumentType" NOT NULL,
    "name" VARCHAR(255),
    "file_url" VARCHAR(500) NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(100),
    "issued_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "notes" TEXT,
    "uploaded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "truck_documents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "truck_expenses" (
    "id" TEXT NOT NULL,
    "truck_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "freight_id" TEXT,
    "type" "TruckExpenseType" NOT NULL,
    "description" VARCHAR(500),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'UYU',
    "date" TIMESTAMP(3) NOT NULL,
    "receipt_url" VARCHAR(500),
    "receipt_name" VARCHAR(255),
    "created_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "truck_expenses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "truck_documents_truck_id_company_id_idx" ON "truck_documents"("truck_id", "company_id");
CREATE INDEX IF NOT EXISTS "truck_documents_expires_at_idx" ON "truck_documents"("expires_at");
CREATE INDEX IF NOT EXISTS "truck_expenses_truck_id_company_id_idx" ON "truck_expenses"("truck_id", "company_id");
CREATE INDEX IF NOT EXISTS "truck_expenses_date_idx" ON "truck_expenses"("date");

DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "trucks"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_expenses" ADD CONSTRAINT "truck_expenses_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
