-- CreateTable: diagnostic_sessions
CREATE TABLE IF NOT EXISTS "diagnostic_sessions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "machine_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT,
    "status" VARCHAR(20) NOT NULL DEFAULT 'open',
    "resolution_notes" TEXT,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "share_token" TEXT,
    "share_expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "diagnostic_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "diagnostic_sessions_share_token_key" ON "diagnostic_sessions"("share_token");
CREATE INDEX IF NOT EXISTS "diagnostic_sessions_machine_id_idx" ON "diagnostic_sessions"("machine_id");
CREATE INDEX IF NOT EXISTS "diagnostic_sessions_company_id_idx" ON "diagnostic_sessions"("company_id");

ALTER TABLE "diagnostic_sessions" ADD CONSTRAINT "diagnostic_sessions_machine_id_fkey" FOREIGN KEY ("machine_id") REFERENCES "machines"("id") ON DELETE CASCADE ON UPDATE CASCADE;
