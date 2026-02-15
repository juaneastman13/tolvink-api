-- =====================================================================
-- TOLVINK — Migration: add_loaded_state_and_cross_confirmations
-- Safe incremental migration — NO destructive operations
-- Run AFTER prisma migrate deploy
-- =====================================================================

-- STEP 1: Add 'loaded' to FreightStatus enum
-- Prisma migrate handles this automatically via ALTER TYPE ... ADD VALUE
-- But if running manually:
-- ALTER TYPE "FreightStatus" ADD VALUE IF NOT EXISTS 'loaded' AFTER 'in_progress';

-- STEP 2: Add confirmation timestamp columns (all nullable, no default)
-- These are handled by Prisma migrate, but for reference:
-- ALTER TABLE freights ADD COLUMN IF NOT EXISTS loaded_at TIMESTAMP;
-- ALTER TABLE freights ADD COLUMN IF NOT EXISTS transporter_loaded_confirmed_at TIMESTAMP;
-- ALTER TABLE freights ADD COLUMN IF NOT EXISTS producer_loaded_confirmed_at TIMESTAMP;
-- ALTER TABLE freights ADD COLUMN IF NOT EXISTS transporter_finished_confirmed_at TIMESTAMP;
-- ALTER TABLE freights ADD COLUMN IF NOT EXISTS plant_finished_confirmed_at TIMESTAMP;

-- STEP 3: Add notification types
-- ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'freight_loaded';
-- ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'freight_confirmed';

-- =====================================================================
-- VERIFICATION QUERIES (run after migration to confirm)
-- =====================================================================

-- Verify enum has 'loaded':
-- SELECT enum_range(NULL::"FreightStatus");

-- Verify columns exist:
-- SELECT column_name, data_type, is_nullable 
-- FROM information_schema.columns 
-- WHERE table_name = 'freights' 
-- AND column_name LIKE '%confirmed%';

-- Verify no existing data was affected:
-- SELECT status, count(*) FROM freights GROUP BY status;

-- =====================================================================
-- ROLLBACK (only if needed — safe because columns are nullable)
-- =====================================================================
-- NOTE: PostgreSQL does NOT support removing enum values.
-- The 'loaded' value will remain in the enum even if rolled back.
-- Columns can be dropped safely since they're all nullable with no data:
-- ALTER TABLE freights DROP COLUMN IF EXISTS loaded_at;
-- ALTER TABLE freights DROP COLUMN IF EXISTS transporter_loaded_confirmed_at;
-- ALTER TABLE freights DROP COLUMN IF EXISTS producer_loaded_confirmed_at;
-- ALTER TABLE freights DROP COLUMN IF EXISTS transporter_finished_confirmed_at;
-- ALTER TABLE freights DROP COLUMN IF EXISTS plant_finished_confirmed_at;
