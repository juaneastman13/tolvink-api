-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "pois" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "company_id" TEXT NOT NULL,
    "address" TEXT,
    "lat" DECIMAL(10,6) NOT NULL,
    "lng" DECIMAL(10,6) NOT NULL,
    "comments" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pois_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "pois_company_id_idx" ON "pois"("company_id");

-- AddForeignKey (ignore if exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'pois_company_id_fkey'
    ) THEN
        ALTER TABLE "pois" ADD CONSTRAINT "pois_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
