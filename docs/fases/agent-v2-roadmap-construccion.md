# Agent V2 — Roadmap de Construcción

**Fecha:** Mayo 2026
**Estado:** Stage 1 implementado parcialmente. No habilitado en producción. `AGENT_MODE=v2` opt-in.

Este documento es el plan de construcción del agente WhatsApp orquestado con LangGraph (`src/agent-v2`). Complementa:
- `docs/agent-v2.md` — arquitectura.
- `docs/wpp ajuste/audit-v1-vs-v2.md` — comparación con legacy.

---

## Clasificación

- 🔴 **BLOCKER** — sin esto no se puede prender `AGENT_MODE=v2` en producción.
- 🟠 **CRÍTICO** — degrada la experiencia o bloquea Stage 2.
- 🟡 **IMPORTANTE** — mejora notable, no bloquea.
- 🔵 **DESEABLE** — calidad de plataforma.
- ⚪ **FUTURO** — diferido explícitamente hasta apagar legacy.

## Estado del módulo (snapshot)

| Componente | Archivo | Estado |
|---|---|---|
| `create_freight` flow | `flows/create-freight.flow.ts`, `graphs/freight.graph.ts` | ✅ Implementado |
| `query_freights` flow | `flows/query-freights.flow.ts` | ✅ Implementado (read-only, heurísticas) |
| `location_map` flow | `flows/location-map.flow.ts` + `agent-v2.service.handleLocation` | 🟡 Lógica embebida en service, falta extraer a node/tool |
| `assign_transport_company` | `flows/assign-transport-company.flow.ts` | ❌ Stub `pending_stage_2` |
| `assign_driver_and_truck` | `flows/assign-driver-truck.flow.ts` | ❌ Stub |
| `confirm_loaded` | `flows/confirm-loaded.flow.ts` | ❌ Stub |
| `finish_freight` | `flows/finish-freight.flow.ts` | ❌ Stub |
| `cancel_freight` | `flows/cancel-freight.flow.ts` | ❌ Stub |
| `attach_document` | `flows/document-attach.flow.ts` | ❌ Stub |
| Graphs `company`, `document`, `driver-trip`, `location` | `graphs/*.graph.ts` | ❌ Placeholders (export string) |
| Tools `company`, `document`, `location`, `notification` | `tools/*.tools.ts` | ❌ Clases `@Injectable()` vacías |
| `freight-state-policy` | `policies/freight-state-policy.ts` | 🟡 Existe, no se llama desde `check-policy.node.ts` |
| Tests | `__tests__/agent-v2.spec.ts` | 🟡 6 unitarios, 0 E2E del grafo |

---

## FASE 0 — Listo para encender V2

Objetivo: `AGENT_MODE=v2` activable en producción para los flujos hoy implementados sin riesgo de doble-create ni flujos atascados.

### 🔴 0.1 Race en checkpoint de sesión
**Problema:** `WhatsAppSessionCheckpointStore.save` y `AgentV2Service.saveCheckpointPatch` hacen `findUnique` + `update` sin lock optimista. Dos webhooks concurrentes del mismo phone pisan estado (Meta retry + reply rápido lo reproduce).
**Solución:** agregar `flowStateVersion` (int) en `WhatsAppSession` y persistir con `updateMany where: { id, flowStateVersion: prev }`. Si `count===0`, recargar y reintentar 1 vez; si vuelve a fallar, abortar el turno con mensaje "estoy procesando otro mensaje, esperá".
**Esfuerzo:** 1 día.

### 🔴 0.2 Idempotencia end-to-end de `create_freight`
**Problema:** `prepareConfirmation` genera `idempotencyKey` y se pasa a `freights.create` via `as any`, pero `FreightsService.create` no lo lee. Combinado con 0.1, hay riesgo de doble create.
**Solución:**
- Tabla `agent_action_lock(key text primary key, freight_id text, created_at timestamptz)`.
- En `freight.tools.ts` antes de `freights.create`: `INSERT ... ON CONFLICT DO NOTHING`. Si conflicta, retornar el `freightId` previo.
- Alternativa: cambiar la firma de `FreightsService.create` para aceptar `idempotencyKey`.
**Esfuerzo:** 1-2 días.

### 🔴 0.3 Comando global de salida del flujo
**Problema:** `detectIntentNode` fuerza `currentIntent='create_freight'` mientras hay flow activo. "cancelar"/"salir"/"menu" durante `awaiting_slot` se guarda como valor de slot. El helper `isGlobalCancelMessage` ya existe pero no está integrado al grafo.
**Solución:** en `detectIntentNode`, si `isGlobalCancelMessage(state.lastUserMessage)` → setear `currentIntent='cancel_pending'`. En `routeIntent`, mapear a `cancelPendingActionNode`. Test: `"cancelar"` durante `awaiting_slot` y durante `awaiting_location` debe limpiar estado.
**Esfuerzo:** 0.5 día.

### 🔴 0.4 Timeout en cliente Gemini
**Problema:** `extract-slots.node.ts` no aplica timeout. Si Gemini cuelga, el webhook se cuelga, Meta reintenta y dispara la race del 0.1.
**Solución:** envolver `gemini.sendMessage` con `AbortController` (6s). Log estructurado de timeout. Fallback a heurísticas.
**Esfuerzo:** 0.5 día.

### 🟠 0.5 Tests E2E del grafo
**Problema:** sólo hay 6 tests unitarios. No se invoca `buildMainGraph().invoke(state)`. Cualquier refactor de Stage 2 va a ciegas.
**Solución:** harness con mocks de Gemini y `freightTools`. Cubrir: happy path create, falta de slot, falta de location origen y destino, cancel mid-flow, confirmación ambigua, query list, query detalle, intent unsupported.
**Esfuerzo:** 1-2 días.

### 🟠 0.6 Limpieza de DI vacía
**Problema:** `AgentV2CompanyTools`, `AgentV2DocumentTools`, `AgentV2LocationTools`, `AgentV2NotificationTools` están registrados en el module pero son clases vacías.
**Solución:** sacar del `agent-v2.module.ts` hasta que se implementen. Dejar el archivo o eliminarlo según preferencia.
**Esfuerzo:** 0.25 día.

**Salida de Fase 0:** `AGENT_MODE=v2` en staging por 1 semana sin doble create ni flujos atascados, con telemetría básica (start/done/paused).

---

## FASE 1 — Calidad conversacional

Objetivo: el usuario percibe el agente como utilizable sin entrenamiento previo.

### 🟠 1.1 Aflojar regex de confirmación
**Problema:** `^(si|sí|ok|dale|...)$` rechaza "si dale", "no, mejor cancelar".
**Solución:** `\b(si|sí|ok|dale|confirmo|va)\b` y `\b(no|cancelar|cancela|anular)\b`. Tests con cadenas mixtas.
**Esfuerzo:** 0.25 día.

### 🟠 1.2 Heurística `create_freight` sin falsos positivos
**Problema:** `para .*soja|.*maiz|.*trigo` matchea "gracias por la soja".
**Solución:** exigir verbo (`necesito|quiero|pedir|solicitar|crear`) **y** sustantivo de carga, o presencia explícita de `camion(es)|flete`.
**Esfuerzo:** 0.5 día.

### 🟠 1.3 Merge LLM/heurística sin sobreescribir con vacíos
**Problema:** `extract-slots.node.ts:32-36` hace `{...heuristicSlots, ...llmSlots}`; el LLM puede devolver `null` y pisar valores buenos.
**Solución:** filtrar entries con `v != null && v !== ''` antes de mergear.
**Esfuerzo:** 0.25 día.

### 🟠 1.4 Snapshot del flag real-create al confirmar
**Problema:** `AGENT_V2_ENABLE_REAL_FREIGHT_CREATE` se evalúa en `executeAction`. Si se flipea entre confirmar y ejecutar, el resumen al usuario miente.
**Solución:** capturar el flag dentro de `pendingAction.payload.realExecution` en `prepareConfirmation`. `executeAction` lee desde el payload, no del env.
**Esfuerzo:** 0.5 día.

### 🟡 1.5 Telemetría por intent
**Problema:** los 11 intents no implementados caen en `unsupported()` sin métrica.
**Solución:** logger estructurado + Sentry breadcrumbs con `intent_unsupported`, `gemini_timeout`, `policy_denied`, `confirmation_unclear`.
**Esfuerzo:** 0.5 día.

### 🟡 1.6 Schema de location con cap de label
**Problema:** `LocationSchema.label` sin cota; WhatsApp puede mandar texto arbitrario que va a logs y persistencia.
**Solución:** `z.string().max(200).optional()`.
**Esfuerzo:** 0.1 día.

### 🟡 1.7 Eliminar rama dead en renderResponse
**Problema:** `render-response.node.ts:9-11` tiene dos returns idénticos.
**Solución:** dejar un solo fallback.
**Esfuerzo:** 0.1 día.

**Salida de Fase 1:** tasa de fallback a `unsupported()` < 10% sobre intents reconocidos en QA. Confirmaciones ambiguas < 5%.

---

## FASE 2 — Stage 2: flujos mutativos críticos

Objetivo: paridad funcional con legacy en los flujos de operación. Orden por valor/esfuerzo.

Para cada flujo: flow file real, integración en `runSubgraph`, llamada a `freight-state-policy` desde `check-policy.node.ts`, renderer-strings, mínimo 3 unitarios + 1 E2E, tool con auditoría.

### 🟠 2.1 `assign_transport_company`
**Slots:** `freightCode`, `transportCompany` (resolución por nombre/alias contra empresas vinculadas).
**Policy:** estado del flete en `pending_assignment|assigned`. Rol `gerente|admin|operador`.
**Tool:** `freightTools.assignTransport(freightId, companyId, user)`.
**Esfuerzo:** 2 días.

### 🟠 2.2 `assign_driver_and_truck` (depende de 2.1)
**Slots:** `freightCode`, `driver` (matching por nombre/cedula), `truck` (matching por patente).
**Policy:** estado en `assigned|accepted`. Rol gerente/admin.
**Tool:** `freightTools.assignDriverTruck(...)` con join a `truck` y `user(role=chofer)`.
**Esfuerzo:** 2 días.

### 🟠 2.3 `confirm_loaded`
**Slots:** `freightCode` (o `activeFreightCode` del session si hay).
**Policy:** estado en `in_progress|accepted`. Rol chofer (o gerente delegando).
**Tool:** `freightTools.confirmLoaded(freightId, user)` con idempotencia por `(freightId, action)`.
**Esfuerzo:** 1.5 días.

### 🟠 2.4 `finish_freight`
**Slots:** `freightCode`.
**Policy:** estado en `loaded|in_progress`. Rol chofer/operador.
**Idempotencia crítica:** un retry de Meta no debe finalizar dos veces.
**Esfuerzo:** 1.5 días.

### 🟠 2.5 `cancel_freight`
**Slots:** `freightCode`, `reason` (texto libre, mínimo 5 chars).
**Policy:** estado en `draft|pending_assignment|assigned|accepted|in_progress`. Rol gerente/admin.
**UX:** doble confirmación obligatoria (`sensitive=true` ya marcado en catálogo).
**Esfuerzo:** 1.5 días.

**Salida de Fase 2:** los 5 flujos mutativos en paridad con legacy, con tests E2E.

---

## FASE 3 — Multimedia y ubicaciones avanzadas

### 🟡 3.1 `attach_document` (`document.graph` real)
**Reuso:** `OcrModule`, `WeighTicketsModule`.
**Tool:** `documentTools.attach(freightId, mediaId, type, user)`.
**Esfuerzo:** 3 días.

### 🟡 3.2 `share_map` / `generate_map_link` (`location.graph` real)
**Reuso:** `freight-locations.service`, slug picker existente.
**Tool:** `locationTools.generateLink(freightId, purpose, user)` → URL del picker.
**Esfuerzo:** 2 días.

### 🟡 3.3 Extraer `handleLocation` a node + tool
**Problema:** la lógica de capturar ubicación de WhatsApp vive en `agent-v2.service.ts`, no en un node del grafo.
**Solución:** crear `nodes/capture-location.node.ts` invocable desde `freight.graph` + `location.graph`.
**Esfuerzo:** 1 día.

---

## FASE 4 — Robustez de plataforma

### 🔵 4.1 Checkpointer nativo de LangGraph
**Problema:** `WhatsAppSessionCheckpointStore` es ad-hoc. La abstracción `AgentCheckpointStore` ya existe.
**Solución:** migrar a `PostgresSaver` o `RedisSaver`. Mantener compatibilidad de lectura con `flowState.agentV2` durante la migración.
**Esfuerzo:** 3 días.

### 🔵 4.2 Multi-instance ready
**Problema:** `phoneLocks` en `WhatsAppRouterService` es Map en memoria. Si Railway escala, ya no serializa por phone.
**Solución:** reusar `acquirePgLockWithWait` por `phone:<n>`. Documentar el contrato.
**Esfuerzo:** 2 días.

### 🔵 4.3 Streaming de respuestas largas
**Problema:** la lista de fletes se envía como un único bloque de texto. Para >10 fletes el mensaje queda largo.
**Solución:** secuenciar mensajes con paginación o lista interactiva de WhatsApp.
**Esfuerzo:** 2 días.

### 🔵 4.4 Observability fina
**Problema:** no hay tracing por `conversationId`.
**Solución:** OTel spans por node, métricas `policy_denied`, `tool_error`, `confirmation_timeout`, `flow_duration_p95` por flujo.
**Esfuerzo:** 3 días.

---

## FASE 5 — Apagar legacy

### ⚪ 5.1 Default `AGENT_MODE=v2` en producción
**Pre-requisito:** Fase 2 completa, 2 semanas en staging, KPIs verdes.
**Esfuerzo:** 0.5 día (cambiar default + monitoreo).

### ⚪ 5.2 Borrar `src/ai/agent.service.ts` y referencias
**Pre-requisito:** 2 semanas con `v2` en producción sin rollback.
**Esfuerzo:** 1 día.

### ⚪ 5.3 Consolidar namespace de `flowState`
**Problema:** `flowState.aiHistory` (legacy) y `flowState.agentV2` conviven. Tras apagar legacy, eliminar `aiHistory`.
**Esfuerzo:** 0.5 día + migración de datos.

---

## Resumen de esfuerzo

| Fase | Esfuerzo (sprints de 1 dev) |
|---|---|
| Fase 0 | 1-2 sprints |
| Fase 1 | 1 sprint |
| Fase 2 | 2-3 sprints |
| Fase 3 | 1-2 sprints |
| Fase 4 | 1-2 sprints |
| Fase 5 | 0.5 sprint |
| **Total** | **6.5-10.5 sprints** |

## Criterios de salida globales

- Cobertura de tests E2E sobre el grafo ≥ 80% de paths.
- Tasa de `unsupported` < 5% sobre intents reconocidos en QA.
- 0 incidentes de doble-create en 4 semanas con `AGENT_MODE=v2`.
- p95 de duración por turno < 4s (incluyendo Gemini).
- Auditoría completa: cada acción mutativa deja registro en `auditLog` con `idempotencyKey` y `actionId`.
