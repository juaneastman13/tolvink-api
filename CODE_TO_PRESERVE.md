# Code to Preserve - Etapa 0

## Qué guardar y por qué

Este documento mapea código del sistema viejo que vale la pena preservar (aunque sea como referencia) porque contiene lógica de negocio, decisiones de UX, o patterns útiles que no queremos perder.

**Acción**: copiar estos archivos/fragmentos a `legacy-reference/` sin modificar, no borrar.

---

## 1. Heurísticos de extracción en español

### Archivo fuente
`src/agent-v2/nodes/extract-slots.node.ts` (líneas 70-130)

### Qué guardar
```typescript
// extractCreateFreightSlotsHeuristic(message: string)
// normalize(value: string)
// normalizeTime(hourRaw, minuteRaw, meridian)
// cleanPlace(value: string)
// parseSingleSlot(slot, value)
```

### Por qué es valioso
- Normalización de acentos y mayúsculas: `normalize('Mañana') → 'manana'`
- Reconocimiento de productos: regex para soja, maíz, trigo, cebada, sorgo, colza, arroz
- Parseo de fechas en español: "hoy", "mañana", ISO date format
- Parseo de horas: soporte para "14:30", "2:30pm", "8am"
- Pattern "desde X ... a/hasta Y ..." para ubicaciones

### Cómo se integra
- En Etapa 1: copiar las funciones de normalización/parseo a `src/agent/memory/slot-extraction.utils.ts`
- Las regexes se revisan y amplifán según experiencia real
- Se pueden agregar productos nuevos si cambia el catálogo

### Archivo de destino
`legacy-reference/heuristics/extract-slots.backup.ts`

---

## 2. Catálogos y metadatos

### Archivos fuente
- `src/agent-v2/catalogs/intents.catalog.ts`
- `src/agent-v2/catalogs/flows.catalog.ts`
- `src/agent-v2/catalogs/synonyms.catalog.ts`

### Qué guardar
Mapeos de:
- `intent_name` → `{ description, examples, flow }`
- `flow_name` → `{ steps, transitions }`
- Sinónimos en español para intents (ej. "quiero flete" = "crear flete")

### Por qué es valioso
- Contiene decisiones de diseño de flujos (qué pasos, en qué orden)
- Sinónimos refinados por testing real
- Categorización de intents

### Cómo se integra
- En Etapa 2+: se traslada a una tabla Prisma `agent_intent_catalog` o similar
- Por ahora, archivo de referencia para diseñar la nueva clasificación

### Archivo de destino
`legacy-reference/catalogs/`

---

## 3. Prompts: tono y restricciones

### Archivo fuente
- `src/agent-v2/prompts/base.prompt.ts`
- `src/agent-v2/prompts/response-style.prompt.ts`

### Qué guardar

```typescript
// base.prompt.ts
export const BASE_AGENT_V2_PROMPT = `
Sos Tolvink, asistente operativo de logistica agropecuaria.
Responde en espanol rioplatense, con mensajes breves para WhatsApp.
No inventes datos maestros, codigos, permisos, ubicaciones ni estados.
Si falta informacion, pedi un solo dato por vez.
Las reglas operativas las decide el backend, no el modelo.
`.trim();
```

### Por qué es valioso
- Define tono (rioplatense, operativo, sin adornos)
- Restricciones críticas: no inventar datos maestros, un dato por vez
- Premisa arquitectónica: backend decide reglas, modelo obedece

### Cómo se integra
- En Etapa 1: se traslada a `src/agent/prompts/system-base.prompt.ts`
- Se amplía con secciones por role/flow pero manteniendo el tono base

### Archivo de destino
`legacy-reference/prompts/style.backup.ts`

---

## 4. Renderers: estructura de mensajes WhatsApp

### Archivo fuente
`src/agent-v2/renderers/whatsapp.renderer.ts` (completo)

### Qué guardar
- Métodos de rendering de diferentes tipos de mensaje:
  - `askMissingSlots(slots[])` — cómo preguntar por múltiples datos
  - `askMissingSlot(slot)` — cómo preguntar por un dato singular
  - `askLocationChoice(choices)` — cómo renderizar opciones (limitado a 3 botones interactivos)
  - `pickLocationViaLink(url)` — cómo enviar webview de mapa
  - `createFreightConfirmation(slots)` — cómo resumir antes de confirmar
  - `freightList(items)` — cómo listar fletes (max 10, mostrar primeros)
  - `freightDetail(item)` — detalle de un flete

### Por qué es valioso
- Define "vocabulario" de UX para WhatsApp: cómo se ve una pregunta, una confirmación, etc.
- Límites WhatsApp: 3 botones interactivos con títulos únicos de 20 chars
- Estructura comprobada de mensajes multipart (texto + botones)
- Ejemplos: formateo de listas, números de flete, estados (con traducción al español)

### Cómo se integra
- En Etapa 1: copiar a `src/agent/whatsapp/renderers/` con adaptaciones
- Nuevos métodos se agregan según necesidad de nuevos flujos

### Archivo de destino
`legacy-reference/renderers/whatsapp.backup.ts`

---

## 5. Schemas Zod para validación

### Archivos fuente
- `src/agent-v2/schemas/freight.schema.ts` — CreateFreightSlotsSchema
- `src/agent-v2/schemas/intent.schema.ts` — IntentSchema
- `src/agent-v2/schemas/action.schema.ts` — PendingActionSchema

### Qué guardar
Definiciones de tipos/schemas válidos:

```typescript
// Ejemplo conceptual
CreateFreightSlotsSchema = z.object({
  product: z.enum([...grains]),
  origin: z.string(),
  destination: z.string(),
  truckCount: z.number().int().positive(),
  date: z.string(), // "hoy", "manana", ISO date
  time: z.string().regex(/^\d{2}:\d{2}$/), // HH:MM
  observations: z.string().max(1000).optional(),
});
```

### Por qué es valioso
- Define estructura de datos esperados para flujos
- Validación en el punto de decisión: es este slot válido?
- Reutilizable en el nuevo sistema sin cambios

### Cómo se integra
- En Etapa 1: copiar a `src/agent/schemas/` tal cual
- Se pueden refactorizar después si es necesario

### Archivo de destino
`legacy-reference/schemas/`

---

## 6. Conceptos de estado y máquinas de estado

### Archivo fuente
`src/agent-v2/schemas/agent-state.schema.ts` (lines 18-66)

### Qué guardar
La estructura de campos que se necesitan para rastrear un flujo:

```
channel, userId, phone, sessionId
activeCompanyId, activeCompanyType, activeRole
currentIntent, currentFlow, currentStep
awaitingSlot, missingSlots
locationChoices, awaitingLocationChoice
slots (recolectados)
originText, destinationText, originLocation, destinationLocation
pendingLocationRequest, locationRequestToken, locationRequestType
activeFreightCode
pendingAction, pendingConfirmation
lastUserMessage, response, buttons
```

### Por qué es valioso
- Mapeo exhaustivo de qué estado necesita persistir en una conversación
- Estructura de contexto capas: usuario, compañía, rol, flujo actual, slots recolectados, ubicaciones
- Diferencia entre "text entered by user" y "resolved location object"

### Cómo se integra
- En Etapa 1: tablas Prisma `agent_conversation_state` que persiste esto
- Reducir la complejidad eliminando campos no necesarios de LangGraph

### Archivo de destino
`legacy-reference/schemas/state-structure.backup.ts`

---

## 7. Concepto: Layer 0 Interceptor

### No hay archivo específico en el código viejo
Concepto mencionado en audit: responder sin LLM para casos triviales.

### Qué rescatar
- Idea: antes de llamar al LLM, intentar resolver con reglas simples:
  - Saludos: "hola", "buenas", "buenos dias" → respuesta fija
  - Despedidas: "chao", "hasta luego" → respuesta fija
  - Gracias: "gracias", "grazie" → respuesta fija
  - Cancelación: "cancelar", "salir" → cancelar flujo activo
  - Ayuda: "ayuda", "menu" → mostrar opciones
- Target: $0.00 de costo para estos casos

### Por qué es valioso
- Ahorro de costos/latencia en casos obvios
- Mejor UX: respuesta inmediata sin esperar al LLM

### Cómo se integra
- En Etapa 1: `src/agent/routing/layer-0.interceptor.ts`
- Antes de cualquier LLM call, intentar Layer 0

### Archivo de destino
`legacy-reference/concepts/layer-0-interceptor.md`

---

## 8. Concepto: TOOLS_BY_PROFILE

### No hay implementación, pero concepto importante
En el código viejo: idea de filtrar tools disponibles por rol del usuario.

### Qué rescatar
- Productor puede: crear flete, listar fletes propios, cargar documentos
- Transportista manager puede: postularse, listar cotizaciones, asignar chofer
- Transportista driver puede: reportar ubicación, marcar confirmaciones, firmar
- Planta puede: recibir camión, asignar turno descarga, marcar entrada/salida

### Por qué es valioso
- Seguridad: no invocar tools que el usuario no debería poder usar
- UX: mostrar solo opciones permitidas

### Cómo se integra
- En Etapa 1: durante orchestration, filtrar tools por `user.activeRole`

### Archivo de destino
`legacy-reference/concepts/tools-by-profile.md`

---

## 9. Edge cases y decisiones importantes

### Ubicaciones en el código viejo que tienen comentarios útiles

#### `src/agent-v2/nodes/extract-slots.node.ts` línea 10-15
```typescript
// Si estabamos esperando que el usuario elija entre matches ambiguos de ubicacion,
// intentar resolver su respuesta (button id, numero "1", o "otra" para ir al map).
```
**Idea**: cuando la búsqueda de ubicación devuelve múltiples matches, mostrar opciones numeradas antes de forzar el map picker.

#### `src/agent-v2/nodes/validate-slots.node.ts` (conceptual)
**Idea**: antes de pedir un dato, verificar si ya existe una ubicación guardada del usuario que matchee aproximadamente.

#### `src/agent-v2/nodes/ask-missing-slot.node.ts`
**Idea**: preguntar por todos los datos faltantes en un solo mensaje, con ejemplo, en lugar de uno por uno.

### Archivo de destino
`legacy-reference/edge-cases.md`

---

## 10. WhatsApp-specific constraints

### Archivo fuente
`src/agent-v2/renderers/whatsapp.renderer.ts` (comentarios y lógica)

### Qué guardar
- Max 3 interactive buttons per message
- Button title must be unique, max 20 chars
- If labels are similar and get truncated, use numbering ("1. Label") for uniqueness
- 24-hour window: use template messages if outside
- Typing indicator, read receipts available but not always used
- Location sharing works via button + requestLocation(type)

### Por qué es valioso
- Límites técnicos de la API Cloud de WhatsApp
- Decisiones de UX para trabajar dentro de esos límites

### Archivo de destino
`legacy-reference/whatsapp/constraints.md`

---

## 11. Configuración de Anthropic SDK (si existe)

### Archivo fuente
Buscar en `src/ai/` si hay alguna configuración de OpenAI SDK que valga mantener

Si existe `openai-config` o similar:
- Timeouts, retries, endpoints
- Fallback strategies

### Por qué es valioso
- Patterns de reintento, timeout handling
- Error handling patterns

### Cómo se integra
- En Etapa 1: adaptar a Anthropic SDK

### Archivo de destino
`legacy-reference/llm-config/`

---

## Estructura de legacy-reference/

Después de Etapa 0, el directorio debe verse así:

```
legacy-reference/
├── README.md                      ← índice y explicación
├── heuristics/
│   ├── extract-slots.backup.ts
│   ├── normalize-functions.ts
│   └── regex-patterns.md
├── catalogs/
│   ├── intents.backup.ts
│   ├── flows.backup.ts
│   └── synonyms.backup.ts
├── prompts/
│   ├── style.backup.ts
│   ├── restrictions.md
│   └── examples.md
├── renderers/
│   └── whatsapp.backup.ts
├── schemas/
│   ├── freight-slots.backup.ts
│   ├── intent.backup.ts
│   └── state-structure.backup.ts
├── whatsapp/
│   ├── constraints.md
│   └── template-examples.md
├── edge-cases.md
├── concepts/
│   ├── layer-0-interceptor.md
│   └── tools-by-profile.md
└── llm-config/
    └── (si hay configs útiles)
```

---

## Cómo usar legacy-reference durante el desarrollo

1. **Etapa 1**: referencia constantemente mientras construyes capa LLM, tools, prompts
2. **Etapa 2+**: cuando hagas nuevos flujos, copia estructura de rendering desde whatsapp.backup.ts
3. **Bug hunting**: si algo falla, busca patrón similar en legacy-reference para entender decisión original
4. **Refactor**: cuando tengas tiempo, revisa si hay mejor forma de hacer algo, pero documentá decisión

---

## Nota final

Estos archivos NO se integran directamente al código. Son **referencias**. A medida que construyas el nuevo sistema en Etapa 1+, vas a:
1. Leer fragmento de legacy-reference
2. Entender la idea
3. Implementar de nuevo forma, mejor diseñada, en el nuevo stack

Si algo de legacy-reference se puede copiar literal (ej. una función de normalización), está bien. Pero la mayoría va a ser "inspiración" más que "copia".

