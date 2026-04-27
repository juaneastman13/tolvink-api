-- Freight map operational locations

CREATE TYPE "FreightLocationType" AS ENUM (
  'ORIGIN',
  'DESTINATION',
  'POINT_OF_INTEREST',
  'LOAD_LOCATION',
  'UNLOAD_LOCATION',
  'OPERATIONAL_REFERENCE',
  'OTHER'
);

CREATE TYPE "FreightLocationStatus" AS ENUM (
  'ACTIVE',
  'REPLACED',
  'DELETED',
  'HISTORICAL'
);

CREATE TYPE "FreightLocationSource" AS ENUM (
  'WEB_APP',
  'SHARED_LINK',
  'WHATSAPP_AGENT'
);

CREATE TYPE "FreightLocationInputMethod" AS ENUM (
  'BROWSER_CURRENT',
  'PIN_MANUAL',
  'SEARCH',
  'WHATSAPP_NATIVE',
  'UNKNOWN'
);

CREATE TABLE "freight_locations" (
  "id" TEXT NOT NULL,
  "freight_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "user_name" VARCHAR(255) NOT NULL,
  "company_id" TEXT NOT NULL,
  "company_name" VARCHAR(255) NOT NULL,
  "actor_role" VARCHAR(50) NOT NULL,
  "type" "FreightLocationType" NOT NULL,
  "lat" DECIMAL(10,6) NOT NULL,
  "lng" DECIMAL(10,6) NOT NULL,
  "label" VARCHAR(255),
  "address" VARCHAR(500),
  "description" TEXT,
  "source" "FreightLocationSource" NOT NULL,
  "input_method" "FreightLocationInputMethod" NOT NULL DEFAULT 'UNKNOWN',
  "status" "FreightLocationStatus" NOT NULL DEFAULT 'ACTIVE',
  "replaced_by_id" TEXT,
  "deleted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "freight_locations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "freight_locations_freight_id_status_idx" ON "freight_locations"("freight_id", "status");
CREATE INDEX "freight_locations_freight_id_type_status_idx" ON "freight_locations"("freight_id", "type", "status");
CREATE INDEX "freight_locations_company_id_created_at_idx" ON "freight_locations"("company_id", "created_at");
CREATE INDEX "freight_locations_user_id_created_at_idx" ON "freight_locations"("user_id", "created_at");
CREATE INDEX "freight_locations_created_at_idx" ON "freight_locations"("created_at");

ALTER TABLE "freight_locations"
  ADD CONSTRAINT "freight_locations_freight_id_fkey"
  FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "freight_locations"
  ADD CONSTRAINT "freight_locations_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "freight_locations"
  ADD CONSTRAINT "freight_locations_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "freight_locations"
  ADD CONSTRAINT "freight_locations_replaced_by_id_fkey"
  FOREIGN KEY ("replaced_by_id") REFERENCES "freight_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
