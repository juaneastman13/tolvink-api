-- AlterTable: add materialized participant company IDs for fast multi-tenant filtering
ALTER TABLE "freights" ADD COLUMN "participant_company_ids" TEXT[] NOT NULL DEFAULT '{}';

-- GIN index for array containment queries (@> / has)
CREATE INDEX "freights_participant_company_ids_idx" ON "freights" USING GIN ("participant_company_ids");

-- Backfill: compute participantCompanyIds from existing data
UPDATE "freights" f
SET "participant_company_ids" = (
  SELECT COALESCE(array_agg(DISTINCT cid), '{}')
  FROM unnest(
    ARRAY[f."origin_company_id", f."dest_company_id"]
    || COALESCE(
      (SELECT array_agg(DISTINCT fa."transport_company_id")
       FROM "freight_assignments" fa
       WHERE fa."freight_id" = f."id"
         AND fa."status" IN ('active', 'accepted')),
      '{}'
    )
  ) AS cid
  WHERE cid IS NOT NULL
);
