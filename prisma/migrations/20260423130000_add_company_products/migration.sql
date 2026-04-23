-- CreateTable: company_products
-- Each company maintains its own product/grain catalog.
-- Products are soft-deleted (is_active = false) to preserve freight history.
CREATE TABLE "company_products" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(20),
    "default_unit" VARCHAR(20),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_products_pkey" PRIMARY KEY ("id")
);

-- AlterTable: freight_items
-- Add nullable FK to catalog + widen grain column to 100 chars for custom product names
ALTER TABLE "freight_items" ADD COLUMN "company_product_id" TEXT;
ALTER TABLE "freight_items" ALTER COLUMN "grain" TYPE VARCHAR(100);

-- CreateIndex
CREATE INDEX "company_products_company_id_idx" ON "company_products"("company_id");
CREATE INDEX "company_products_company_id_is_active_idx" ON "company_products"("company_id", "is_active");
CREATE INDEX "freight_items_company_product_id_idx" ON "freight_items"("company_product_id");

-- AddForeignKey
ALTER TABLE "company_products" ADD CONSTRAINT "company_products_company_id_fkey"
    FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "company_products" ADD CONSTRAINT "company_products_created_by_id_fkey"
    FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "freight_items" ADD CONSTRAINT "freight_items_company_product_id_fkey"
    FOREIGN KEY ("company_product_id") REFERENCES "company_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
