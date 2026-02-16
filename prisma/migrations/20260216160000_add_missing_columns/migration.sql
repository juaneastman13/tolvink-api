-- AddColumns to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "user_types" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "company_by_type" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "role_by_type" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "is_super_admin" BOOLEAN NOT NULL DEFAULT false;

-- AddUniqueIndex on users.phone
CREATE UNIQUE INDEX IF NOT EXISTS "users_phone_key" ON "users"("phone");
CREATE INDEX IF NOT EXISTS "users_phone_idx" ON "users"("phone");

-- AddColumns to companies
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "rut" VARCHAR(20);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "has_internal_fleet" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "lat" DECIMAL(10,6);
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "lng" DECIMAL(10,6);

-- AddColumns to fields
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "hectares" DECIMAL(10,2);
ALTER TABLE "fields" ADD COLUMN IF NOT EXISTS "comments" TEXT;

-- AddColumns to lots
ALTER TABLE "lots" ADD COLUMN IF NOT EXISTS "comments" TEXT;

-- AddColumns to trucks
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "brand" VARCHAR(100);
ALTER TABLE "trucks" ADD COLUMN IF NOT EXISTS "capacity" VARCHAR(50);

-- AddColumn to freights
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "field_id" TEXT;
CREATE INDEX IF NOT EXISTS "freights_field_id_idx" ON "freights"("field_id");
ALTER TABLE "freights" ADD CONSTRAINT "freights_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddColumn to freight_tracking
ALTER TABLE "freight_tracking" ADD COLUMN IF NOT EXISTS "user_id" TEXT;
