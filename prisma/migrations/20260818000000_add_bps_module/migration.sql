-- BPS (Banco de Previsión Social) module: cuenta autenticada, monitoreo de
-- certificados por RUT, historial de consultas y configuración por empresa.

-- AlterEnum: nuevos tipos de notificación BPS
-- (PG >= 12 permite ADD VALUE dentro de transacción mientras no se use en la misma)
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'bps_certificado';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'bps_cuenta';

-- CreateTable
CREATE TABLE IF NOT EXISTS "bps_cuentas" (
    "id"                 TEXT NOT NULL,
    "company_id"         TEXT NOT NULL,
    "usuario"            VARCHAR(100) NOT NULL,
    "credencial_cifrada" TEXT NOT NULL,
    "ultima_sync"        TIMESTAMP(3),
    "ultimo_error"       VARCHAR(500),
    "active"             BOOLEAN NOT NULL DEFAULT true,
    "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bps_cuentas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bps_cuentas_company_id_key" ON "bps_cuentas"("company_id");

-- CreateTable
CREATE TABLE IF NOT EXISTS "bps_datos_cuenta" (
    "id"          TEXT NOT NULL,
    "cuenta_id"   TEXT NOT NULL,
    "tipo"        VARCHAR(20) NOT NULL,
    "estado"      VARCHAR(20) NOT NULL DEFAULT 'DESCONOCIDO',
    "resumen"     VARCHAR(500),
    "detalle"     JSONB,
    "obtenido_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bps_datos_cuenta_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bps_datos_cuenta_cuenta_id_tipo_obtenido_en_idx" ON "bps_datos_cuenta"("cuenta_id", "tipo", "obtenido_en");

-- CreateTable
CREATE TABLE IF NOT EXISTS "bps_empresas_monitoreadas" (
    "id"                TEXT NOT NULL,
    "company_id"        TEXT NOT NULL,
    "linked_company_id" TEXT,
    "rut"               VARCHAR(12) NOT NULL,
    "nombre"            VARCHAR(255),
    "estado"            VARCHAR(20) NOT NULL DEFAULT 'DESCONOCIDO',
    "vigente_hasta"     TIMESTAMP(3),
    "ultima_consulta"   TIMESTAMP(3),
    "active"            BOOLEAN NOT NULL DEFAULT true,
    "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bps_empresas_monitoreadas_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "bps_empresas_monitoreadas_company_id_rut_key" ON "bps_empresas_monitoreadas"("company_id", "rut");
CREATE INDEX IF NOT EXISTS "bps_empresas_monitoreadas_company_id_active_idx" ON "bps_empresas_monitoreadas"("company_id", "active");

-- CreateTable
CREATE TABLE IF NOT EXISTS "bps_consultas" (
    "id"            TEXT NOT NULL,
    "empresa_id"    TEXT NOT NULL,
    "estado"        VARCHAR(20) NOT NULL,
    "vigente_hasta" TIMESTAMP(3),
    "raw"           JSONB,
    "consultado_en" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bps_consultas_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "bps_consultas_empresa_id_consultado_en_idx" ON "bps_consultas"("empresa_id", "consultado_en");

-- CreateTable
CREATE TABLE IF NOT EXISTS "bps_config" (
    "company_id"           TEXT NOT NULL,
    "frecuencia"           VARCHAR(15) NOT NULL DEFAULT 'diaria',
    "alertas_activas"      BOOLEAN NOT NULL DEFAULT true,
    "notificar_dias_antes" INTEGER NOT NULL DEFAULT 7,
    "updated_at"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bps_config_pkey" PRIMARY KEY ("company_id")
);

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "bps_datos_cuenta" ADD CONSTRAINT "bps_datos_cuenta_cuenta_id_fkey"
    FOREIGN KEY ("cuenta_id") REFERENCES "bps_cuentas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "bps_consultas" ADD CONSTRAINT "bps_consultas_empresa_id_fkey"
    FOREIGN KEY ("empresa_id") REFERENCES "bps_empresas_monitoreadas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
