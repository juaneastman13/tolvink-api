CREATE TABLE IF NOT EXISTS "verified_parts" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "part_number" VARCHAR(50) NOT NULL,
    "brand" VARCHAR(100) NOT NULL,
    "description" TEXT NOT NULL,
    "category" VARCHAR(50),
    "machine_models" JSONB,
    "source" VARCHAR(100) NOT NULL,
    "source_url" TEXT,
    "diagram_url" TEXT,
    "cross_references" JSONB,
    "last_known_price" TEXT,
    "price_currency" VARCHAR(10) DEFAULT 'USD',
    "price_date" TIMESTAMP(3),
    "verified_by_user" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "times_used" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "verified_parts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "verified_parts_part_number_brand_key" ON "verified_parts"("part_number", "brand");
CREATE INDEX IF NOT EXISTS "verified_parts_brand_category_idx" ON "verified_parts"("brand", "category");
