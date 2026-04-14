# AUDITORÍA INTEGRAL — AGENTE IA TOLVINK
**Fecha:** 2026-04-11
**Modelo activo:** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`)
**Alcance:** Módulo completo `src/ai/` + integración WhatsApp + integración Web Chat

---

## 1. FUNCIONALIDADES POR TIPO DE USUARIO Y EMPRESA

### Estado actual: Solo CHOFER AUTÓNOMO implementado

El agente actual tiene UN solo system prompt hardcodeado para el rol "Chofer Autónomo". No hay routing por tipo de empresa ni por rol.

| | Chofer Autónomo | Chofer (regular) | Productor | Planta | Transportista | Operario | Consulta |
|---|---|---|---|---|---|---|---|
| **Crear flete autónomo** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Finalizar flete** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Registrar llegada** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Cancelar flete** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Adjuntar documento** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Listar fletes** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Ver detalle flete** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Dashboard** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Buscar plantas** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Buscar campos/lotes** | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Crear flete normal** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Asignar transporte** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Aceptar/rechazar** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Iniciar viaje** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Confirmar carga** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Confirmar entrega** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Gestión de flota** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Gestión campos** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Admin usuarios** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

**Condiciones especiales:**
- Chofer autónomo requiere `Company.autonomousDriverEnabled === true`
- No hay verificación de rol en el agente — el prompt asume chofer autónomo para todos
- No hay bloqueo CONSULTA (READONLY) — no se verifica `CompanyAccess.accessLevel`
- No hay filtrado de tools por rol — todas las 12 tools se exponen a todos los usuarios

---

## 2. INVENTARIO DE HERRAMIENTAS (TOOLS)

### 12 tools registradas

| # | Nombre | Categoría | Tipo | Staging | Descripción |
|---|--------|-----------|------|---------|-------------|
| 1 | `list_freights` | Consulta | Read-only | No | Lista fletes con filtros opcionales |
| 2 | `get_freight_detail` | Consulta | Read-only | No | Detalle de flete por código |
| 3 | `get_dashboard` | Consulta | Read-only | No | Resumen ejecutivo por estado |
| 4 | `search_plants` | Búsqueda | Read-only | No | Fuzzy search de plantas |
| 5 | `search_fields` | Búsqueda | Read-only | No | Fuzzy search de campos |
| 6 | `search_lots` | Búsqueda | Read-only | No | Fuzzy search de lotes |
| 7 | `prepare_autonomous_freight` | Creación | Mutación | Sí | Prepara flete autónomo |
| 8 | `confirm_action` | Ejecución | Mutación | N/A | Ejecuta acción staged |
| 9 | `finish_autonomous_freight` | Lifecycle | Mutación | Sí | Finaliza flete activo |
| 10 | `register_plant_arrival` | Lifecycle | Mutación | Sí | Registra llegada a planta |
| 11 | `cancel_freight` | Lifecycle | Mutación | Sí | Cancela flete con motivo |
| 12 | `attach_document` | Documento | Mutación | Sí | Adjunta foto/archivo pendiente |

### Tools read-only (ejecución paralela permitida):
`list_freights`, `get_freight_detail`, `get_dashboard`, `search_plants`, `search_fields`, `search_lots`

### Tools faltantes vs FreightsService disponible:
| Método en FreightsService | Tool AI | Estado |
|---------------------------|---------|--------|
| `create()` (flete normal) | ❌ | No implementado |
| `assign()` | ❌ | No implementado |
| `assignMulti()` | ❌ | No implementado |
| `respond()` (aceptar/rechazar) | ❌ | No implementado |
| `start()` (iniciar viaje) | ❌ | No implementado |
| `confirmLoaded()` | ❌ | No implementado |
| `confirmFinished()` | ❌ | No implementado |
| `updateFreight()` | ❌ | No implementado |
| `getDriverQueue()` | ❌ | No implementado |
| `addTrackingPoint()` | ❌ | No implementado |

---

## 3. FLUJOS CONVERSACIONALES PERMITIDOS

### Flujo 1: Crear flete autónomo
**Actor:** Chofer autónomo
**Precondiciones:** Sin flete activo, `autonomousDriverEnabled === true`

1. Chofer: "salgo del galpon para sofoval con 30 toneladas de soja"
2. Claude llama `search_plants("sofoval")` + `search_fields("galpon")` (paralelo)
3. Si matchea → usa IDs. Si no → pregunta si usar texto libre
4. Claude llama `prepare_autonomous_freight(origin, destination, grain, weightKg)`
5. Handler verifica no hay flete activo → stages action → loop sale inmediato
6. Usuario recibe: summary + [CONFIRMAR] [CANCELAR]
7. Presiona CONFIRMAR → router envía "Confirmar.[ACTION_ID:xxx]"
8. Claude llama `confirm_action` → `FreightsService.createAutonomousFreight(dto, synUser)`
9. Respuesta: "El flete F26-XXX fue creado correctamente"

### Flujo 2: Crear flete con flete activo
**Actor:** Chofer autónomo
**Precondiciones:** Tiene flete activo

1. Chofer: "salgo del trillo para sofoval con colza 34 toneladas"
2. Claude llama `prepare_autonomous_freight(...)`
3. Handler detecta flete activo → stages `finish_autonomous_freight` → loop sale inmediato
4. Usuario recibe: "Tenes un flete activo: F26-XXX... Finalizarlo?" + [CONFIRMAR] [CANCELAR]
5. Presiona CONFIRMAR → finaliza flete anterior
6. Claude retoma con datos del mensaje original → crea nuevo flete

### Flujo 3: Finalizar flete
**Actor:** Chofer autónomo
**Trigger:** "ya descargué", "terminé"

1. Claude llama `finish_autonomous_freight()` (auto-detecta flete activo)
2. Staging: "Finalizar flete F26-XXX (Soja · 30 tn)" + botones
3. Confirma → `FreightsService.finishAutonomousFreight(id, user, weightKg?)`

### Flujo 4: Registrar llegada a planta
**Actor:** Chofer autónomo
**Trigger:** "llegué a planta"

1. Claude llama `register_plant_arrival()` (auto-detecta)
2. Staging: "Registrar llegada a planta del flete F26-XXX" + botones
3. Confirma → `FreightsService.registerPlantArrival(id, user)`
4. Flete sigue en estado `loaded`, se registra `arrivedAtPlantAt`

### Flujo 5: Cancelar flete
**Actor:** Chofer autónomo
**Trigger:** "cancelar flete"

1. Claude pide motivo (obligatorio)
2. Claude llama `cancel_freight(code, reason)`
3. Staging + botones
4. Confirma → `FreightsService.cancel(id, {reason}, user)`

### Flujo 6: Adjuntar foto/documento
**Actor:** Chofer autónomo
**Trigger:** Envío de imagen por WhatsApp

1. WhatsApp router descarga media, sube a Supabase, guarda en `flowState.pendingDocument`
2. Reenvía a AI: "[El usuario envió imagen: foto.jpg — URL: https://...]"
3. Claude detecta flete activo → llama `attach_document(code)`
4. Handler lee `pendingDocument` del flowState → staging + botones
5. Confirma → `FreightsService.addDocument(id, {name, url, type}, user)`

### Flujo 7: Consultas (sin staging)
- "mis fletes" → `list_freights` → lista directa
- "como va" → `get_dashboard` → resumen por estado
- "F26-XXX.1234" → `get_freight_detail(code)` → detalle

---

## 4. CASOS DE MENSAJES CON BOTONES

### Botones generados por staging

Toda acción mutativa genera botones via `stageAction()`:

| Acción | Texto del botón | ID del botón | Al presionar |
|--------|----------------|-------------|-------------|
| Confirmar | CONFIRMAR | `ai_confirm:{actionId}` | Router envía "Confirmar.[ACTION_ID:{actionId}]" → AI llama `confirm_action` |
| Cancelar | CANCELAR | `ai_cancel:{actionId}` | Router envía "No, cancelar.[ACTION_ID:{actionId}]" → AI descarta |

### Botones del router de WhatsApp (notificaciones, no del AI)

| Acción | ID | Origen |
|--------|-----|--------|
| Aceptar flete | `accept:{freightId}` | Notificación WhatsApp |
| Rechazar flete | `reject:{freightId}` | Notificación WhatsApp |
| Confirmar carga | `confirm_loaded:{freightId}` | Notificación WhatsApp |
| Confirmar entrega | `confirm_finished:{freightId}` | Notificación WhatsApp |
| Ver detalle | `detail:{freightId}` | Notificación WhatsApp |

### Casos donde deberían aparecer botones pero podrían no hacerlo

1. **Claude genera texto sin llamar tool**: Si Claude responde conversacionalmente en vez de llamar una herramienta, no hay staging y no hay botones
2. **Tool loop exhausto**: Si se llega a 15 iteraciones sin staging, no hay botones
3. **Error en handler**: Si `stageAction` falla, no hay botones

---

## 5. MODELOS DE MENSAJES DEL AGENTE

### Formato de solicitud de datos faltantes
```
Necesito estos datos para crear el flete:
📍 Origen (campo o lugar de carga)
🏭 Destino (planta o acopio)
🌾 Grano
⚖️ Peso en kg o toneladas
```

### Formato de confirmación (staging summary)
```
📋 Flete autonomo:
🚛 Camion: LAF1313
📍 Origen: galpon
🏭 Destino: sofoval
🌾 Grano: soja
⚖️ Peso: 30000 kg
[CONFIRMAR] [CANCELAR]
```

### Formato de resultado post-ejecución
```
El flete F26-XXX.1234 fue creado correctamente.
```

### Formato de error
```
Hubo un problema, intenta de nuevo.
```
(Los errores técnicos se ocultan al usuario)

### Formato de lista de fletes
```
Tenes 3 fletes activos:
📋 F26-ABC.1234 — A planta — Soja · 30 tn — galpon → sofoval
📋 F26-DEF.5678 — Aceptado — Trigo · 25 tn — campo1 → planta2
📋 F26-GHI.9012 — A campo — Maiz — bajo → calmer
```

### Formato de flete activo (al intentar crear nuevo)
```
Tenes un flete activo: F26-ABC.1234 (Soja · 30 tn → sofoval)
Finalizarlo para crear uno nuevo?
[CONFIRMAR] [CANCELAR]
```

---

## 6. INCONGRUENCIAS DETECTADAS

### CRÍTICO: Sin control de acceso en `resolveFreightByCode`

```typescript
// tool-executor.ts — resolveFreightByCode
const freight = await this.prisma.freight.findFirst({
  where: { code: { equals: clean, mode: 'insensitive' } },
});
return freight || null;  // ← NO verifica participantCompanyIds
```

**Riesgo:** Cualquier usuario puede operar sobre cualquier flete del sistema si conoce/adivina el código. Los códigos son secuenciales (F26-ABC.1234).

**Afecta:** `get_freight_detail`, `finish_autonomous_freight`, `register_plant_arrival`, `cancel_freight`, `attach_document`

### CRÍTICO: Tool staging usa nombre incorrecto

```typescript
// handlePrepareAutonomousFreight stages:
this.stageAction(session.id, 'create_autonomous_freight', {...})
//                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^
// Pero 'create_autonomous_freight' NO existe en tool-definitions.ts
// La tool se llama 'prepare_autonomous_freight'
```

Funciona porque `confirm_action` tiene un case para `'create_autonomous_freight'`, pero es inconsistente y confuso.

### ALTO: Sin filtrado de tools por rol

Todas las 12 tools se exponen a TODOS los usuarios, incluyendo los que no son choferes autónomos. No hay:
- Verificación de `Company.autonomousDriverEnabled`
- Verificación de `UserCompany.role === 'chofer'`
- Bloqueo CONSULTA (READONLY)

El FreightsService valida internamente, pero el agente permite intentar operaciones que siempre fallarán para ciertos usuarios.

### ALTO: `pendingActions` map sin protección de concurrencia

```typescript
private pendingActions = new Map<string, {...}>();
```

Si dos mensajes llegan simultáneamente (antes que el lock los serialice), pueden corromper el map.

### ALTO: Prompt dice "flete activo devuelve error" pero código hace staging

Prompt:
> Si hay flete activo, prepare_autonomous_freight devuelve error con el codigo.

Código actual:
```typescript
if (activeFreight) {
  return this.stageAction(session.id, 'finish_autonomous_freight', {...});
}
```

El código cambió a staging directo pero el prompt no se actualizó.

### MEDIO: `attach_document` depende de `pendingDocument` externo

El handler lee `session.flowState.pendingDocument` que es poblado por el WhatsApp router. Si el usuario envía texto sin foto, `pendingDocument` no existe y el handler devuelve error. No hay mecanismo para que el AI sepa si hay foto pendiente.

### MEDIO: History trimming puede cortar contexto de tool calls

Si la conversación tiene >40 mensajes, `trimHistory` corta los más viejos. Si corta un `assistant` message con `tool_use` blocks, los `tool_result` que siguen quedan huérfanos y el trimmer los elimina. Se pierde contexto.

### BAJO: UUID stripping puede romper links

```typescript
finalText = finalText.replace(UUID_REGEX, (match, offset) => {
  const before = finalText.slice(Math.max(0, offset - 80), offset);
  if (/https?:\/\/\S*$/i.test(before)) return match;
  return '';
});
```

Si hay un UUID en un contexto que no es URL pero sí es relevante (ej: en un JSON visible al usuario), se elimina silenciosamente dejando texto roto.

---

## 7. OPORTUNIDADES DE MEJORA

### Prioridad 1 — Seguridad
1. Agregar verificación de `participantCompanyIds` en `resolveFreightByCode`
2. Verificar rol y empresa antes de exponer tools
3. Bloquear operaciones para usuarios CONSULTA

### Prioridad 2 — Funcionalidad faltante
1. Tools para chofer regular: aceptar/rechazar flete, iniciar viaje, confirmar carga/entrega
2. Tools para productor: crear flete normal (`prepare_freight`), gestionar campos
3. Tools para planta: asignar transporte, autorizar fletes
4. Tools para transportista: asignar camión/chofer, gestionar flota
5. System prompt dinámico por tipo de empresa y rol

### Prioridad 3 — Robustez
1. Sincronizar prompt con el comportamiento real del código (staging vs error)
2. Corregir nombre de tool staging (`create_autonomous_freight` → `prepare_autonomous_freight`)
3. Agregar validación de `autonomousDriverEnabled` antes de exponer tools de chofer autónomo
4. Manejar caso de múltiples camiones asignados al chofer

### Prioridad 4 — UX
1. Mejorar summaries de staging con más contexto (grano, toneladas, origen/destino)
2. Agregar soporte para editar datos antes de confirmar ("CAMBIAR" button)
3. Feedback de escritura ("typing indicator") durante tool execution larga

---

## 8. ARQUITECTURA ACTUAL

```
src/ai/
├── agent.service.ts          (297 líneas) — Orquestador: Claude + tool loop + historial
├── ai.module.ts              (20 líneas)  — Registro NestJS
├── core/
│   ├── claude.client.ts      (60 líneas)  — SDK Anthropic con prompt caching
│   ├── constants.ts          (19 líneas)  — Config: timeouts, límites, URLs
│   └── prompt-builder.ts     (75 líneas)  — System prompt chofer autónomo
├── tools/
│   ├── tool-definitions.ts   (169 líneas) — 12 tools en formato Anthropic
│   └── tool-executor.ts      (490 líneas) — Handlers + stageAction + confirmAction
└── utils/
    └── rate-limiter.ts       (33 líneas)  — 20 msgs / 5 min per user

Total: 8 archivos, ~1,163 líneas
```

### Consumidores externos
- `whatsapp-router.service.ts` — `this.ai.chat(phone, text, user, session)`
- `web-chat.service.ts` — `this.ai.chat('web', text, dbUser, session, onDelta)`

### Dependencias
- `@anthropic-ai/sdk` — Cliente Claude
- `FreightsService` — Lógica de negocio de fletes
- `PrismaService` — Acceso directo a DB (campos, lotes, plantas)
- `src/common/fuzzy-match.ts` — Búsqueda fuzzy
- `src/common/build-synthetic-user.ts` — Conversión user DB → JWT-like
- `src/common/error-utils.ts` — Sanitización de errores
