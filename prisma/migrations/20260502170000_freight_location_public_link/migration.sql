-- Public link support for freight_locations: no-user submissions

ALTER TABLE "freight_locations" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "freight_locations" ALTER COLUMN "user_name" DROP NOT NULL;
ALTER TABLE "freight_locations" ALTER COLUMN "company_id" DROP NOT NULL;
ALTER TABLE "freight_locations" ALTER COLUMN "company_name" DROP NOT NULL;

ALTER TYPE "FreightLocationSource" ADD VALUE IF NOT EXISTS 'PUBLIC_LINK';
