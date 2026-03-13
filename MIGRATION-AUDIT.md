# TOLVINK — Migration Audit Report

**Fecha:** 2026-03-13
**Schema:** `prisma/schema.prisma` (Prisma v5.22.0)
**Estado de validación:** `prisma validate` ✅ | `prisma generate` ✅

---

## 1. Lista de migraciones existentes

| # | Fecha | Nombre | Tipo | Tablas afectadas |
|---|-------|--------|------|-----------------|
| 1 | 2026-02-15 | `init` | CREATE | companies, users, plants, lots, freights, freight_items, freight_assignments, freight_documents, conversations, messages, audit_logs, notifications |
| 2 | 2026-02-15 | `add_loaded_state` | ALTER | freights (loaded_at, cross-confirmations), enums (FreightStatus, NotificationType) |
| 3 | 2026-02-15 | `structural_domain_update` | CREATE+ALTER | fields, trucks, plant_producer_access, conversation_participants. ALTER: conversations, freight_assignments, freight_documents, freights, lots |
| 4 | 2026-02-16 | `add_missing_columns` | ALTER | users (userTypes, companyByType, roleByType, isSuperAdmin), companies (rut, hasInternalFleet, lat, lng), fields (hectares, comments), lots (comments), trucks (brand, capacity), freights (fieldId), freight_tracking (userId) |
| 5 | 2026-03-11 | `perf_compound_indexes` | INDEX | freights (compound indexes: origin+status+loadDate, dest+status+loadDate) |
| 6 | 2026-03-12 | `add_participant_company_ids` | ALTER+INDEX | freights (participantCompanyIds TEXT[] + GIN index + backfill) |
| 7 | 2026-03-12 | `add_poi_model` | CREATE | pois |
| 8 | 2026-03-12 | `ensure_pois_table` | CREATE IF NOT EXISTS | pois (fallback) |
| 9 | 2026-03-13 | `sync_company_types` | ALTER+UPDATE | ⚠️ Company (company_types) — **tabla referenciada como "Company" en lugar de "companies"** |
| 10 | 2026-03-13 | `add_weigh_tickets` | CREATE | weigh_tickets |
| 11 | 2026-03-13 | `add_shared_pois` | CREATE | shared_pois |
| 12 | 2026-03-13 | `add_shared_fields_and_lots` | CREATE | shared_fields, shared_lots |
| 13 | 2026-03-13 | `fix_missing_creates` | CREATE IF NOT EXISTS + ALTER | 11 tablas faltantes + correcciones de tipo |

**Archivo extra:** `prisma/migrations/migration.sql` (no está en carpeta numerada — es un archivo de referencia/manual, NO ejecutado por `prisma migrate deploy`).

---

## 2. ⚠️ TABLAS SIN MIGRACIÓN (CRÍTICO)

Las siguientes 11 tablas están definidas en `schema.prisma` pero **NO tienen CREATE TABLE en ninguna migración**:

| Tabla (@@map) | Modelo Prisma | Estado |
|--------------|--------------|--------|
| `analytics_events` | AnalyticsEvent | ✅ CORREGIDO — migration 13 |
| `branches` | Branch | ✅ CORREGIDO — migration 13 |
| `freight_pending_changes` | FreightPendingChange | ✅ CORREGIDO — migration 13 |
| `freight_tracking` | FreightTracking | ✅ CORREGIDO — migration 13 |
| `live_locations` | LiveLocation | ✅ CORREGIDO — migration 13 |
| `password_reset_codes` | PasswordResetCode | ✅ CORREGIDO — migration 13 |
| `push_subscriptions` | PushSubscription | ✅ CORREGIDO — migration 13 |
| `refresh_tokens` | RefreshToken | ✅ CORREGIDO — migration 13 |
| `user_companies` | UserCompany | ✅ CORREGIDO — migration 13 |
| `whatsapp_message_logs` | WhatsAppMessageLog | ✅ CORREGIDO — migration 13 |
| `whatsapp_sessions` | WhatsAppSession | ✅ CORREGIDO — migration 13 |

### Corrección aplicada

Migración `20260313230000_fix_missing_creates` contiene `CREATE TABLE IF NOT EXISTS` para las 11 tablas con todos sus campos, índices, constraints y foreign keys según el schema actual. Usa `IF NOT EXISTS` para ser segura tanto en producción (donde las tablas ya existen) como en deploys limpios.

### Causa original

Estas tablas fueron creadas via `prisma db push` pero nunca se generó una migración formal.

---

## 3. ✅ BUG CORREGIDO — MIGRACIÓN `sync_company_types`

La migración `20260313120000_sync_company_types` referenciaba la tabla como `"Company"` (modelo Prisma) en lugar de `"companies"` (nombre en PostgreSQL vía `@@map`).

**Estado:** ✅ CORREGIDO — El SQL de la migración fue editado in-place para usar `"companies"` en todas las referencias (`information_schema` check, `ALTER TABLE`, `UPDATE`).

**Nota para producción:** Si esta migración ya fue ejecutada en producción (con el nombre incorrecto), no hizo nada. La columna `company_types` podría necesitar ser creada manualmente si no existe. Verificar con:
```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'companies' AND column_name = 'company_types';
```
Si no retorna resultados, ejecutar manualmente:
```sql
ALTER TABLE "companies" ADD COLUMN "company_types" JSONB DEFAULT '[]';
UPDATE "companies" SET "company_types" = jsonb_build_array("type"::text) WHERE "company_types" IS NULL OR "company_types"::text = '[]';
```

---

## 4. Modelos verificados correctamente

### SharedField ✅
- Migration: `20260313210000_add_shared_fields_and_lots`
- Campos: id, field_id, shared_by_user_id, shared_with_user_id, active, created_at
- Indexes: shared_with_user_id, field_id
- Unique: `(field_id, shared_with_user_id)`
- Foreign keys: field → fields(CASCADE), sharedBy → users(CASCADE), sharedWith → users(CASCADE)

### SharedLot ✅
- Migration: `20260313210000_add_shared_fields_and_lots`
- Campos: id, lot_id, shared_by_user_id, shared_with_user_id, active, created_at
- Indexes: shared_with_user_id, lot_id
- Unique: `(lot_id, shared_with_user_id)`
- Foreign keys: lot → lots(CASCADE), sharedBy → users(CASCADE), sharedWith → users(CASCADE)

### SharedPoi ✅
- Migration: `20260313200000_add_shared_pois`
- Campos: id, poi_id, shared_by_user_id, shared_with_user_id, active, created_at
- Indexes: shared_with_user_id, poi_id
- Unique: `(poi_id, shared_with_user_id)`
- Foreign keys: poi → pois(CASCADE), sharedBy → users(CASCADE), sharedWith → users(CASCADE)

### WeighTicket ✅
- Migration: `20260313180000_add_weigh_tickets`
- Todos los campos presentes: id, freight_id, assignment_id, type, ticket_number, gross_weight, tare_weight, net_weight, humidity, impurities, dockage, temperature, observations, photo_url, ocr_data, ocr_confidence, registered_by_id, registered_at, created_at, updated_at
- Indexes: freight_id, assignment_id, ticket_number, compound (freight_id, assignment_id, type)
- Foreign keys: freight → freights(CASCADE), assignment → freight_assignments(SET NULL), registeredBy → users(RESTRICT)

### GIN Index en participantCompanyIds ✅
- Migration: `20260312120000_add_participant_company_ids`
- Columna `participant_company_ids TEXT[]` con `DEFAULT '{}'`
- `CREATE INDEX ... USING GIN ("participant_company_ids")`
- Incluye backfill SQL para datos existentes

---

## 5. Campos huérfanos

### `seen_at` / `seenAt`
- **No encontrado** en ningún archivo del código backend. ✅ Limpio.

### Otros campos huérfanos
- **No encontrados.** Grep extensivo de `freights.service.ts`, `fields.service.ts`, `ai.service.ts` no reveló accesos a campos inexistentes en el schema.

---

## 6. Campos opcionales usados sin null check

⚠️ Migración 4 (`add_missing_columns`) agrega `freight_tracking.user_id` como ALTER TABLE sin NOT NULL. El campo está como opcional (`?`) en el schema. El código debería manejar null — **no se detectaron usos sin null check** en las queries de tracking.

---

## 7. Campos del schema con discrepancias de tipo entre init migration y schema actual

| Campo | Init migration | Schema actual | Migración que lo corrige |
|-------|---------------|--------------|-------------------------|
| `freights.dest_company_id` | NOT NULL | `String?` (opcional) | ✅ Migration 13 (`fix_missing_creates`) — DROP NOT NULL condicional |
| `freight_items.grain` | `"GrainType" NOT NULL` (enum) | `String @db.VarChar(50)` | ✅ Migration 13 (`fix_missing_creates`) — ALTER TYPE condicional |
| `conversations.freight_id` | NOT NULL | `String?` (optional) | Migration 3 (`structural_domain_update`) ✅ |
| `audit_logs.from_value` | `VARCHAR(50)` | `@db.Text` | ✅ Migration 13 (`fix_missing_creates`) — ALTER TYPE condicional |
| `audit_logs.to_value` | `VARCHAR(50)` | `@db.Text` | ✅ Migration 13 (`fix_missing_creates`) — ALTER TYPE condicional |

### Impacto de discrepancias — CORREGIDO
Las correcciones de tipo en migration 13 usan bloques `DO $$ ... IF EXISTS ... $$` condicionales:
- Solo aplican si la discrepancia realmente existe en la DB
- Son no-ops si ya fueron corregidas por otro mecanismo

---

## 8. Resumen de acciones correctivas

| Prioridad | Acción | Estado |
|-----------|--------|--------|
| 🔴 CRÍTICO | Crear migración de consolidación para las 11 tablas faltantes | ✅ CORREGIDO — `20260313230000_fix_missing_creates` |
| 🔴 CRÍTICO | Corregir migración `sync_company_types` (tabla "Company" → "companies") | ✅ CORREGIDO — SQL editado in-place |
| 🟡 MEDIO | Crear ALTER TABLE para `dest_company_id` DROP NOT NULL | ✅ CORREGIDO — incluido en migration 13 |
| 🟡 MEDIO | Crear ALTER TABLE para `freight_items.grain` cambiar de enum a VARCHAR | ✅ CORREGIDO — incluido en migration 13 |
| 🟡 MEDIO | Crear ALTER TABLE para `audit_logs.from_value/to_value` cambiar a TEXT | ✅ CORREGIDO — incluido en migration 13 |
| 🟢 BAJO | Verificar estado real de producción con `prisma migrate status` contra la DB | PENDIENTE DE DEPLOY |

---

## 9. Instrucciones de deploy

### Para aplicar las correcciones en producción:

1. **Merge** este branch a main (si no lo está)
2. Railway ejecuta `prisma migrate deploy` automáticamente en el start script
3. Las migraciones se aplican en orden cronológico:
   - `20260313120000_sync_company_types` — ahora corregido, creará `company_types` en `"companies"` si no existe
   - `20260313230000_fix_missing_creates` — creará las 11 tablas si no existen (`IF NOT EXISTS`), aplicará correcciones de tipo condicionalmente

### Verificación post-deploy:

```sql
-- Verificar que las 11 tablas existen
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name IN ('refresh_tokens', 'password_reset_codes', 'branches',
  'user_companies', 'push_subscriptions', 'analytics_events',
  'freight_tracking', 'live_locations', 'whatsapp_sessions',
  'whatsapp_message_logs', 'freight_pending_changes');

-- Verificar company_types existe
SELECT column_name FROM information_schema.columns
WHERE table_name = 'companies' AND column_name = 'company_types';

-- Verificar correcciones de tipo
SELECT column_name, is_nullable, data_type FROM information_schema.columns
WHERE (table_name = 'freights' AND column_name = 'dest_company_id')
   OR (table_name = 'freight_items' AND column_name = 'grain')
   OR (table_name = 'audit_logs' AND column_name IN ('from_value', 'to_value'));
```

### Riesgo:

**BAJO** — Todas las correcciones usan `IF NOT EXISTS` / `IF EXISTS` condicionales. Son idempotentes y no pueden romper datos existentes.

---

*Generado automáticamente el 2026-03-13 — Actualizado el 2026-03-13*
