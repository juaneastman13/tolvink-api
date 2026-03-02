-- =====================================================================
-- TOLVINK — Additional constraints (run after Prisma migration)
-- These constraints can't be expressed in Prisma schema directly
-- =====================================================================

-- Unique active assignment per freight + trip_number (supports multi-truck)
-- Each trip_number can only have ONE active/accepted assignment per freight
DROP INDEX IF EXISTS "idx_one_active_assignment";
DROP INDEX IF EXISTS "freight_assignments_freight_id_status_key";

CREATE UNIQUE INDEX idx_one_active_assignment
  ON freight_assignments (freight_id, trip_number)
  WHERE status IN ('active', 'accepted');

-- Cancel reason must exist when freight is canceled
ALTER TABLE freights
  ADD CONSTRAINT chk_cancel_reason
  CHECK (
    (status != 'canceled') OR
    (status = 'canceled' AND cancel_reason IS NOT NULL AND length(cancel_reason) > 0 AND length(cancel_reason) <= 255)
  );

-- Assignment reason must exist when rejected or canceled
ALTER TABLE freight_assignments
  ADD CONSTRAINT chk_assignment_reason
  CHECK (
    (status NOT IN ('rejected', 'canceled')) OR
    (status IN ('rejected', 'canceled') AND reason IS NOT NULL AND length(reason) > 0 AND length(reason) <= 255)
  );

-- Freight code format
ALTER TABLE freights
  ADD CONSTRAINT chk_freight_code_format
  CHECK (code ~ '^(FLT-[0-9]{4,6}|F[0-9]{2}-[A-Z]{3}\.[0-9]{4})$');
