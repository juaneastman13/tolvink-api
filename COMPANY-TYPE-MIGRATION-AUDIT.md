# Auditoría: `company.type` vs `company.types` — Migración de tipo dual

**Fecha:** 2026-03-12
**Alcance:** Todo el backend (`src/`, `prisma/`)

---

## Contexto

El modelo `Company` tiene dos campos para representar el tipo de empresa:

| Campo | Tipo | Propósito |
|-------|------|-----------|
| `type` | `CompanyType` enum (string) | Legacy — un solo tipo por empresa |
| `types` | `Json` (string array) | Nuevo — soporte multi-tipo (ej. `["producer", "plant"]`) |

**Problema:** Distintas partes del código leen uno u otro campo, generando inconsistencias. Empresas multi-tipo pueden no funcionar correctamente si el código solo lee `type`.

---

## Patrón canónico de fallback

Existe un helper `getCompanyTypes()` duplicado en dos archivos que establece el patrón correcto:

```typescript
// Prefiere types[] si está poblado, fallback a type singular
function getCompanyTypes(company: any): string[] {
  if (!company) return [];
  const arr = Array.isArray(company.types) && company.types.length > 0
    ? company.types
    : (company.type ? [company.type] : []);
  return arr;
}
```

**Ubicaciones:**
- `src/auth/auth.service.ts:25-31`
- `src/common/services/company-resolution.service.ts:21-27`

---

## Tabla de referencias

### CRÍTICAS — Guards, Auth, Resolución de tipo

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 1 | `common/guards/roles.guard.ts` | 41 | `user.companyType` + `user.companyTypes` | JWT dual check | ✅ Sí | **CRÍTICA** |
| 2 | `common/guards/roles.guard.ts` | 53 | `m.company?.type` | DB fallback set construction | ✅ Sí (lee ambos) | **CRÍTICA** |
| 3 | `common/services/company-resolution.service.ts` | 25 | `company.type` | Dentro de `getCompanyTypes()` | ✅ Es el fallback | **CRÍTICA** |
| 4 | `common/services/company-resolution.service.ts` | 100 | `m.company?.type === 'producer'` | `resolveProducerCompanyId` | ✅ `\|\| getCompanyTypes().includes()` | **CRÍTICA** |
| 5 | `common/services/company-resolution.service.ts` | 123 | `m.company?.type === 'plant'` | `resolvePlantCompanyId` | ✅ `\|\| getCompanyTypes().includes()` | **CRÍTICA** |
| 6 | `common/services/company-resolution.service.ts` | 143 | `user.companyType` | `hasCompanyType()` fast-path | ✅ Falls back to DB | **CRÍTICA** |
| 7 | `common/services/company-resolution.service.ts` | 148 | memberships via `getCompanyTypes` | `hasCompanyType()` DB check | ✅ Sí | **CRÍTICA** |
| 8 | `common/services/company-resolution.service.ts` | 163 | memberships via `getCompanyTypes` | `resolveCompanyType()` | ✅ Sí | **CRÍTICA** |
| 9 | `common/services/company-resolution.service.ts` | 183 | `m.company?.type === 'producer'` | `resolveAllCompanyIds` producer filtering | ✅ `\|\| getCompanyTypes().includes()` | **CRÍTICA** |
| 10 | `auth/auth.service.ts` | 29 | `company.type` | Dentro de `getCompanyTypes()` | ✅ Es el fallback | **CRÍTICA** |
| 11 | `auth/auth.service.ts` | 636 | `m.company?.type` | Response company membership mapping | ⚠️ Solo `type` en `companyType` | **CRÍTICA** |
| 12 | `auth/auth.service.ts` | 637 | `getCompanyTypes(m.company)` | Response `companyTypes` array | ✅ Sí | **CRÍTICA** |
| 13 | `auth/auth.service.ts` | 649-650 | `getCompanyTypes()` + `activeCompany?.type` | JWT payload generation | ✅ Prefiere types | **CRÍTICA** |
| 14 | `auth/auth.service.ts` | 623 | `getCompanyTypes(activeCompany)` | Active company types in response | ✅ Sí | **CRÍTICA** |
| 15 | `common/build-synthetic-user.ts` | 32 | `dbUser.company.type` | Synthetic user `companyType` | ⚠️ Parcial — usa userTypes primero, fallback a .type | **CRÍTICA** |

### CRÍTICAS — Queries Prisma con `type` en WHERE

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 16 | `freights/freights.service.ts` | 184 | `type: 'plant'` | Plant query en create (destPlant) | ❌ Solo `type` | **CRÍTICA** |
| 17 | `catalog.controller.ts` | 134 | `OR: [{ type: 'plant' }, { types: { has: 'plant' } }]` | Destinations query | ✅ OR dual | OK |
| 18 | `plant-access/plant-access.controller.ts` | 353 | `OR: [{ type: 'plant' }, { types: { has: 'plant' } }]` | Plant companies listing | ✅ OR dual | OK |
| 19 | `ai/ai.service.ts` | 3774 | `OR: [{ type: 'transporter' }, { types: { array_contains: ['transporter'] } }]` | Search transporters | ✅ OR dual | OK |
| 20 | `ai/ai.service.ts` | 5009 | `select: { type: true }` | Grant producer access — reads type | ❌ Solo `type` | **CRÍTICA** |
| 21 | `ai/ai.service.ts` | 5012 | `producerCo.type !== 'producer' && producerCo.type !== 'transporter'` | Validates company type | ❌ Solo `type` | **CRÍTICA** |

### ALTA — AI Service (resolveCompanyType)

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 22 | `ai/ai.service.ts` | 4750-4772 | `resolveCompanyType()` | Método completo | ❌ Solo lee `type`, nunca `types[]` | **ALTA** |
| 23 | `ai/ai.service.ts` | 4756 | `activeMem?.company?.type` | Active membership type lookup | ❌ Solo `type` | **ALTA** |
| 24 | `ai/ai.service.ts` | 4764 | `user.company?.type` | Direct company type | ❌ Solo `type` | **ALTA** |
| 25 | `ai/ai.service.ts` | 4768 | `m.company?.type` | First membership type | ❌ Solo `type` | **ALTA** |
| 26 | `ai/ai.service.ts` | 4775 | `m.company?.type === 'producer'` | `isProducerMembership` | ✅ `\|\| types.includes()` | OK |
| 27 | `ai/ai.service.ts` | 4810 | `user.company?.type === 'producer'` | Producer company ID resolution | ❌ Solo `type` | **ALTA** |
| 28 | `ai/ai.service.ts` | 4816 | `m.company?.type === 'plant'` | Plant membership check | ✅ `\|\| types.includes()` | OK |
| 29 | `ai/ai.service.ts` | 4835 | `user.company?.type === 'plant'` | Plant company ID resolution | ❌ Solo `type` | **ALTA** |
| 30 | `ai/ai.service.ts` | 4227 | `(freshMembership as any).company?.type` | Switch company response label | ❌ Solo `type` | MEDIA |

### ALTA — WhatsApp Service (daily summary)

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 31 | `whatsapp/whatsapp.service.ts` | 290 | `user.company.type` | Push to companies array | ❌ Solo `type` | **ALTA** |
| 32 | `whatsapp/whatsapp.service.ts` | 292 | `m.company.type` | Membership company type | ❌ Solo `type` | **ALTA** |
| 33 | `whatsapp/whatsapp.service.ts` | 296 | `c.type.includes('producer')` | ⚠️ String.includes() en string! | ❌ BUG — usa .includes() en string, no array | **ALTA — BUG** |
| 34 | `whatsapp/whatsapp.service.ts` | 321 | `c.type.includes('transporter')` | ⚠️ String.includes() en string! | ❌ BUG — misma lógica rota | **ALTA — BUG** |

### MEDIA — WhatsApp Flow & Router

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 35 | `whatsapp/whatsapp-flow.service.ts` | 1102 | `synUser.companyType = 'producer'` | Sets synthetic user type | N/A — asignación | MEDIA |
| 36 | `whatsapp/whatsapp-flow.service.ts` | 1518 | `m.company?.type === 'producer'` | Find producer membership | ✅ `\|\| types.includes()` | OK |
| 37 | `whatsapp/whatsapp-flow.service.ts` | 1532 | `user.company?.type === 'producer'` | Direct company check | ❌ Solo `type` | MEDIA |
| 38 | `whatsapp/whatsapp-router.service.ts` | 1378 | `am.company.types` → `[am.company.type]` | Type resolution con fallback | ✅ Prefiere types | OK |
| 39 | `whatsapp/whatsapp-router.service.ts` | 1385 | `user.company?.type` | Final fallback | ⚠️ Solo `type` en último recurso | BAJA |

### MEDIA — Freights Service (tTypes pattern)

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 40 | `freights/freights.service.ts` | 621-623 | `transport.types` → `[transport.type]` | Assign: validate transporter | ✅ Merge pattern | OK |
| 41 | `freights/freights.service.ts` | 2043-2046 | `transport.types` → `[transport.type]` | AssignMulti: validate transporter | ✅ Merge pattern | OK |
| 42 | `freights/freights.service.ts` | 2258-2261 | `transport.types` → `[transport.type]` | Trip update: validate transporter | ✅ Merge pattern | OK |

### MEDIA — Trucks Controller

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 43 | `trucks/trucks.controller.ts` | 71 | `user.companyType` | JWT claim direct read | ✅ Checks `companyTypes` too | OK |
| 44 | `trucks/trucks.controller.ts` | 72 | `user.companyTypes` | JWT array claim | ✅ Sí | OK |
| 45 | `trucks/trucks.controller.ts` | 119 | `user.companyType === 'plant'` | Plant check for listing | ✅ `\|\| companyTypes.includes()` | OK |

### MEDIA — Plant Access Controller

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 46 | `plant-access/plant-access.controller.ts` | 96 | `c.type` | Response mapping `companyType: c.type` | ❌ Solo `type` en response | BAJA |
| 47 | `plant-access/plant-access.controller.ts` | 166-169 | `producerCompany.types` → `[producerCompany.type]` | Validate producer/transporter | ✅ Merge pattern | OK |

### MEDIA — Admin Controller (CRUD sync)

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 48 | `admin/admin.controller.ts` | 38 | DTO `types?: string[]` | Multi-type input support | ✅ Nuevo campo | OK |
| 49 | `admin/admin.controller.ts` | 434-441 | Sync `type` ↔ `types` | Update: keeps both in sync | ✅ Sync bidireccional | OK |

### BAJA — Prisma Schema & Seed

| # | Archivo | Línea | Lee | Patrón | Fallback types[]? | Criticidad |
|---|---------|-------|-----|--------|-------------------|------------|
| 50 | `prisma/schema.prisma` | 96 | `type CompanyType` | Field definition | N/A — schema | INFO |
| 51 | `prisma/schema.prisma` | 97 | `types Json @default("[]")` | Field definition | N/A — schema | INFO |
| 52 | `prisma/seed.ts` | 19-31 | `type: CompanyType.producer` etc. | Seed data: solo `type` | ⚠️ No setea `types` | BAJA |

### NO NECESITAN CAMBIOS (ya correctos)

| Archivo | Razón |
|---------|-------|
| `freights/freight-state-machine.service.ts` | Recibe `companyType` como string, no accede a Company |
| `common/guards/freight-access.guard.ts` | No lee tipo de empresa, solo IDs de participantes |
| `freights/freights.service.ts` líneas 609, 757, 946, etc. | Delega a `companyRes.hasCompanyType()` / `resolveCompanyType()` que ya maneja dual |
| `catalog.controller.ts` líneas 73, 218, 283 | Delega a `companyRes.hasCompanyType()` |
| `freights/freights.service.ts` líneas 621, 2043, 2258 | Pattern `tTypes` merge ya implementado |
| Todos los archivos `*.spec.ts` | Tests — siguen el patrón del código que testean |

---

## Resumen de gaps

### BUGS activos

| # | Archivo | Línea | Bug |
|---|---------|-------|-----|
| B1 | `whatsapp/whatsapp.service.ts` | 296 | `c.type.includes('producer')` — usa `String.includes()` sobre un string, no un array. Funciona por coincidencia ("producer".includes("producer") === true) pero fallaría con tipos compuestos. Debería leer `types[]`. |
| B2 | `whatsapp/whatsapp.service.ts` | 321 | Mismo bug con `c.type.includes('transporter')` |

### Código que SOLO lee `type` (ignora `types[]`)

| Prioridad | Archivo | Método / Línea | Impacto |
|-----------|---------|----------------|---------|
| 🔴 P0 | `freights/freights.service.ts` | L184: `where: { type: 'plant' }` | Empresa multi-tipo con `type: 'producer'` + `types: ['producer','plant']` NO sería encontrada como planta destino al crear flete |
| 🔴 P0 | `ai/ai.service.ts` | L5009-5012: `producerCo.type !== 'producer'` | Grant producer access rechaza empresas multi-tipo |
| 🟠 P1 | `ai/ai.service.ts` | L4750-4772: `resolveCompanyType()` completo | Todas las herramientas del AI dependen de este método. Una empresa multi-tipo solo muestra el primer type, nunca los types[] |
| 🟠 P1 | `ai/ai.service.ts` | L4810, 4835 | `user.company?.type === 'producer'/'plant'` — resolución de company ID ignora types |
| 🟡 P2 | `whatsapp/whatsapp.service.ts` | L290-292: daily summary | Resumen diario para empresas multi-tipo puede fallar |
| 🟡 P2 | `whatsapp/whatsapp-flow.service.ts` | L1532 | `user.company?.type === 'producer'` sin fallback |
| 🟢 P3 | `plant-access/plant-access.controller.ts` | L96 | Response cosmético `companyType: c.type` |
| 🟢 P3 | `ai/ai.service.ts` | L4227 | Switch company response label |
| 🟢 P3 | `prisma/seed.ts` | L19-31 | Seed no setea `types`, menor impacto |

---

## Recomendación de orden de migración

### Fase 1 — Bugs y P0 (impacto inmediato en producción)

1. **`whatsapp/whatsapp.service.ts:290-321`** — Corregir bug `String.includes()`, leer `types[]` con fallback
2. **`freights/freights.service.ts:184`** — Cambiar `where: { type: 'plant' }` a `OR: [{ type: 'plant' }, { types: { has: 'plant' } }]`
3. **`ai/ai.service.ts:5009-5012`** — Usar `getCompanyTypes()` para validar tipo en grant_producer_access

### Fase 2 — P1 (AI service resolveCompanyType)

4. **`ai/ai.service.ts:4750-4772`** — Reescribir `resolveCompanyType()` para leer `types[]` con fallback a `type`
5. **`ai/ai.service.ts:4810, 4835`** — Usar `isProducerMembership()` / pattern dual en resolución de company IDs

### Fase 3 — P2 (WhatsApp flow)

6. **`whatsapp/whatsapp-flow.service.ts:1532`** — Agregar fallback a `types[]`
7. **`common/build-synthetic-user.ts:32`** — Usar `types[]` antes de fallback a `type`

### Fase 4 — P3 (cosmético / seed)

8. **`plant-access/plant-access.controller.ts:96`** — Retornar `types` o tipo resolved
9. **`ai/ai.service.ts:4227`** — Usar `types[]` para label
10. **`prisma/seed.ts`** — Agregar `types` a seed data

### Fase 5 — Consolidación (futuro)

11. Unificar los dos `getCompanyTypes()` en un único lugar compartido
12. Evaluar deprecar el campo `type` una vez que `types[]` sea autoritativo en toda la base

---

## Archivos que NO necesitan cambios

| Archivo | Razón |
|---------|-------|
| `freights/freight-state-machine.service.ts` | Recibe string, no accede a Company |
| `common/guards/freight-access.guard.ts` | No verifica tipo de empresa |
| `sse/sse.service.ts` | No maneja tipos |
| `notifications/notification.service.ts` | No maneja tipos |
| `database/prisma.service.ts` | No maneja tipos |
| `freights/freights.dto.ts` | DTOs sin referencia a company type |
| `freights/freights.controller.ts` | Delega a service |
| `auth/auth.controller.ts` | Delega a service |
| Todos los `*.spec.ts` | Tests — se actualizan cuando se modifique el código que testean |
