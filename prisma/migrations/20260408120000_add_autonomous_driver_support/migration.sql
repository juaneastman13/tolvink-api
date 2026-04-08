-- AlterTable: Add autonomous driver support to companies
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "autonomous_driver_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add autonomous freight fields
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "is_autonomous" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "origin_free_text" TEXT;
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "destination_free_text" TEXT;
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "arrived_at_plant_at" TIMESTAMP(3);
