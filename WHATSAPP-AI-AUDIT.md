# Auditoría Estructural: Módulo WhatsApp + AI

> Fecha: 2026-03-13 | Versión: 1.0 | Solo diagnóstico — sin cambios en código

---

## 1. FLUJO DE MENSAJES — Diagrama completo

```
  Meta Webhook (POST /whatsapp/webhook)
         │
         ▼
  ┌──────────────────────────────────┐
  │  WhatsAppController.receive()    │
  │  ─ Verifica HMAC-SHA256          │
  │  ─ Responde 200 inmediato       │
  │  ─ Deduplicación (Map, 1 min)   │
  │  ─ Parsea tipo de mensaje       │
  │  ─ Log inbound (fire-and-forget)│
  └──────────┬───────────────────────┘
             │
             ▼
  ┌──────────────────────────────────┐
  │  WhatsAppRouterService           │
  │  .handleMessage(phone,type,…)    │
  │  ─ Serializa por phone (lock)   │
  │  ─ Rate limit (30 msg/min)      │
  └──────────┬───────────────────────┘
             │
             ▼
  ┌──────────────────────────────────┐
  │  _handleMessage()                │
  │  1. markRead (fire-and-forget)   │
  │  2. findUserByPhone()            │
  │     └─ No encontrado → "no      │
  │        registrado" (cooldown)    │
  │  3. Carga sesión (findFirst)     │
  │  4. Multi-company check          │
  │     └─ No confirmada →           │
  │        sendCompanySelectionList   │
  │        (guarda _pendingMessage)  │
  └──────────┬───────────────────────┘
             │
     ┌───────┴───────────┐
     │ ¿session.flowType? │
     └───┬───────────┬───┘
         │ SÍ        │ NO
         ▼           ▼
  ┌──────────┐  ┌────────────────────────────┐
  │ FlowSvc  │  │ Route by message type      │
  │ .continue│  │                            │
  │ Flow()   │  │ text     → handleText()    │
  │          │  │ button   → handleButtonReply│
  │ (reject, │  │ list     → handleListReply  │
  │  confirm,│  │ location → handleLocation   │
  │  cancel, │  │ audio    → handleAudio      │
  │  create) │  │ image/doc→ handleMedia      │
  └──────────┘  │ otro     → "no soportado"  │
                └───────────┬────────────────┘
                            │
                ┌───────────┴──────────┐
                │ handleText() decide: │
                │                      │
                │ 1. Selección activa? │
                │    → resolve reply   │
                │ 2. Código de flete?  │
                │    → showFreightByCode│
                │ 3. Greeting/menu?    │
                │    → showMainMenu    │
                │ 4. Emoji/corto?      │
                │    → menu o AI       │
                │ 5. Otro texto        │
                │    → handleAiChat()  │
                └──────────┬───────────┘
                           │
                           ▼
  ┌──────────────────────────────────────┐
  │  handleAiChat()                      │
  │  ─ Crea/reusa sesión (flowType=null) │
  │  ─ Typing indicator                  │
  │  ─ ai.chat(phone, text, user, sess)  │
  │     └─ Claude API + tool loop        │
  │        (max 5 iteraciones, 90s)      │
  │  ─ Procesa _pendingSelection         │
  │  ─ Split si >4000 chars              │
  │  ─ Envía respuesta (text/buttons)    │
  └──────────────────────────────────────┘
```

### Mensajes que caen en limbo

| Escenario | Qué pasa | Impacto |
|-----------|----------|---------|
| `type === 'sticker'` | Cae en `default` → "Actualmente se procesan mensajes de texto…" | Bajo — feedback correcto |
| `type === 'contacts'` | Idem | Bajo |
| `type === 'interactive'` pero no `button_reply` ni `list_reply` | Controller.parseMessage devuelve `{type:'text', payload:{body:''}}` → handleText recibe string vacío → retorna silenciosamente | **P2** — mensaje perdido sin feedback |
| Mensaje con `context.forwarded` + `type !== 'text'` | Forwarded flag se ignora para audio/image/document | Bajo — no afecta funcionalidad |
| `type === 'reaction'` (emoji reaction a un mensaje) | No parseado por parseMessage → `{type:'reaction', payload:{body:''}}` → cae en default del router | Bajo |

---

## 2. GESTIÓN DE CONTEXTO

### Almacenamiento de contexto

| Mecanismo | Dónde | TTL | Qué almacena |
|-----------|-------|-----|--------------|
| `flowState.aiMessages` | WhatsAppSession.flowState (JSON) | 30 min (sesión) | Historial completo de mensajes Claude (user/assistant/tool_result) |
| `flowState.activeContext` | Idem | Sesión | `lastFreightCode`, `lastFreightSummary`, `lastAction`, `lastSearchFilter` |
| `flowState.pendingAction` | Idem | Sesión | Acción staged pendiente de confirmación |
| `flowState.pendingDocument` | Idem | Sesión | Archivo subido pendiente de adjuntar |
| `flowState.pendingFreight` | Idem | Sesión | Datos de flete en construcción |
| `flowState.selectedCompanyId` | Idem | Sesión | Empresa activa en WhatsApp (scoped) |
| `flowState.lastLocation` | Idem | Sesión | Última ubicación compartida |
| `flowState.lastMessageAt` | Idem | Sesión | Timestamp del último mensaje |

### System prompt — datos del usuario incluidos

Al momento de responder, Claude recibe:
- **Nombre** del usuario (solo primer nombre)
- **companyType** resuelto (producer, plant, transporter, o combinación)
- **Fecha actual** (Uruguay UTC-3)
- **hasInternalFleet** de la empresa activa
- **Cantidad de memberships** y empresa activa (nombre)
- **Rol** (chofer, admin, gerente, operario)
- **activeContext** inyectado en el mensaje del usuario (no en system prompt)

### Lo que **NO** se incluye en el system prompt

| Dato faltante | Impacto |
|---------------|---------|
| **Fletes recientes/activos** del usuario | **P1** — El bot no sabe qué fletes tiene el usuario sin llamar a una tool. No puede responder proactivamente. |
| **Nombre de la empresa activa** | Se incluye solo si multi-company |
| **Historial de acciones recientes** | Parcial — `activeContext.lastAction` sobrevive trim, pero no se incluye en system prompt |
| **Plantas habilitadas** | No — requiere tool call |
| **Camiones/choferes disponibles** | No — requiere tool call |

### Historial de conversación

- **Máximo**: 25 mensajes (`MAX_HISTORY`)
- **Trimming**: `smartTrimHistory()` corta los más antiguos, evita empezar con `tool_result` huérfano
- **Compresión**: tool_results > 800 chars se truncan si no están en los últimos 8 mensajes
- **Stale detection**: si > 10 min sin mensaje, inyecta nota `[Sistema: pasaron X min...]`

### Pérdida de contexto al expirar sesión

Cuando la sesión expira (30 min inactividad):
1. Se elimina la sesión completa (cleanup cada 30 min, borra 2h post-expiración)
2. **TODO el contexto se pierde**: historial, activeContext, pendingFreight, pendingDocument
3. El siguiente mensaje crea una sesión nueva con `flowState: {}`
4. **No hay mecanismo de resumen o carry-over** del contexto anterior

**P1** — Un usuario que pausa 31 minutos pierde toda la conversación. Si estaba a mitad de crear un flete, pierde todo el progreso sin aviso.

---

## 3. RESOLUCIÓN DE IDENTIDAD

### Flujo de identificación

```
phone → findUserByPhone()
         │
         ├─ Normaliza: +598XXXXXXX → 598XXXXXXX
         ├─ Busca con 3 variantes: 598X, +598X, 0X
         ├─ Filtra: active: true
         ├─ Include: company, memberships (active)
         │
         └─ Resultado: user con company + memberships[]
```

### Multi-empresa

| Aspecto | Implementación | Estado |
|---------|---------------|--------|
| Detección multi-empresa | `activeMemberships.length > 1` | OK |
| Selección de empresa | Interactive list al inicio de sesión | OK |
| Persistencia de selección | `flowState.selectedCompanyId` (session-scoped) | OK |
| No desincroniza web | Correcto — no modifica `activeCompanyId` en DB | OK |
| Cambio mid-session | `switch_company` tool — limpia contexto AI | OK |
| Validación de membership | Re-verifica al aplicar selectedCompanyId | OK |

### Problemas de identidad

| Problema | Detalle | Severidad |
|----------|---------|-----------|
| **Rol se resuelve del user.role, no de membership.role** | `buildSystemPrompt` usa `user.role` para determinar si es chofer. Si un usuario es admin en empresa A y chofer en empresa B, su rol se congela como admin independientemente de la empresa activa. | **P0** |
| **companyType se resuelve correctamente desde activeCompanyId** | `resolveCompanyType()` busca la membership de `activeCompanyId` — esto está bien | OK |
| **isChofer no considera empresa activa** | Línea ~477: `user.role === 'chofer' || memberships.some(m => m.role === 'chofer')` — si CUALQUIER membership es chofer, se asume chofer global, ignorando la empresa activa | **P0** |
| **Tool filtering usa el mismo isChofer roto** | `getFilteredTools()` línea ~743 replica la misma lógica | **P0** |

---

## 4. SYSTEM PROMPT — Análisis

### Fortalezas

- Instrucciones claras de identidad ("Capataz digital")
- Anti-alucinación explícito
- Manejo de emojis controlado
- Patrón de 2 etapas para acciones destructivas (prepare → confirm)
- Restricciones por rol bien detalladas
- Búsqueda proactiva explícita ("NUNCA pedir código si se puede buscar")
- Terminología correcta para Uruguay

### Problemas encontrados

| # | Problema | Detalle | Sev |
|---|----------|---------|-----|
| 1 | **Rol estático en prompt** | El prompt dice `ROL PRODUCTOR (admin)` pero el rol viene de `user.role`, no de la membership activa. Un usuario admin en producción pero operario en transporte obtiene permisos de admin en ambas. | **P0** |
| 2 | **Prompt no lista explícitamente qué NO puede hacer cada rol** | Solo dice qué puede hacer. El chofer tiene restricciones explícitas, pero producer/plant/transporter no tienen una lista de prohibiciones. Un productor podría pedir acciones de planta si el prompt no lo restringe bien. | **P1** |
| 3 | **"Flota propia" — instrucción ambigua** | El prompt dice "Preguntar siempre: ¿Desea usar su flota propia o que la planta asigne?" pero no indica cuándo NO preguntar (ej: si la empresa no tiene `hasInternalFleet`). La condición `hasOwnFleet` ya filtra esto, pero si falla, el prompt no tiene fallback. | **P2** |
| 4 | **Prompt muy largo** | ~3800 chars de system prompt. Muchas instrucciones redundantes o que podrían ser reglas implícitas en las tool descriptions. Riesgo de que Claude ignore instrucciones al final por longitud. | **P2** |
| 5 | **Instrucciones contradictorias sobre listas** | "NUNCA enviar opciones como texto plano" vs la realidad de que tools como `summarize_freights` devuelven texto plano que Claude reformatea. | **P2** |
| 6 | **Saludo con menú vs saludo con AI** | El router intercepta greetings y muestra menú hardcoded ANTES de llegar a la AI. El system prompt dice cómo manejar saludos, pero el código nunca deja que Claude los procese. No es bug, pero es inconsistencia. | **P2** |
| 7 | **No hay instrucción para "no sé"** | El prompt no dice qué hacer cuando Claude no puede determinar la intención del usuario. Debería instruir a mostrar opciones contextuales. | **P2** |

---

## 5. TOOL DEFINITIONS — Inventario completo

### Tabla de 63 tools

| # | Tool | Tipo | Roles | Validación | Gaps |
|---|------|------|-------|------------|------|
| 1 | `list_freights` | Read | Core | status, dateFrom, dateTo, grain | OK |
| 2 | `get_freight_detail` | Read | Core | code (obligatorio) | OK — resuelve acceso correctamente |
| 3 | `search_plants` | Read | Producer | query (opcional) | Fuzzy funciona. **Gap**: no busca por nombre de sucursal, solo por empresa |
| 4 | `list_lots` | Read | Producer | fieldId (opcional) | OK |
| 5 | `list_fields` | Read | Producer | — | OK |
| 6 | `prepare_freight` | Stage | Producer | grain, tons, loadDate, loadTime obligatorios | Buena auto-resolución de nombres. **Gap**: no valida si fecha es pasada |
| 7 | `confirm_create_freight` | Mutate | Producer | Lee pendingFreight de sesión | OK — 2 etapas |
| 8 | `confirm_action` | Mutate | Core | Lee pendingAction de sesión | OK — genérico para todas las staged actions |
| 9 | `accept_freight` | Mutate | Transp/Chofer | code obligatorio | OK |
| 10 | `reject_freight` | Stage | Transp/Chofer | code, reason obligatorios | OK |
| 11 | `start_freight` | Mutate | Transp/Chofer | code obligatorio | OK |
| 12 | `confirm_loaded` | Mutate | Transp/Prod | code, loadedTons | OK |
| 13 | `confirm_finished` | Mutate | Transp/Plant | code | OK |
| 14 | `cancel_freight` | Stage | Prod/Plant | code, reason obligatorios | OK |
| 15 | `create_field` | Stage | Producer | name, address obligatorios | OK — usa lastLocation |
| 16 | `create_lot` | Stage | Producer | fieldId, name obligatorios | OK |
| 17 | `list_trucks` | Read | Prod/Transp/Plant | — | OK |
| 18 | `create_truck` | Stage | Prod/Transp | plate, model obligatorios | OK |
| 19 | `create_user` | Stage | Admin | name, email, role, phone | OK |
| 20 | `attach_document` | Mutate | Todos | code, pendingDocument en sesión | OK |
| 21 | `generate_location_link` | Read | Producer | purpose | OK — genera link al mapa |
| 22 | `generate_tracking_link` | Read | Todos | code | OK — signed token |
| 23 | `generate_map_link` | Read | Todos | code | OK |
| 24 | `generate_report_link` | Read | Todos | code | OK |
| 25 | `generate_daily_map_link` | Read | Todos | — | OK |
| 26 | `share_live_location` | Read | Chofer/Transp | code | OK |
| 27 | `view_live_locations` | Read | Todos | code | OK |
| 28 | `request_location` | Mutate | Todos | code | **Gap**: envía WhatsApp a involucrados pidiendo ubicación pero sin botón de respuesta |
| 29 | `list_transporters` | Read | Plant/Producer | — | OK |
| 30 | `assign_transporter` | Stage | Plant/Producer | code, transporterCompanyId | OK — "own_fleet" shortcut |
| 31 | `assign_truck_to_trip` | Stage | Plant | code, truckId | OK |
| 32 | `assign_truck_to_freight` | Stage | Plant/Producer | code, transporterCompanyId | OK |
| 33 | `list_company_users` | Read | Admin | — | OK |
| 34 | `list_drivers` | Read | Admin/Transp | — | OK |
| 35 | `update_user_role` | Stage | Admin | userIdentifier, newRole | OK |
| 36 | `deactivate_user` | Stage | Admin | userIdentifier | OK |
| 37 | `switch_company` | Mutate | Multi-company | companyId (opcional) | OK |
| 38 | `summarize_freights` | Read | Core | status, groupBy, dateFrom, dateTo, grain, transporterName | OK |
| 39 | `update_freight` | Stage | Prod/Plant | code + campos opcionales | Buenas validaciones por estado |
| 40 | `duplicate_freight` | Stage | Producer | code, loadDate | OK |
| 41 | `list_documents` | Read | Todos | code | OK |
| 42 | `freight_history` | Read | Todos | code | OK |
| 43 | `get_dashboard` | Read | Todos | — | OK |
| 44 | `update_field` | Stage | Producer | fieldName | OK |
| 45 | `update_lot` | Stage | Producer | lotName | OK |
| 46 | `reactivate_user` | Stage | Admin | userIdentifier | OK |
| 47 | `authorize_freight` | Stage | Plant | code | OK |
| 48 | `approve_pending_change` | Stage | Plant | code, changeId | OK |
| 49 | `reject_pending_change` | Stage | Plant | code, reason | OK |
| 50 | `respond_trip` | Stage | Transp/Chofer | code, action, reason | OK |
| 51 | `start_trip` | Stage | Transp/Chofer | code, assignmentId | OK |
| 52 | `confirm_trip_loaded` | Stage | Transp/Prod | code, loadedTons | OK |
| 53 | `confirm_trip_finished` | Stage | Transp/Plant | code, assignmentId | OK |
| 54 | `cancel_assignment` | Stage | Plant | code, assignmentId, reason | OK |
| 55 | `update_assignment` | Stage | Plant | code, assignmentId, campos | OK |
| 56 | `create_driver` | Stage | Admin | name, phone | OK |
| 57 | `update_profile` | Stage | Todos | name, email, phone | OK |
| 58 | `generate_batch_report_link` | Read | Todos | status, dateFrom, dateTo | OK |
| 59 | `ocr_analyze` | Read | Todos | url, docType | OK |
| 60 | `delete_document` | Stage | Todos | code, documentId | OK |
| 61 | `save_ocr_data` | Stage | Todos | code, documentId, ocrData | OK |
| 62 | `deactivate_truck` | Stage | Admin/Transp | truckId | OK |
| 63 | `update_truck` | Stage | Admin/Transp | plate, model | OK |
| 64 | `deactivate_driver` | Stage | Admin/Transp | driverId | OK |
| 65 | `list_enabled_plants` | Read | Plant | — | OK |
| 66 | `list_enabled_producers` | Read | Plant | — | OK |
| 67 | `grant_producer_access` | Stage | Plant | producerCompanyId | OK |
| 68 | `revoke_producer_access` | Stage | Plant | producerCompanyId | OK |
| 69 | `list_branches` | Read | Admin | — | OK |
| 70 | `create_branch` | Stage | Admin | name | OK |
| 71 | `update_branch` | Stage | Admin | branchId, name | OK |
| 72 | `delete_branch` | Stage | Admin | branchId | OK |
| 73 | `update_company` | Stage | Admin | campos | OK |
| 74 | `update_user_admin` | Stage | Admin | userId, campos | OK |
| 75 | `assign_multi_trucks` | Stage | Plant | code, assignments[] | OK |
| 76 | `view_driver_queue` | Read | Plant/Transp | code | OK |
| 77 | `reorder_driver_queue` | Stage | Plant | code, order[] | OK |
| 78 | `navigate_app` | Read | Web-only | screen, freightId | OK |

### Tools que deberían existir pero no existen

| Tool faltante | Por qué | Sev |
|---------------|---------|-----|
| `search_lots` / `search_fields` con fuzzy | `list_lots` y `list_fields` no tienen búsqueda textual. El usuario dice "lote norte" y la AI tiene que listar todos y buscar manualmente. `prepare_freight` tiene auto-resolución interna, pero fuera de creación no hay búsqueda directa. | **P2** |
| `get_user_profile` | No hay tool para que el usuario consulte su propio perfil (nombre, email, teléfono, empresa, rol). Solo `update_profile` existe. | **P2** |
| `search_transporters` con fuzzy | `list_transporters` no recibe query. Si hay 50 transportistas, Claude recibe lista completa. | **P2** |
| `get_pending_actions` | No hay forma de ver qué acciones están pendientes para el usuario (fletes por aceptar, confirmar, etc.) sin llamar `list_freights` con cada estado. | **P2** |

### Tools que no consultan datos antes de actuar

| Tool | Problema | Sev |
|------|----------|-----|
| `prepare_freight` | Valida fecha formato pero **no verifica si es fecha pasada** ni si es fin de semana/feriado | **P1** |
| `create_user` | No verifica si ya existe un usuario con ese email/teléfono antes de stage | **P2** |
| `assign_transporter` | No verifica si el transportista ya tiene un viaje para la misma fecha/hora | **P2** |

---

## 6. BÚSQUEDA DIFUSA (fuzzy-match.ts)

### Algoritmo

1. **Normalización** (`normalizeText`):
   - Lowercase, strip acentos (NFD)
   - Fonética rioplatense: b/v→b, ce/ci→se/si, z→s, ll→y, h silente, qu→k, x→ks
   - Elimina stop words (el, la, de, un, etc.)

2. **Distancia**: Levenshtein estándar (single-row optimization)

3. **Score**: `1 - levenshtein(normalized_a, normalized_b) / max(len_a, len_b)`

4. **Aliases**: Tabla hardcoded para granos (soja/solla/soya, maiz/mais, etc.)

### Parámetros

| Parámetro | Valor | Configurable |
|-----------|-------|-------------|
| Threshold default | 0.55 | Sí (por options) |
| Max results | 5 | Sí |
| Threshold en prepare_freight | **0.45** (más permisivo) | Hardcoded |
| Threshold en search_plants | 0.55 | Hardcoded |

### Clasificación de resultados

| Clase | Criterio | Acción |
|-------|----------|--------|
| `exact` | score ≥ 0.95 | Auto-aceptar |
| `confident` | score ≥ 0.85 && gap > 0.15 sobre segundo | Auto-aceptar |
| `ambiguous` | score ≥ 0.70 | Pedir al usuario (lista interactiva) |
| `none` | score < 0.70 | Rechazar — devolver lista |

### Dónde se usa

| Lugar | Qué busca | Threshold | Resultado |
|-------|-----------|-----------|-----------|
| `search_plants` (ai.service) | Empresas planta por nombre | 0.55 | Lista interactiva si ambiguo |
| `prepare_freight` auto-resolve destino | Empresas planta por nombre | 0.45 | Más permisivo para creación |
| `prepare_freight` auto-resolve origen | Lotes por nombre, campos por nombre | 0.45 | Cascada: lote→campo |
| `create_freight` flow (flow.service) | Granos por alias | GRAIN_ALIASES exact | Solo aliases |
| `create_freight` flow | Plantas por nombre | 0.55 | Lista interactiva |

### Problemas de la búsqueda difusa

| Problema | Detalle | Sev |
|----------|---------|-----|
| **No busca sucursales/branches** | `search_plants` busca por nombre de empresa (Company.name), no por nombre de sucursal (Plant.name). Si la planta es "SOFOVAL" y el usuario dice "sucursal Palmira", no encuentra nada. | **P1** |
| **No hay búsqueda por substrings** | El Levenshtein penaliza mucho strings de diferente longitud. "CONAPROLE NUEVA HELVECIA" vs "CONAPROLE" da score bajo (~0.38) a pesar de ser la misma planta. | **P1** |
| **Aliases solo para granos** | No hay aliases para plantas, campos o transportistas. "COOP DEL SUR" no matchea "Cooperativa del Sur". | **P2** |
| **No se usa para transportistas** | `list_transporters` no tiene parámetro de query. Siempre lista todos. | **P2** |

---

## 7. MENSAJES INTERACTIVOS

### Uso actual de Reply Buttons (max 3)

| Flujo | Botones | Estado |
|-------|---------|--------|
| Menú principal | 3 botones según rol (📦 Mis Fletes / ➕ Crear Flete / ❓ Ayuda) | OK |
| Notificación de flete asignado | ✅ Aceptar / 🚫 Rechazar / 📋 Detalle | OK |
| Confirmación de acción AI | ✅ CONFIRMAR / ❌ CANCELAR | OK |
| Confirm loaded > 100tn | CONFIRMAR X TN / CANCELAR | OK |
| Ubicación lista (map picker) | UBICACIÓN LISTA | OK |
| AI respuesta con botones | Dinámico (max 3) | OK |

### Uso actual de List Messages (max 10 rows)

| Flujo | Paginación | Estado |
|-------|-----------|--------|
| Lista de fletes | Sí (9/page + "Mostrar más") | OK |
| Selección de empresa | Sí | OK |
| Lista de plantas | Sí | OK |
| Lista de lotes | Sí | OK |
| Lista de camiones | Sí | OK |
| Lista de choferes | Sí | OK |
| Lista de transportistas | Sí | OK |
| Acciones de flete | Sí | OK |

### Dónde DEBERÍAN usarse y NO se usan

| Escenario | Actualmente | Debería | Sev |
|-----------|------------|---------|-----|
| **"Flota propia" — sí/no/mixto** | Texto libre, depende de que Claude pregunte | Botones: "🚛 Mi flota" / "🏭 Delegar a planta" / "📋 Mixto" | **P1** |
| **Selección de grano** | Texto libre o lista pero depende de Claude | Lista interactiva con los 7 granos + "Otro" | **P1** |
| **Selección de fecha** | Texto libre, Claude interpreta | Botones: "📅 Hoy" / "📅 Mañana" / "📅 Otra fecha" | **P2** |
| **Selección de vehículo + chofer (flota propia)** | Listas interactivas (OK si Claude las pide) | A veces Claude olvida pedir la lista → **P1** por inconsistencia |
| **Confirmación de datos OCR** | Texto libre | Botones: "✅ Correcto" / "✏️ Corregir" / "❌ Descartar" | **P2** |
| **Menú de acciones del flete** | Lista interactiva (OK) | Ya implementado correctamente | OK |

---

## 8. MANEJO DE ERRORES

### Capas de error handling

```
Layer 1: Controller.receive()
  └─ try/catch → logger.error, ya respondió 200

Layer 2: RouterService._handleMessage()
  └─ try/catch → sendText("Se produjo un error…")

Layer 3: handleAiChat()
  └─ try/catch → sendText("inconveniente técnico") + showMainMenu

Layer 4: AiService.chat()
  └─ try/catch → return { text: "inconveniente técnico" }

Layer 5: executeTool()
  └─ try/catch → SAFE_PATTERNS check → sanitized error or generic

Layer 6: FlowService.continueFlow()
  └─ try/catch → sanitized error + endFlow
```

### Qué ve el usuario cuando algo falla

| Falla | Mensaje al usuario | Retry | Log |
|-------|-------------------|-------|-----|
| Claude API timeout (45s) | "inconveniente técnico" | No automático | Sí — error + stack |
| Tool execution error (safe pattern) | Mensaje del error limpio (ej: "No se encontró el flete") | No | Sí |
| Tool execution error (unsafe) | "Error al procesar la solicitud" | No | Sí — error msg |
| Meta API send failure | Silencioso — el usuario no recibe respuesta | 3 reintentos (1s, 3s, 9s) | Sí |
| Flow session expired mid-flow | "La sesión expiró. Escriba 'menu'…" | No | No |
| Tool loop exhausted (5 iter) | "La operación requiere más pasos…" con link a web | No | Sí — warn |
| Rate limit hit (20 msg/5min AI) | "Ha enviado muchos mensajes…" | No — auto-reset | No |
| Rate limit hit (30 msg/min router) | Silencioso — drop | No | No |
| Concurrent message (chat lock) | "Estoy procesando su mensaje anterior" | No | No |

### Problemas de error handling

| Problema | Detalle | Sev |
|----------|---------|-----|
| **Send failure = silencio** | Si Meta API devuelve error (ej: número bloqueado), el usuario no recibe nada. No hay fallback. | **P1** |
| **No retry en Claude API** | Si Claude falla una vez, no reintenta. Meta API tiene 3 reintentos, pero Claude no. | **P2** |
| **Silent rate limit drop** | Router rate limit (30/min) dropea silenciosamente. El usuario no sabe que sus mensajes se pierden. | **P2** |
| **Error en fire-and-forget** | Múltiples `.catch(e => logger.error)` en logs, audits, markRead. Si fallan en cascada, no se detecta. | **P2** |

---

## 9. SESIONES

### Configuración de sesiones

| Parámetro | Valor | Dónde |
|-----------|-------|-------|
| AI session timeout | 30 min | `AI_SESSION_TIMEOUT_MIN` en ai.constants |
| Flow session timeout | 10 min | `FLOW_TIMEOUT_MINUTES` en flow.service |
| Session cleanup | Cada 30 min | whatsapp.service.cleanupExpired() |
| Cleanup threshold | 2 horas post-expiración | `now - 2h` |
| Location token TTL | 30 min | Controller.saveLocation |

### ¿Qué pasa cuando expira mid-flow?

| Escenario | Comportamiento | Problema |
|-----------|---------------|----------|
| Flow (create_freight) expira | Siguiente mensaje → `continueFlow` detecta expiración → "La sesión expiró" + endFlow | El flete en construcción se pierde sin aviso previo. **P1** |
| AI session expira | Siguiente mensaje → crea sesión nueva → empieza desde cero | Pierde todo el contexto. No hay warning. **P1** |
| Location token expira (30 min) | save-location devuelve "Token expirado" | El usuario que tomó más de 30 min en el mapa pierde la ubicación. **P2** |
| Session con `pendingDocument` se limpia | cleanup no borra sesiones con pendingDocument/locationToken | OK — protegido |

### ¿Se puede retomar una sesión expirada?

**No.** Una vez expirada, la sesión y todo su contenido (`aiMessages`, `pendingFreight`, `activeContext`) se eliminan en el cleanup. No hay mecanismo de:
- Serializar/resumir el contexto
- Guardar un snapshot pre-expiración
- Ofrecer "¿Desea continuar donde dejó?"

---

## 10. LISTA PRIORIZADA DE PROBLEMAS

### P0 — Críticos (afectan correctitud)

| # | Problema | Archivo | Líneas | Impacto |
|---|----------|---------|--------|---------|
| P0-1 | **Rol de usuario no considera empresa activa** | ai.service.ts | ~477-481, ~743-744 | Un chofer en empresa A que es admin en empresa B obtiene restricciones de chofer en ambas. Un admin que también es chofer en otra empresa se ve limitado. |
| P0-2 | **isChofer flag es global, no scoped a activeCompanyId** | ai.service.ts | ~477, ~743 | El `isChofer` check busca `memberships.some(m.role==='chofer')` — si CUALQUIER membership es chofer, el flag es true, bloqueando herramientas de admin/producer en la empresa correcta. |
| P0-3 | **getFilteredTools replica el bug de isChofer** | ai.service.ts | ~743 | Las tools disponibles quedan restringidas a CHOFER_TOOLS aun cuando el usuario opera como admin de otra empresa. |

### P1 — Altos (afectan experiencia significativamente)

| # | Problema | Archivo | Impacto |
|---|----------|---------|---------|
| P1-1 | **Contexto se pierde completamente al expirar sesión** | whatsapp-router.service | Usuario pierde flete en construcción, historial, documentos pendientes sin aviso |
| P1-2 | **No hay datos proactivos en system prompt** | ai.service.ts | Claude no sabe los fletes activos del usuario sin tool call → primera respuesta lenta |
| P1-3 | **Fuzzy search no busca sucursales (Plant.name)** | ai.service.ts:1749-1764 | "Sucursal Palmira" no matchea porque busca solo Company.name |
| P1-4 | **Fuzzy: substring matching débil** | fuzzy-match.ts | "CONAPROLE" no matchea "CONAPROLE NUEVA HELVECIA" (Levenshtein penaliza longitud) |
| P1-5 | **"Flota propia" sin botones interactivos** | ai.service.ts (prompt) | Depende de que Claude pregunte y el usuario escriba texto libre. Propenso a malentendidos. |
| P1-6 | **prepare_freight no valida fecha pasada** | ai.service.ts:~1858 | Valida formato YYYY-MM-DD pero no compara con la fecha actual |
| P1-7 | **Send failure = silencio** | whatsapp.service.ts | Si Meta rechaza el envío, el usuario no recibe respuesta ni feedback |
| P1-8 | **Flow expirado pierde flete sin aviso previo** | whatsapp-flow.service | No hay warning 1-2 min antes de expirar |

### P2 — Medios (mejoras de experiencia)

| # | Problema | Archivo |
|---|----------|---------|
| P2-1 | Interactive `type=button_reply` pero no `button_reply` ni `list_reply` cae silencioso | whatsapp.controller.ts:211 |
| P2-2 | No hay tool `search_lots`/`search_fields` con fuzzy fuera de prepare_freight | ai.service.ts |
| P2-3 | No hay tool `get_user_profile` | ai-tool-definitions.ts |
| P2-4 | `list_transporters` no tiene query/fuzzy | ai.service.ts |
| P2-5 | Aliases solo para granos, no para entidades | fuzzy-match.ts |
| P2-6 | Router rate limit (30/min) dropea silenciosamente | whatsapp-router.service.ts:135 |
| P2-7 | No retry en Claude API calls | ai.service.ts |
| P2-8 | Prompt redundante/largo (~3800 chars) | ai.service.ts |
| P2-9 | Selección de grano debería ser lista interactiva, no texto libre | ai.service.ts |
| P2-10 | No hay warning pre-expiración de sesión | whatsapp.service.ts |
| P2-11 | `create_user` no verifica duplicados antes de stage | ai.service.ts |

---

## 11. RECOMENDACIONES

### P0 — Fixes inmediatos

**P0-1/2/3: Rol scoped a empresa activa**

```typescript
// ai.service.ts — buildSystemPrompt y getFilteredTools
// ANTES:
const isChofer = user.role === 'chofer' ||
  (user.memberships || []).some((m: any) => m.role === 'chofer' && m.active);

// DESPUÉS:
const activeCoId = user.activeCompanyId || user.companyId;
const activeMembership = (user.memberships || []).find(
  (m: any) => m.companyId === activeCoId && m.active
);
const activeRole = activeMembership?.role || user.role;
const isChofer = activeRole === 'chofer';
const isAdmin = ['admin', 'platform_admin', 'gerente'].includes(activeRole);
```

Aplicar en 3 lugares: `buildSystemPrompt()` (~477), `getFilteredTools()` (~743), y la variable `userRole` (~478).

### P1 — Mejoras de alta prioridad

**P1-1: Pre-expiración warning + contexto persistente**

1. Agregar un timer que 2 min antes de expirar envíe: "⏳ Su sesión expira en 2 minutos. Envíe cualquier mensaje para renovarla."
2. Al expirar, guardar un resumen compacto del contexto en un campo nuevo `WhatsAppSession.lastContext` o directamente en `User.metadata`.
3. Al crear nueva sesión, cargar el resumen como `[Sistema: sesión anterior (hace X min): estaba consultando flete F26-XXX...]`.

**P1-3/4: Mejorar fuzzy search**

1. Agregar `contains` check antes de Levenshtein: si el query está contenido en el label (o viceversa), dar score bonus.
2. En `search_plants`, buscar tanto `Company.name` como `Plant.name` (sucursales).
3. Tokenizar y comparar por palabras: "CONAPROLE" matchea "CONAPROLE NUEVA HELVECIA" por token overlap.

```typescript
// fuzzy-match.ts — agregar antes del Levenshtein
const na = normalizeText(a);
const nb = normalizeText(b);
// Substring bonus
if (na.includes(nb) || nb.includes(na)) {
  const shorter = Math.min(na.length, nb.length);
  const longer = Math.max(na.length, nb.length);
  return Math.max(0.85, shorter / longer); // Al menos 0.85 si es substring
}
```

**P1-5: Botones para flota propia**

En `prepare_freight`, cuando se necesita resolver `useOwnFleet` y la empresa tiene `hasInternalFleet`, usar `_pendingButtons` en side-effects para enviar botones "Mi flota" / "Delegar a planta" en vez de depender de texto libre de Claude.

**P1-6: Validar fecha pasada en prepare_freight**

```typescript
// Después de la validación de formato (línea ~1858)
const today = new Date(Date.now() + URUGUAY_UTC_OFFSET_MS).toISOString().split('T')[0];
if (input.loadDate < today) {
  return JSON.stringify({ error: `La fecha ${input.loadDate} ya pasó. Indique una fecha desde ${today}.` });
}
```

### P2 — Mejoras de mediano plazo

1. **Agregar `search_lots(query)`** con fuzzy, accesible fuera de prepare_freight
2. **Agregar `search_transporters(query)`** con fuzzy
3. **Silent rate limit → feedback**: cambiar el drop silencioso a un mensaje "Demasiados mensajes, aguarde"
4. **Retry en Claude API**: agregar 1 reintento con backoff exponencial (similar a Meta API)
5. **Reducir tamaño del prompt**: mover reglas de formato a tool descriptions, eliminar redundancias
6. **Interactive grain selection**: en `prepare_freight`, cuando falta grano, enviar lista con los 7 tipos
7. **Warning de expiración**: 2 min antes de sesión expirar, enviar aviso

---

## APÉNDICE: Métricas del módulo

| Métrica | Valor |
|---------|-------|
| Archivos analizados | 8 |
| Líneas de código totales | ~7,500 |
| Tools del agente AI | 78 |
| System prompt (chars) | ~3,800 |
| Modelo principal | Claude Sonnet 4.6 |
| Modelo rápido | Claude Haiku 4.5 |
| Max historial | 25 mensajes |
| Max tool loops | 5 |
| Timeout sesión AI | 30 min |
| Timeout sesión Flow | 10 min |
| Rate limit AI | 20 msg / 5 min |
| Rate limit Router | 30 msg / 1 min |
| Rate limit Flow | 30 msg / 5 min |
