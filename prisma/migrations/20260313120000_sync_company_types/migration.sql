-- Add company_types JSON column if it doesn't exist yet
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'company_types'
  ) THEN
    ALTER TABLE "companies" ADD COLUMN "company_types" JSONB DEFAULT '[]';
  END IF;
END $$;

-- Backfill: sync types[] from type for all rows where types is empty/null
UPDATE "companies"
SET "company_types" = jsonb_build_array("type"::text)
WHERE "company_types" IS NULL
   OR "company_types"::text = '[]'
   OR "company_types"::text = 'null';
