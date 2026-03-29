-- Add external truck fields to freight_assignments
ALTER TABLE "freight_assignments" ADD COLUMN "is_external" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "freight_assignments" ADD COLUMN "external_company_name" VARCHAR(255);
ALTER TABLE "freight_assignments" ADD COLUMN "external_driver_name" VARCHAR(255);
