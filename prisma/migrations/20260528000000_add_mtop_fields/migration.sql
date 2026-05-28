-- AlterTable: Add MTOP Guía de Carga fields to freights
ALTER TABLE "freights"
  ADD COLUMN IF NOT EXISTS "mtop_guide_id"          VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "mtop_access_code"       VARCHAR(50),
  ADD COLUMN IF NOT EXISTS "mtop_guide_status"      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "mtop_duration"          INTEGER,
  ADD COLUMN IF NOT EXISTS "mtop_mode_of_operation" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "mtop_transport_price"   DECIMAL(12, 2);

-- AlterTable: Add MTOP vehicle configuration fields to trucks
ALTER TABLE "trucks"
  ADD COLUMN IF NOT EXISTS "vehicle_config_type" VARCHAR(30),
  ADD COLUMN IF NOT EXISTS "remolque_one_plate"  VARCHAR(20),
  ADD COLUMN IF NOT EXISTS "remolque_two_plate"  VARCHAR(20);
