-- =====================================================================
-- TOLVINK — Additional constraints (run after Prisma migration)
-- These constraints can't be expressed in Prisma schema directly
-- =====================================================================

-- Only ONE active or accepted assignment per freight
-- This replaces the @@unique in Prisma which doesn't support partial indexes
DROP INDEX IF EXISTS "freight_assignments_freight_id_status_key";

CREATE UNIQUE INDEX idx_one_active_assignment
  ON freight_assignments (freight_id)
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
  CHECK (code ~ '^FLT-[0-9]{4,6}$');
