-- Token de integración BPS (solo lectura, para Excel/Power Query).
-- Se guarda únicamente el hash SHA-256 del token; el valor en claro se
-- muestra una sola vez al generarlo.

CREATE TABLE IF NOT EXISTS "bps_tokens" (
    "id"         TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "active"     BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bps_tokens_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bps_tokens_company_id_key" ON "bps_tokens"("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "bps_tokens_token_hash_key" ON "bps_tokens"("token_hash");
