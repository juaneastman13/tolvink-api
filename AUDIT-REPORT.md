# Tolvink — Reporte de Auditoría
**Fecha:** 2026-03-21
**Tipo:** Solo lectura — sin correcciones aplicadas

## Resumen

| Área | Estado | Hallazgos |
|------|--------|-----------|
| Build | ✅ | Backend y frontend compilan sin errores (TS6059 preexistentes en scripts/, no bloquean) |
| Schema | ✅ | Prisma validate OK, 34 modelos, 12 enums, 113 índices |
| Runtime errors | 5 hallazgos | `throw new Error` en AI tools (causan 500 en vez de 4xx), 1 TODO pendiente en freights.service |
| Assign flow | ✅ | Flujo robusto con CONSULTA check, truckId validación, bothConsulta auto-complete |
| my-access | ✅ | Endpoint sin parámetros, usa `@CurrentUser()`. Sin bug activo detectado |
| Notificaciones | ✅ | `notifyAllParticipants` incluye producerCompanyId. Cobertura amplia (assign, status, cancel, etc.) |
| SSE | ✅ | Límites globales + por company, backoff en frontend, cleanup en reconexión |
| WhatsApp/AI | ✅ | CONSULTA_BLOCKED_TOOLS completo (22 tools), frases prohibidas correctamente inyectadas |
| Accesos frontend | ⚠️ | `useAccessLevel` solo en DetailScreen + AppLayout. HomeScreen, ListScreen, NewScreen sin hook |
| Navegación/UX | ⚠️ | 8 screens sin loading state, 33 empty states (buena cobertura) |
| Estilos | ⚠️ | 37 className usages (solo tv-card y Landing), borderRadius inconsistente (10 variantes) |
| Wizard | ✅ | NewScreen 1459 líneas, CONSULTA/transport step bien integrado |
| Documentos/OCR | ✅ | OCR edit con historia, badges "Editado", rename/delete funcional |
| Seguridad | 2 issues | localStorage legacy token cleanup, endpoints sin @Roles explícito en 7 controllers |
| Performance | 8 issues | 15+ N+1 potenciales en AI tools, 15+ findMany sin paginación, archivos >1000 líneas |
| Tests | 201/245 pasan | 44 fallan (freights.service.spec), 16 módulos sin tests |
| Consistencia datos | ⚠️ | Dual model (PlantProducerAccess + CompanyAccess) en 8+ archivos, 26 refs legacy |

## Hallazgos clasificados

### 🔴 CRÍTICO (bloquea funcionalidad)

1. **44 tests fallan** — `src/freights/freights.service.spec.ts` — Tests de `addDocument` y otros fallan con `ForbiddenException: No tiene acceso a este flete`. Los fixtures de test no incluyen `participantCompanyIds` ni `assignments` actualizados tras cambios en `resolveAllCompanyIds`. Esto indica que los tests no reflejan el estado actual del modelo de acceso.

### 🟠 ALTO (funcionalidad degradada)

1. **`throw new Error` en AI tools** — `src/ai/tools/freight-action-tools.service.ts:952,958,970,1082,1087` — 5 instancias de `throw new Error()` que causan HTTP 500 en producción en vez de respuestas controladas 400/403/404. Deberían ser `BadRequestException`/`ForbiddenException`.

2. **useAccessLevel no usado en HomeScreen, ListScreen, NewScreen** — Estas pantallas no verifican nivel de acceso CONSULTA del usuario. Un usuario CONSULTA podría ver botones de acciones que luego fallan en el backend.
   - `src/screens/HomeScreen.jsx` — 0 usos
   - `src/screens/ListScreen.jsx` — 0 usos
   - `src/screens/NewScreen.jsx` — 0 usos

3. **16 módulos sin tests** — admin, ai, analytics, company-access, conversations, database, fields, health, notifications, ocr, plant-access, shared-links, sse, trucks, web-chat, whatsapp — Sin cobertura de tests unitarios.

4. **Endpoints sin @Roles explícito** — Varios controllers tienen endpoints sin guards explícitos:
   - `admin.controller.ts` — 31 endpoints, 7 guards
   - `conversations.controller.ts` — 9 endpoints, 5 guards
   - `freight-public.controller.ts` — 4 endpoints, 1 guard
   - `freight-tracking.controller.ts` — 4 endpoints, 1 guard
   - `notification.controller.ts` — 5 endpoints, 3 guards
   - `catalog.controller.ts` — 5 endpoints, 2 guards

   **Nota**: Algunos de estos endpoints podrían estar protegidos a nivel de clase con `@UseGuards(JwtAuthGuard)` o mediante el guard global `ThrottlerGuard`. Verificar manualmente.

### 🟡 MEDIO (UX afectada o deuda técnica)

1. **N+1 queries potenciales en AI tools** — 15+ instancias de `await` dentro de loops en services de AI (prompt-builder, freight-action-tools, freight-query-tools, location-tools). Impacto en latencia de respuesta del agente AI.

2. **findMany sin paginación** — 15+ queries `findMany` sin `take`/`skip` en AI tools y servicios. Riesgo de lentitud con datos crecientes:
   - `ai.service.ts:518` — companyAccess.findMany
   - `admin-tools.service.ts:461,480` — plantProducerAccess.findMany
   - `freight-action-tools.service.ts:291,297,505,1680,1714` — varios findMany
   - `freight-query-tools.service.ts:431,672` — freight.findMany, field.findMany
   - `transport-tools.service.ts:126,509` — freightAssignment.findMany, truck.findMany

3. **Archivos muy grandes** — Dificultan mantenimiento:
   - `freights.service.ts` — 3765 líneas
   - `whatsapp-router.service.ts` — 1883 líneas
   - `freight-action-tools.service.ts` — 1856 líneas
   - `admin.controller.ts` — 1552 líneas
   - `fields.service.ts` — 1188 líneas

4. **Dual data model sin plan de migración** — `PlantProducerAccess` (26 refs en 8 archivos) coexiste con `CompanyAccess` (61 refs). El endpoint `unified` los fusiona, pero la lógica de negocio todavía consulta ambas tablas independientemente en AI tools, catalog, y plant-access controller.

5. **8 screens sin loading state** — CalendarScreen, CompanyHeaderPicker, EditScreen, MenuScreen, MyDataScreen, NotificationsScreen, PickLocationScreen, ViewMapScreen.

6. **borderRadius inconsistente** — 10 variantes diferentes usadas en screens (3, 4, 6, 7, 8, 10, 12, 14, etc.). No hay tokens de diseño para border radius.

7. **TODO pendiente en código** — `src/freights/freights.service.ts:28` — "TODO: Add AI conversation cache invalidation after assignment changes". Cache stale posible.

### 🔵 BAJO (mejora, cleanup, nice-to-have)

1. **localStorage cleanup de tokens legacy** — `src/api.js:23-24` — `clearAuth()` aún elimina `tolvink_token` y `tolvink_refresh_token` de localStorage. Es cleanup de migración a HttpOnly cookies, pero ya no deberían existir en producción. Código muerto.

2. **37 className usages en screens** — Principalmente `tv-card` en AdminScreen y clases en LandingScreen. No es un problema pero rompe el patrón de inline styles.

3. **console.log de debug** — 0 encontrados en producción (limpio).

4. **API keys en código** — 0 encontradas (correcto, todo en env vars).

5. **Raw SQL queries** — 0 encontradas (todo via Prisma ORM).

6. **Rate limiting** — Bien configurado: auth (3-10/min), admin (5/min), analytics (30/min), SSE (10/min). ThrottlerGuard global activo.

### ℹ️ INFO (observaciones sin acción inmediata)

1. **Schema válido** — 34 modelos, 12 enums, Prisma validate pasa. Plant-centric fields correctamente indexados (`ownerCompanyId`, `producerCompanyId`).

2. **113 índices en DB** — Cobertura amplia incluyendo índices compuestos para queries frecuentes (status+companyId+loadDate, GIN para participantCompanyIds).

3. **SSE bien implementado** — Límites globales (MAX_CLIENTS_GLOBAL) y por company, eviction de conexiones antiguas, backoff exponencial en frontend, ticket-based auth (no JWT en URL).

4. **CONSULTA blocking robusto** — 22 herramientas bloqueadas para usuarios READONLY, sistema de doble capa (Strategy A: pre-check + Strategy B: prompt injection), sin frases técnicas expuestas al usuario.

5. **OCR editing funcional** — History tracking (max 10 snapshots), edit metadata, audit log. Endpoints `ocr-edit`, `ocr-clear` con guards.

6. **Frontend 81 archivos .jsx, 14 .js** — ~26,700 líneas de código.

7. **Frontend build limpio** — Vite build sin warnings ni errores. Bundle sizes razonables (main ~176KB gzipped ~47KB).

8. **Env vars usadas** — 8 variables únicas en backend (JWT_SECRET, DATABASE_URL, etc.).

## Métricas del proyecto

- Archivos backend (.ts): 97
- Archivos frontend (.jsx/.js): 95
- Líneas de código backend: ~32,400
- Líneas de código frontend: ~26,700
- Líneas de código totales: ~59,100
- Endpoints registrados: 183
- Tests totales: 245 (201 pasan, 44 fallan)
- Módulos sin tests: 16
- Índices en DB: 113
- Modelos Prisma: 34
- Enums Prisma: 12
- Variables de entorno usadas: 8
