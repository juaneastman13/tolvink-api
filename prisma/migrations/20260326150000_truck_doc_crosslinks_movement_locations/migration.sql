-- TruckDocument cross-linking columns
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "expense_id" TEXT;
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "income_id" TEXT;
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "freight_id" TEXT;
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "movement_id" TEXT;

CREATE INDEX IF NOT EXISTS "truck_documents_expense_id_idx" ON "truck_documents"("expense_id");
CREATE INDEX IF NOT EXISTS "truck_documents_income_id_idx" ON "truck_documents"("income_id");
CREATE INDEX IF NOT EXISTS "truck_documents_freight_id_idx" ON "truck_documents"("freight_id");
CREATE INDEX IF NOT EXISTS "truck_documents_movement_id_idx" ON "truck_documents"("movement_id");

DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "truck_expenses"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_income_id_fkey" FOREIGN KEY ("income_id") REFERENCES "truck_incomes"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN ALTER TABLE "truck_documents" ADD CONSTRAINT "truck_documents_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "truck_movements"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN null; END $$;

-- TruckMovement location columns
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "origin_lat" DECIMAL(10,6);
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "origin_lng" DECIMAL(10,6);
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "origin_field_id" TEXT;
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "origin_lot_id" TEXT;
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "dest_lat" DECIMAL(10,6);
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "dest_lng" DECIMAL(10,6);
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "dest_field_id" TEXT;
ALTER TABLE "truck_movements" ADD COLUMN IF NOT EXISTS "dest_lot_id" TEXT;
