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

**Archivo extra:** `prisma/migrations/migration.sql` (no está en carpeta numerada — es un archivo de referencia/manual, NO ejecutado por `prisma migrate deploy`).

---

## 2. ⚠️ TABLAS SIN MIGRACIÓN (CRÍTICO)

Las siguientes 11 tablas están definidas en `schema.prisma` pero **NO tienen CREATE TABLE en ninguna migración**:

| Tabla (@@map) | Modelo Prisma | Estado |
|--------------|--------------|--------|
| `analytics_events` | AnalyticsEvent | ⚠️ Sin CREATE TABLE |
| `branches` | Branch | ⚠️ Sin CREATE TABLE |
| `freight_pending_changes` | FreightPendingChange | ⚠️ Sin CREATE TABLE |
| `freight_tracking` | FreightTracking | ⚠️ Sin CREATE TABLE (solo ALTER en migration 4) |
| `live_locations` | LiveLocation | ⚠️ Sin CREATE TABLE |
| `password_reset_codes` | PasswordResetCode | ⚠️ Sin CREATE TABLE |
| `push_subscriptions` | PushSubscription | ⚠️ Sin CREATE TABLE |
| `refresh_tokens` | RefreshToken | ⚠️ Sin CREATE TABLE |
| `user_companies` | UserCompany | ⚠️ Sin CREATE TABLE |
| `whatsapp_message_logs` | WhatsAppMessageLog | ⚠️ Sin CREATE TABLE |
| `whatsapp_sessions` | WhatsAppSession | ⚠️ Sin CREATE TABLE |

### Impacto

Si se hace un deploy limpio (nueva base de datos + `prisma migrate deploy`), estas 11 tablas **NO serán creadas**, causando errores en:

- **Auth:** `refresh_tokens`, `password_reset_codes` — login/refresh/password-reset fallarían
- **Branches:** `branches` — catálogo de sucursales vacío
- **Analytics:** `analytics_events` — tracking de eventos falla silenciosamente
- **WhatsApp:** `whatsapp_sessions`, `whatsapp_message_logs` — bot WhatsApp no funciona
- **Push:** `push_subscriptions` — notificaciones push no funcionan
- **Tracking:** `freight_tracking`, `live_locations` — tracking GPS no funciona
- **Multi-empresa:** `user_companies` — memberships multi-empresa no funcionan
- **Cambios pendientes:** `freight_pending_changes` — flujo de aprobación no funciona

### Causa probable

Estas tablas fueron creadas manualmente en la base de datos de desarrollo/producción (o via `prisma db push`) pero nunca se generó una migración formal con `prisma migrate dev`.

### Acción correctiva requerida

Crear una migración de consolidación que incluya `CREATE TABLE IF NOT EXISTS` para las 11 tablas con todos sus campos, índices, constraints y foreign keys según el schema actual.

---

## 3. ⚠️ BUG EN MIGRACIÓN `sync_company_types`

La migración `20260313120000_sync_company_types` referencia la tabla como `"Company"` (modelo Prisma) en lugar de `"companies"` (nombre en PostgreSQL vía `@@map`):

```sql
-- LÍNEA 3: INCORRECTO
WHERE table_name = 'Company' AND column_name = 'company_types'
-- DEBERÍA SER:
WHERE table_name = 'companies' AND column_name = 'company_types'

-- LÍNEA 8: INCORRECTO
ALTER TABLE "Company" ADD COLUMN "company_types" JSONB DEFAULT '[]';
-- DEBERÍA SER:
ALTER TABLE "companies" ADD COLUMN "company_types" JSONB DEFAULT '[]';

-- LÍNEA 13-16: INCORRECTO
UPDATE "Company" SET ...
-- DEBERÍA SER:
UPDATE "companies" SET ...
```

**Impacto:** Esta migración falla silenciosamente o no hace nada en producción, ya que la tabla `"Company"` no existe (es `"companies"`). La columna `company_types` podría NO existir en producción si no fue creada por otro mecanismo.

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
| `freights.dest_company_id` | NOT NULL | `String?` (opcional) | No encontrada ⚠️ |
| `freight_items.grain` | `"GrainType" NOT NULL` (enum) | `String @db.VarChar(50)` | No encontrada ⚠️ |
| `conversations.freight_id` | NOT NULL | `String?` (optional) | Migration 3 (`structural_domain_update`) ✅ |
| `audit_logs.from_value` | `VARCHAR(50)` | `@db.Text` | No encontrada ⚠️ |
| `audit_logs.to_value` | `VARCHAR(50)` | `@db.Text` | No encontrada ⚠️ |

### Impacto de discrepancias
- `dest_company_id` como NOT NULL en DB pero optional en schema: podría causar errores al crear fletes sin destino (si soportado). El ALTER TABLE para DROP NOT NULL no existe en migraciones.
- `grain` como enum en DB pero VarChar en schema: Prisma ORM manejará la conversión, pero SQL directo podría fallar si se envía un valor fuera del enum.
- `audit_logs.from_value/to_value` como VARCHAR(50) en DB pero Text en schema: truncación silenciosa si valores > 50 chars.

---

## 8. Resumen de acciones correctivas

| Prioridad | Acción | Riesgo |
|-----------|--------|--------|
| 🔴 CRÍTICO | Crear migración de consolidación para las 11 tablas faltantes | Sin esto, un deploy limpio falla completamente |
| 🔴 CRÍTICO | Corregir migración `sync_company_types` (tabla "Company" → "companies") | La columna `company_types` podría no existir |
| 🟡 MEDIO | Crear ALTER TABLE para `dest_company_id` DROP NOT NULL | Freights sin destino podrían fallar |
| 🟡 MEDIO | Crear ALTER TABLE para `freight_items.grain` cambiar de enum a VARCHAR | Grain types fuera del enum fallarían |
| 🟡 MEDIO | Crear ALTER TABLE para `audit_logs.from_value/to_value` cambiar a TEXT | Valores largos se truncan |
| 🟢 BAJO | Verificar estado real de producción con `prisma migrate status` contra la DB | Confirmar qué tablas existen realmente |

---

*Generado automáticamente el 2026-03-13*
