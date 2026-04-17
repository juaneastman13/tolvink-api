-- CreateEnum
CREATE TYPE "StockItemCategory" AS ENUM ('grain', 'fertilizer', 'seed', 'agrochemical', 'fuel', 'other');

-- CreateEnum
CREATE TYPE "StockUnit" AS ENUM ('kg', 'tn', 'lt', 'unit', 'bag');

-- CreateEnum
CREATE TYPE "StockLocationType" AS ENUM ('field', 'lot', 'plant', 'warehouse', 'silo', 'silo_bag', 'shed', 'tank', 'other');

-- CreateEnum
CREATE TYPE "StockOwnershipType" AS ENUM ('own', 'third_party');

-- CreateEnum
CREATE TYPE "StockMovementType" AS ENUM (
  'freight_in_internal',
  'freight_in_third_party',
  'manual_in',
  'purchase_in',
  'adjustment_in',
  'sale_out',
  'reexpedition_out',
  'consumption_out',
  'manual_out',
  'adjustment_out',
  'transfer'
);

-- CreateEnum
CREATE TYPE "StockSourceType" AS ENUM ('freight', 'manual', 'adjustment', 'migration', 'system');

-- CreateTable
CREATE TABLE "stock_items" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "category" "StockItemCategory" NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "code" VARCHAR(80),
  "base_unit" "StockUnit" NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_locations" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "location_type" "StockLocationType" NOT NULL,
  "ownership_type" "StockOwnershipType" NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "reference_key" VARCHAR(120),
  "field_id" TEXT,
  "lot_id" TEXT,
  "plant_id" TEXT,
  "address" VARCHAR(500),
  "notes" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "movement_type" "StockMovementType" NOT NULL,
  "quantity" DECIMAL(14,3) NOT NULL,
  "unit" "StockUnit" NOT NULL,
  "base_quantity" DECIMAL(14,3) NOT NULL,
  "base_unit" "StockUnit" NOT NULL,
  "from_location_id" TEXT,
  "to_location_id" TEXT,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "notes" TEXT,
  "source_type" "StockSourceType" NOT NULL DEFAULT 'manual',
  "source_id" VARCHAR(120),
  "freight_id" TEXT,
  "assignment_id" TEXT,
  "is_system_generated" BOOLEAN NOT NULL DEFAULT false,
  "metadata" JSONB,
  "created_by_user_id" TEXT NOT NULL,
  "reverted_at" TIMESTAMP(3),
  "reverted_by_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
  "id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "item_id" TEXT NOT NULL,
  "location_id" TEXT NOT NULL,
  "current_quantity" DECIMAL(14,3) NOT NULL,
  "base_unit" "StockUnit" NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_items_company_id_category_name_key" ON "stock_items"("company_id", "category", "name");
CREATE INDEX "stock_items_company_id_category_active_idx" ON "stock_items"("company_id", "category", "active");

-- CreateIndex
CREATE UNIQUE INDEX "stock_locations_company_id_reference_key_key" ON "stock_locations"("company_id", "reference_key");
CREATE INDEX "stock_locations_company_id_ownership_type_active_idx" ON "stock_locations"("company_id", "ownership_type", "active");
CREATE INDEX "stock_locations_company_id_location_type_active_idx" ON "stock_locations"("company_id", "location_type", "active");
CREATE INDEX "stock_locations_field_id_idx" ON "stock_locations"("field_id");
CREATE INDEX "stock_locations_lot_id_idx" ON "stock_locations"("lot_id");
CREATE INDEX "stock_locations_plant_id_idx" ON "stock_locations"("plant_id");

-- CreateIndex
CREATE INDEX "stock_movements_company_id_effective_at_idx" ON "stock_movements"("company_id", "effective_at");
CREATE INDEX "stock_movements_company_id_movement_type_effective_at_idx" ON "stock_movements"("company_id", "movement_type", "effective_at");
CREATE INDEX "stock_movements_item_id_effective_at_idx" ON "stock_movements"("item_id", "effective_at");
CREATE INDEX "stock_movements_from_location_id_idx" ON "stock_movements"("from_location_id");
CREATE INDEX "stock_movements_to_location_id_idx" ON "stock_movements"("to_location_id");
CREATE INDEX "stock_movements_source_type_source_id_idx" ON "stock_movements"("source_type", "source_id");
CREATE INDEX "stock_movements_freight_id_idx" ON "stock_movements"("freight_id");
CREATE INDEX "stock_movements_assignment_id_idx" ON "stock_movements"("assignment_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_company_id_item_id_location_id_key" ON "stock_balances"("company_id", "item_id", "location_id");
CREATE INDEX "stock_balances_company_id_updated_at_idx" ON "stock_balances"("company_id", "updated_at");

-- AddForeignKey
ALTER TABLE "stock_items"
  ADD CONSTRAINT "stock_items_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_locations"
  ADD CONSTRAINT "stock_locations_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_locations"
  ADD CONSTRAINT "stock_locations_field_id_fkey"
  FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_locations"
  ADD CONSTRAINT "stock_locations_lot_id_fkey"
  FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_locations"
  ADD CONSTRAINT "stock_locations_plant_id_fkey"
  FOREIGN KEY ("plant_id") REFERENCES "plants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_from_location_id_fkey"
  FOREIGN KEY ("from_location_id") REFERENCES "stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_to_location_id_fkey"
  FOREIGN KEY ("to_location_id") REFERENCES "stock_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_freight_id_fkey"
  FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_assignment_id_fkey"
  FOREIGN KEY ("assignment_id") REFERENCES "freight_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stock_movements"
  ADD CONSTRAINT "stock_movements_reverted_by_user_id_fkey"
  FOREIGN KEY ("reverted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_company_id_fkey"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_item_id_fkey"
  FOREIGN KEY ("item_id") REFERENCES "stock_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "stock_locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
