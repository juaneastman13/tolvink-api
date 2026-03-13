-- =====================================================================
-- TOLVINK — Emergency Fix: CREATE TABLE IF NOT EXISTS for ALL tables
-- that may be missing in production.
--
-- Run this MANUALLY against the production DATABASE_URL:
--   psql $DATABASE_URL -f emergency-fix.sql
--
-- This is SAFE to run multiple times (fully idempotent).
-- =====================================================================

-- ======================== weigh_tickets ===============================
CREATE TABLE IF NOT EXISTS "weigh_tickets" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "freight_id" TEXT NOT NULL,
  "assignment_id" TEXT,
  "type" VARCHAR(20) NOT NULL DEFAULT 'destination',
  "ticket_number" VARCHAR(100),
  "gross_weight" DECIMAL(10,2),
  "tare_weight" DECIMAL(10,2),
  "net_weight" DECIMAL(10,2),
  "humidity" DECIMAL(5,2),
  "impurities" DECIMAL(5,2),
  "dockage" DECIMAL(10,2),
  "temperature" DECIMAL(5,2),
  "observations" TEXT,
  "photo_url" VARCHAR(500),
  "ocr_data" JSONB,
  "ocr_confidence" DECIMAL(3,2),
  "registered_by_id" TEXT NOT NULL,
  "registered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "weigh_tickets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "weigh_tickets_freight_id_idx" ON "weigh_tickets"("freight_id");
CREATE INDEX IF NOT EXISTS "weigh_tickets_assignment_id_idx" ON "weigh_tickets"("assignment_id");
CREATE INDEX IF NOT EXISTS "weigh_tickets_ticket_number_idx" ON "weigh_tickets"("ticket_number");
CREATE INDEX IF NOT EXISTS "weigh_tickets_freight_id_assignment_id_type_idx" ON "weigh_tickets"("freight_id", "assignment_id", "type");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weigh_tickets_freight_id_fkey') THEN
    ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weigh_tickets_assignment_id_fkey') THEN
    ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "freight_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'weigh_tickets_registered_by_id_fkey') THEN
    ALTER TABLE "weigh_tickets" ADD CONSTRAINT "weigh_tickets_registered_by_id_fkey" FOREIGN KEY ("registered_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== shared_fields ===============================
CREATE TABLE IF NOT EXISTS "shared_fields" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "field_id" TEXT NOT NULL,
  "shared_by_user_id" TEXT NOT NULL,
  "shared_with_user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shared_fields_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shared_fields_shared_with_user_id_idx" ON "shared_fields"("shared_with_user_id");
CREATE INDEX IF NOT EXISTS "shared_fields_field_id_idx" ON "shared_fields"("field_id");
CREATE UNIQUE INDEX IF NOT EXISTS "shared_fields_field_id_shared_with_user_id_key" ON "shared_fields"("field_id", "shared_with_user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_fields_field_id_fkey') THEN
    ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_fields_shared_by_user_id_fkey') THEN
    ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_fields_shared_with_user_id_fkey') THEN
    ALTER TABLE "shared_fields" ADD CONSTRAINT "shared_fields_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== shared_lots =================================
CREATE TABLE IF NOT EXISTS "shared_lots" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "lot_id" TEXT NOT NULL,
  "shared_by_user_id" TEXT NOT NULL,
  "shared_with_user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shared_lots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shared_lots_shared_with_user_id_idx" ON "shared_lots"("shared_with_user_id");
CREATE INDEX IF NOT EXISTS "shared_lots_lot_id_idx" ON "shared_lots"("lot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "shared_lots_lot_id_shared_with_user_id_key" ON "shared_lots"("lot_id", "shared_with_user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_lots_lot_id_fkey') THEN
    ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_lot_id_fkey" FOREIGN KEY ("lot_id") REFERENCES "lots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_lots_shared_by_user_id_fkey') THEN
    ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_lots_shared_with_user_id_fkey') THEN
    ALTER TABLE "shared_lots" ADD CONSTRAINT "shared_lots_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== shared_pois =================================
CREATE TABLE IF NOT EXISTS "shared_pois" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "poi_id" TEXT NOT NULL,
  "shared_by_user_id" TEXT NOT NULL,
  "shared_with_user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "shared_pois_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "shared_pois_shared_with_user_id_idx" ON "shared_pois"("shared_with_user_id");
CREATE INDEX IF NOT EXISTS "shared_pois_poi_id_idx" ON "shared_pois"("poi_id");
CREATE UNIQUE INDEX IF NOT EXISTS "shared_pois_poi_id_shared_with_user_id_key" ON "shared_pois"("poi_id", "shared_with_user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_pois_poi_id_fkey') THEN
    ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_poi_id_fkey" FOREIGN KEY ("poi_id") REFERENCES "pois"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_pois_shared_by_user_id_fkey') THEN
    ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_shared_by_user_id_fkey" FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shared_pois_shared_with_user_id_fkey') THEN
    ALTER TABLE "shared_pois" ADD CONSTRAINT "shared_pois_shared_with_user_id_fkey" FOREIGN KEY ("shared_with_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== refresh_tokens ==============================
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "token" VARCHAR(255) NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_key" ON "refresh_tokens"("token");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refresh_tokens_user_id_fkey') THEN
    ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== password_reset_codes ========================
CREATE TABLE IF NOT EXISTS "password_reset_codes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "code_hash" VARCHAR(255) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "used" BOOLEAN NOT NULL DEFAULT false,
  "reset_jti" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "password_reset_codes_user_id_idx" ON "password_reset_codes"("user_id");
CREATE INDEX IF NOT EXISTS "password_reset_codes_expires_at_idx" ON "password_reset_codes"("expires_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_codes_user_id_fkey') THEN
    ALTER TABLE "password_reset_codes" ADD CONSTRAINT "password_reset_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== branches ====================================
CREATE TABLE IF NOT EXISTS "branches" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(255) NOT NULL,
  "company_id" TEXT NOT NULL,
  "address" VARCHAR(500),
  "reference" VARCHAR(500),
  "lat" DECIMAL(10,6),
  "lng" DECIMAL(10,6),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "branches_company_id_idx" ON "branches"("company_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branches_company_id_fkey') THEN
    ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== user_companies ==============================
CREATE TABLE IF NOT EXISTS "user_companies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "role" VARCHAR(20) NOT NULL DEFAULT 'operario',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_companies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_companies_user_id_company_id_key" ON "user_companies"("user_id", "company_id");
CREATE INDEX IF NOT EXISTS "user_companies_user_id_idx" ON "user_companies"("user_id");
CREATE INDEX IF NOT EXISTS "user_companies_company_id_idx" ON "user_companies"("company_id");
CREATE INDEX IF NOT EXISTS "user_companies_user_id_active_idx" ON "user_companies"("user_id", "active");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_companies_user_id_fkey') THEN
    ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_companies_company_id_fkey') THEN
    ALTER TABLE "user_companies" ADD CONSTRAINT "user_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== push_subscriptions ==========================
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_user_id_endpoint_key" ON "push_subscriptions"("user_id", "endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscriptions_user_id_fkey') THEN
    ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== analytics_events ============================
CREATE TABLE IF NOT EXISTS "analytics_events" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "event" VARCHAR(100) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}',
  "user_id" TEXT,
  "session_id" VARCHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "analytics_events_event_idx" ON "analytics_events"("event");
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_idx" ON "analytics_events"("user_id");
CREATE INDEX IF NOT EXISTS "analytics_events_created_at_idx" ON "analytics_events"("created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_event_created_at_idx" ON "analytics_events"("event", "created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_session_id_created_at_idx" ON "analytics_events"("session_id", "created_at");
CREATE INDEX IF NOT EXISTS "analytics_events_user_id_created_at_idx" ON "analytics_events"("user_id", "created_at");

-- ======================== freight_tracking =============================
CREATE TABLE IF NOT EXISTS "freight_tracking" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "freight_id" TEXT NOT NULL,
  "user_id" TEXT,
  "lat" DECIMAL(10,6) NOT NULL,
  "lng" DECIMAL(10,6) NOT NULL,
  "speed" DECIMAL(6,2),
  "heading" DECIMAL(5,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "freight_tracking_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_idx" ON "freight_tracking"("freight_id");
CREATE INDEX IF NOT EXISTS "freight_tracking_created_at_idx" ON "freight_tracking"("created_at");
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_created_at_idx" ON "freight_tracking"("freight_id", "created_at");
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_user_id_created_at_idx" ON "freight_tracking"("freight_id", "user_id", "created_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freight_tracking_freight_id_fkey') THEN
    ALTER TABLE "freight_tracking" ADD CONSTRAINT "freight_tracking_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== live_locations ===============================
CREATE TABLE IF NOT EXISTS "live_locations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "freight_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "user_name" VARCHAR(255) NOT NULL,
  "user_role" VARCHAR(30) NOT NULL,
  "lat" DECIMAL(10,6) NOT NULL,
  "lng" DECIMAL(10,6) NOT NULL,
  "speed" DECIMAL(6,2),
  "heading" DECIMAL(5,2),
  "active" BOOLEAN NOT NULL DEFAULT true,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "live_locations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_locations_freight_id_user_id_key" ON "live_locations"("freight_id", "user_id");
CREATE INDEX IF NOT EXISTS "live_locations_freight_id_active_idx" ON "live_locations"("freight_id", "active");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'live_locations_freight_id_fkey') THEN
    ALTER TABLE "live_locations" ADD CONSTRAINT "live_locations_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== whatsapp_sessions ===========================
CREATE TABLE IF NOT EXISTS "whatsapp_sessions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "phone" VARCHAR(50) NOT NULL,
  "flow_type" VARCHAR(50),
  "flow_state" JSONB,
  "flow_step" VARCHAR(50),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_phone_idx" ON "whatsapp_sessions"("phone");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_phone_expires_at_idx" ON "whatsapp_sessions"("phone", "expires_at");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_idx" ON "whatsapp_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_expires_at_idx" ON "whatsapp_sessions"("user_id", "expires_at");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_sessions_user_id_fkey') THEN
    ALTER TABLE "whatsapp_sessions" ADD CONSTRAINT "whatsapp_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== whatsapp_message_logs =======================
CREATE TABLE IF NOT EXISTS "whatsapp_message_logs" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "wa_message_id" VARCHAR(100),
  "phone" VARCHAR(50) NOT NULL,
  "direction" VARCHAR(10) NOT NULL,
  "type" VARCHAR(30) NOT NULL,
  "content" JSONB,
  "status" VARCHAR(20),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "whatsapp_message_logs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "whatsapp_message_logs_phone_idx" ON "whatsapp_message_logs"("phone");
CREATE INDEX IF NOT EXISTS "whatsapp_message_logs_wa_message_id_idx" ON "whatsapp_message_logs"("wa_message_id");
CREATE INDEX IF NOT EXISTS "whatsapp_message_logs_created_at_idx" ON "whatsapp_message_logs"("created_at");

-- ======================== freight_pending_changes =====================
CREATE TABLE IF NOT EXISTS "freight_pending_changes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "freight_id" TEXT NOT NULL,
  "change_type" VARCHAR(50) NOT NULL,
  "from_value" JSONB NOT NULL,
  "to_value" JSONB NOT NULL,
  "requested_by_id" TEXT NOT NULL,
  "approver_company_id" TEXT NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolved_at" TIMESTAMP(3),
  "resolved_by_id" TEXT,

  CONSTRAINT "freight_pending_changes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "freight_pending_changes_freight_id_status_idx" ON "freight_pending_changes"("freight_id", "status");
CREATE INDEX IF NOT EXISTS "freight_pending_changes_approver_company_id_status_idx" ON "freight_pending_changes"("approver_company_id", "status");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freight_pending_changes_freight_id_fkey') THEN
    ALTER TABLE "freight_pending_changes" ADD CONSTRAINT "freight_pending_changes_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freight_pending_changes_requested_by_id_fkey') THEN
    ALTER TABLE "freight_pending_changes" ADD CONSTRAINT "freight_pending_changes_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'freight_pending_changes_resolved_by_id_fkey') THEN
    ALTER TABLE "freight_pending_changes" ADD CONSTRAINT "freight_pending_changes_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ======================== company_types column ========================
-- The sync_company_types migration had a bug ("Company" instead of "companies")
-- so this column may not exist
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'company_types'
  ) THEN
    ALTER TABLE "companies" ADD COLUMN "company_types" JSONB DEFAULT '[]';
  END IF;
END $$;

UPDATE "companies"
SET "company_types" = jsonb_build_array("type"::text)
WHERE "company_types" IS NULL
   OR "company_types"::text = '[]'
   OR "company_types"::text = 'null';

-- ======================== VERIFICATION ================================
-- Run this after to confirm all tables exist:
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN (
  'weigh_tickets', 'shared_fields', 'shared_lots', 'shared_pois',
  'refresh_tokens', 'password_reset_codes', 'branches',
  'user_companies', 'push_subscriptions', 'analytics_events',
  'freight_tracking', 'live_locations', 'whatsapp_sessions',
  'whatsapp_message_logs', 'freight_pending_changes'
)
ORDER BY table_name;
-- Should return 15 rows.
