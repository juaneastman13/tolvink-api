-- AlterTable: add nearest locality to Tolvink plants directory
ALTER TABLE "tolvink_plants"
ADD COLUMN IF NOT EXISTS "locality" VARCHAR(150);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "tolvink_plants_locality_idx" ON "tolvink_plants"("locality");
