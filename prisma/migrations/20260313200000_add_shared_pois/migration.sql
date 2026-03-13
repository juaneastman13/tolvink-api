-- AlterTable: Add createdByUserId to pois
ALTER TABLE "pois" ADD COLUMN "created_by_user_id" TEXT;

-- CreateIndex
CREATE INDEX "pois_created_by_user_id_idx" ON "pois"("created_by_user_id");

-- AddForeignKey
ALTER TABLE "pois" ADD CONSTRAINT "pois_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: shared_pois
CREATE TABLE "shared_pois" (
    "id" TEXT NOT NULL,
    "poi_id" TEXT NOT NULL,
    "shared_by_user_id" TEXT NOT NULL,
    "shared_with_user_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_pois_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "shared_pois_shared_with_user_id_idx" ON "shared_pois"("shared_with_user_id");

-- CreateIndex
CREATE INDEX "shared_pois_poi_id_idx" ON "shared_pois"("poi_id");

-- CreateIndex (unique constraint)
CREATE UNIQUE INDEX "shared_pois_poi_id_shared_with_user_id_key" ON "shared_pois"("poi_id", "shared_with_user_id");

-- AddForeignKey
ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_poi_id_fkey" FOREIGN KEY ("poi_id") REFERENCES "pois"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
