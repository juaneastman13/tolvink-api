-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "freights_origin_company_id_status_load_date_idx" ON "freights"("origin_company_id", "status", "load_date");

-- CreateIndex
CREATE INDEX CONCURRENTLY IF NOT EXISTS "freights_dest_company_id_status_load_date_idx" ON "freights"("dest_company_id", "status", "load_date");
