-- CreateTable: master directory of external grain plants
CREATE TABLE IF NOT EXISTS "tolvink_plants" (
    "id" TEXT NOT NULL,
    "source_row_id" INTEGER,
    "source_plant_id" INTEGER,
    "name" VARCHAR(255) NOT NULL,
    "alt_name" VARCHAR(255),
    "department" VARCHAR(100),
    "lat" DECIMAL(10,6),
    "lng" DECIMAL(10,6),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tolvink_plants_pkey" PRIMARY KEY ("id")
);

-- AlterTable: allow freights to reference the Tolvink master directory
ALTER TABLE "freights" ADD COLUMN IF NOT EXISTS "tolvink_plant_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tolvink_plants_source_row_id_key" ON "tolvink_plants"("source_row_id");
CREATE UNIQUE INDEX IF NOT EXISTS "tolvink_plants_source_plant_id_key" ON "tolvink_plants"("source_plant_id");
CREATE INDEX IF NOT EXISTS "tolvink_plants_name_idx" ON "tolvink_plants"("name");
CREATE INDEX IF NOT EXISTS "tolvink_plants_department_idx" ON "tolvink_plants"("department");
CREATE INDEX IF NOT EXISTS "freights_tolvink_plant_id_idx" ON "freights"("tolvink_plant_id");
CREATE INDEX IF NOT EXISTS "freights_dest_plant_id_idx" ON "freights"("dest_plant_id");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'freights_tolvink_plant_id_fkey'
    ) THEN
        ALTER TABLE "freights"
        ADD CONSTRAINT "freights_tolvink_plant_id_fkey"
        FOREIGN KEY ("tolvink_plant_id") REFERENCES "tolvink_plants"("id")
        ON DELETE SET NULL
        ON UPDATE CASCADE;
    END IF;
END $$;
