-- =====================================================================
-- TOLVINK — Corrective migration: CREATE TABLE IF NOT EXISTS for 11
-- tables that exist in schema.prisma but had no formal CREATE TABLE
-- in any prior migration. Also fixes type discrepancies found in audit.
--
-- These tables were likely created via `prisma db push` or manual SQL.
-- Using IF NOT EXISTS to be safe for both:
--   (a) production where tables already exist
--   (b) clean deploys where they don't
-- =====================================================================

-- ======================== 1. refresh_tokens ===========================
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "token" VARCHAR(255) NOT NULL,
  "user_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "refresh_tokens_token_key" ON "refresh_tokens"("token");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");
CREATE INDEX IF NOT EXISTS "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- ======================== 2. password_reset_codes =====================
CREATE TABLE IF NOT EXISTS "password_reset_codes" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "code_hash" VARCHAR(255) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "used" BOOLEAN NOT NULL DEFAULT false,
  "reset_jti" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "password_reset_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "password_reset_codes_user_id_idx" ON "password_reset_codes"("user_id");
CREATE INDEX IF NOT EXISTS "password_reset_codes_expires_at_idx" ON "password_reset_codes"("expires_at");

-- ======================== 3. branches =================================
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
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "branches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "branches_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "branches_company_id_idx" ON "branches"("company_id");

-- ======================== 4. user_companies ===========================
CREATE TABLE IF NOT EXISTS "user_companies" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "company_id" TEXT NOT NULL,
  "role" VARCHAR(20) NOT NULL DEFAULT 'operario',
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "user_companies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "user_companies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "user_companies_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "user_companies_user_id_company_id_key" ON "user_companies"("user_id", "company_id");
CREATE INDEX IF NOT EXISTS "user_companies_user_id_idx" ON "user_companies"("user_id");
CREATE INDEX IF NOT EXISTS "user_companies_company_id_idx" ON "user_companies"("company_id");
CREATE INDEX IF NOT EXISTS "user_companies_user_id_active_idx" ON "user_companies"("user_id", "active");

-- ======================== 5. push_subscriptions =======================
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" VARCHAR(255) NOT NULL,
  "auth" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "push_subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_user_id_endpoint_key" ON "push_subscriptions"("user_id", "endpoint");
CREATE INDEX IF NOT EXISTS "push_subscriptions_user_id_idx" ON "push_subscriptions"("user_id");

-- ======================== 6. analytics_events =========================
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

-- ======================== 7. freight_tracking =========================
-- Note: migration 4 (add_missing_columns) does ALTER TABLE on this table
-- but no prior migration has the CREATE TABLE. Creating defensively.
CREATE TABLE IF NOT EXISTS "freight_tracking" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "freight_id" TEXT NOT NULL,
  "user_id" TEXT,
  "lat" DECIMAL(10,6) NOT NULL,
  "lng" DECIMAL(10,6) NOT NULL,
  "speed" DECIMAL(6,2),
  "heading" DECIMAL(5,2),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "freight_tracking_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "freight_tracking_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_idx" ON "freight_tracking"("freight_id");
CREATE INDEX IF NOT EXISTS "freight_tracking_created_at_idx" ON "freight_tracking"("created_at");
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_created_at_idx" ON "freight_tracking"("freight_id", "created_at");
CREATE INDEX IF NOT EXISTS "freight_tracking_freight_id_user_id_created_at_idx" ON "freight_tracking"("freight_id", "user_id", "created_at");

-- ======================== 8. live_locations ============================
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
  "updated_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "live_locations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "live_locations_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "live_locations_freight_id_user_id_key" ON "live_locations"("freight_id", "user_id");
CREATE INDEX IF NOT EXISTS "live_locations_freight_id_active_idx" ON "live_locations"("freight_id", "active");

-- ======================== 9. whatsapp_sessions ========================
CREATE TABLE IF NOT EXISTS "whatsapp_sessions" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
  "user_id" TEXT NOT NULL,
  "phone" VARCHAR(50) NOT NULL,
  "flow_type" VARCHAR(50),
  "flow_state" JSONB,
  "flow_step" VARCHAR(50),
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "whatsapp_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_phone_idx" ON "whatsapp_sessions"("phone");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_phone_expires_at_idx" ON "whatsapp_sessions"("phone", "expires_at");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_idx" ON "whatsapp_sessions"("user_id");
CREATE INDEX IF NOT EXISTS "whatsapp_sessions_user_id_expires_at_idx" ON "whatsapp_sessions"("user_id", "expires_at");

-- ======================== 10. whatsapp_message_logs ===================
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

-- ======================== 11. freight_pending_changes ==================
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

  CONSTRAINT "freight_pending_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "freight_pending_changes_freight_id_fkey" FOREIGN KEY ("freight_id") REFERENCES "freights"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "freight_pending_changes_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "freight_pending_changes_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "freight_pending_changes_freight_id_status_idx" ON "freight_pending_changes"("freight_id", "status");
CREATE INDEX IF NOT EXISTS "freight_pending_changes_approver_company_id_status_idx" ON "freight_pending_changes"("approver_company_id", "status");

-- =====================================================================
-- TYPE DISCREPANCY FIXES (from audit section 7)
-- These use IF/DO blocks to be safe if already applied in production.
-- =====================================================================

-- Fix: freights.dest_company_id — init migration has NOT NULL but schema says optional
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'freights' AND column_name = 'dest_company_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "freights" ALTER COLUMN "dest_company_id" DROP NOT NULL;
  END IF;
END $$;

-- Fix: freight_items.grain — init migration uses enum "GrainType" but schema says VARCHAR(50)
-- This converts the column type if it's currently an enum
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'freight_items' AND column_name = 'grain' AND data_type = 'USER-DEFINED'
  ) THEN
    ALTER TABLE "freight_items" ALTER COLUMN "grain" TYPE VARCHAR(50) USING "grain"::text;
  END IF;
END $$;

-- Fix: audit_logs.from_value — init migration uses VARCHAR(50) but schema says TEXT
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'from_value' AND character_maximum_length = 50
  ) THEN
    ALTER TABLE "audit_logs" ALTER COLUMN "from_value" TYPE TEXT;
  END IF;
END $$;

-- Fix: audit_logs.to_value — same issue
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'to_value' AND character_maximum_length = 50
  ) THEN
    ALTER TABLE "audit_logs" ALTER COLUMN "to_value" TYPE TEXT;
  END IF;
END $$;
