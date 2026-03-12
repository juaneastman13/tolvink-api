-- CreateTable
CREATE TABLE "pois" (
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
CREATE INDEX "pois_company_id_idx" ON "pois"("company_id");

-- AddForeignKey
ALTER TABLE "pois" ADD CONSTRAINT "pois_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
