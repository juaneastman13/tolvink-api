-- Add OCR fields to truck_documents
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "ocr_data" JSONB;
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "ocr_status" VARCHAR(20);
ALTER TABLE "truck_documents" ADD COLUMN IF NOT EXISTS "ocr_processed_at" TIMESTAMP(3);
