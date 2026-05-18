# Plan de Demolición - Etapa 0

## 1. Archivos a borrar completamente

Estructura completa del agente viejo (Gemini + LangGraph):

```
src/agent-v2/                          (directorio completo)
src/ai/                                (directorio completo — solo AI con Gemini)
```

Archivos específicos a borrar:

### Agent-v2 (80 archivos, ~15 KLOC)
- `src/agent-v2/__tests__/agent-v2.spec.ts`
- `src/agent-v2/agent-v2.module.ts`
- `src/agent-v2/agent-v2.service.ts`
- `src/agent-v2/catalogs/*.ts` (4 archivos)
- `src/agent-v2/checkpoints/*.ts` (2 archivos)
- `src/agent-v2/flows/*.ts` (10 archivos de máquinas de estado)
- `src/agent-v2/graphs/*.ts` (6 archivos de grafos LangGraph)
- `src/agent-v2/nodes/*.ts` (15 archivos de nodos)
- `src/agent-v2/policies/*.ts` (6 archivos de políticas)
- `src/agent-v2/prompts/*.ts` (4 archivos de prompts)
- `src/agent-v2/renderers/whatsapp.renderer.ts`
- `src/agent-v2/schemas/*.ts` (4 archivos)
- `src/agent-v2/tools/*.ts` (5 archivos)
- `src/agent-v2/utils/freight-code.ts`

### AI module (Gemini client)
- `src/ai/ai.module.ts`
- `src/ai/agent.service.ts`
- `src/ai/core/gemini.client.ts`
- `src/ai/core/llm-provider.ts`
- `src/ai/tools/tool-definitions.ts`
- `src/ai/tools/tool-executor.ts`
- `src/ai/tools/*.ts` (si hay más)

### Tests del agente viejo
- Cualquier test que importe AgentV2 o agent-v2
- `src/agent-v2/__tests__/*`

---

## 2. Dependencias a remover de `package.json`

**LangChain stack:**
- `@langchain/core` (v1.1.39)
- `@langchain/langgraph` (v1.2.8)
- `@langchain/openai` (v1.4.3)
- `langchain` (v1.3.1)

**Gemini:**
- `@google/genai` (v1.48.0)

**OpenAI (será reemplazado por Anthropic):**
- `openai` (v6.22.0) — SOLO si no se usa en otro lado del backend

**Verificar antes de remover:**
- Buscar en el repo si `openai` se usa en `ocr.module` o `OcrService`
  - Si OcrService usa OpenAI para Whisper, mantener `openai`
  - Si no, remover

---

## 3. Tablas Prisma a eliminar o modificar

Tablas específicas del agente viejo (ver `prisma/schema.prisma`):

### A eliminar (no quedan datos importantes):
- `WhatsAppSession` — controlador de sesión de LangGraph
- `WhatsAppMessageLog` — logs de mensajes (reemplazados por `agent_message_history` en Etapa 1)

### A mantener pero limpiar:
- `Conversation` — ya existe, se preserva para web chat, pero el agente viejo la usa diferente
- `Message` — ya existe, id mantiene pero se rediseña su relación con el agente
- Cualquier otra tabla no es específica del agente

### Nuevas tablas a crear en Etapa 1:
- `agent_conversation_state`
- `agent_outbound_messages_queue`
- `agent_session_tokens`
- `agent_audit_log`
- `agent_message_history`
- `agent_whatsapp_templates`

---

## 4. Variables de entorno a remover

En `.env.example` y `.env` (si existen):

- `AGENT_MODE` (legacy/v2 switch)
- `AGENT_V2_ENABLE_REAL_FREIGHT_CREATE`
- `AI_PROVIDER` (gemini)
- `GEMINI_MODEL` (gemini-2.5-pro)
- `GEMINI_FALLBACK_MODEL` (gemini-2.5-flash)
- `GEMINI_MAX_OUTPUT_TOKENS`
- `GEMINI_TEMPERATURE`
- `GEMINI_REQUEST_TIMEOUT_MS`
- `GEMINI_API_KEY`

### Variables a agregar en Etapa 1:
- `ANTHROPIC_API_KEY`
- `WHATSAPP_PHONE_NUMBER_ID` (ya existe?)
- `WHATSAPP_ACCESS_TOKEN` (ya existe?)
- `WHATSAPP_VERIFY_TOKEN` (ya existe?)
- `WHATSAPP_APP_SECRET` (ya existe?)
- `REDIS_URL` (ya existe?)
- `GOOGLE_MAPS_API_KEY` (ya existe?)
- `S3_BUCKET` / equivalente (ya existe?)

---

## 5. Imports y módulos a limpiar en NestJS

En `src/whatsapp/whatsapp.module.ts`:
- Remover import de `AgentV2Module`
- Remover import de `AiModule` (forwardRef)
- Mantener `FreightsModule`

En `src/app.module.ts`:
- Verificar que no hay import de `AgentV2Module`

En cualquier archivo que importe:
- `GeminiClient` — desaparecer
- `AgentV2Service` — desaparecer
- `agent-v2/` — desaparecer
- `ai/` (excepto tipos comunes si hay)

---

## 6. Archivos a preservar como referencia

Estos van a `legacy-reference/` (no se borran, se archivan):

### Heurísticos en español
- `src/agent-v2/nodes/extract-slots.node.ts` — funciones de normalización, parseo de fechas, productos, ubicaciones
  - `normalize()`, `normalizeTime()`, `cleanPlace()`, `extractCreateFreightSlotsHeuristic()`
  - Regexes de ejemplo: productos (soja|maiz|trigo|...), fechas (hoy|manana|ISO), horas (HH:MM + am/pm)
  - Estructura "desde X ... a/hasta Y" para ubicaciones

### Plantillas de WhatsApp
- Cualquier plantilla ya aprobada por Meta en el código
- Estructura de botones, límites de caracteres, etc.

### Catalogs útiles
- `src/agent-v2/catalogs/intents.catalog.ts` — mapa de intents reconocidos
- `src/agent-v2/catalogs/flows.catalog.ts` — flujos disponibles
- Estos son metadatos, no código ejecutable

### Estilos y tono
- `src/agent-v2/prompts/base.prompt.ts` — base del prompt style (rioplatense, breve, etc.)
- `src/agent-v2/prompts/response-style.prompt.ts` — restricciones de respuesta
- `src/agent-v2/renderers/whatsapp.renderer.ts` — métodos de rendering de mensajes (estructura de botones, listas, etc.)

### Schemas útiles
- `src/agent-v2/schemas/freight.schema.ts` — estructura de slots para creación de fletes (como referencia)
- `src/agent-v2/schemas/intent.schema.ts` — tipos de intents

### Concepto: Layer 0 Interceptor
- En el código viejo: respuestas sin LLM para casos triviales (saludos, etc.)
- Sistema a recuperar en Etapa 1

### Concepto: TOOLS_BY_PROFILE
- Sistema de permisos por rol para qué tools puede usar cada usuario
- No implementación, solo concepto

### Edge cases documentados
- Comentarios en nodos que expliquen decisiones no obvias
- Por ejemplo: por qué se pregunta un solo dato por vez, etc.

---

## 7. Tablas Prisma exactas a eliminar

Migration SQL a generar:

```sql
-- Eliminar tablas específicas del agente viejo
DROP TABLE IF EXISTS "WhatsAppSession" CASCADE;
DROP TABLE IF EXISTS "WhatsAppMessageLog" CASCADE;

-- Nota: Conversation y Message se mantienen pero se rediseñan en Etapa 1
```

O en Prisma migration:
```prisma
// prisma/migrations/XXX_remove_old_agent_tables/migration.sql
DROP TABLE IF EXISTS "WhatsAppSession" CASCADE;
DROP TABLE IF EXISTS "WhatsAppMessageLog" CASCADE;
```

---

## 8. Limpieza de imports rotos

Después de borrar `agent-v2/` e `ai/`, buscar imports rotos con:

```bash
grep -r "from.*agent-v2" src/
grep -r "from.*ai/" src/
grep -r "GeminiClient" src/
grep -r "AgentV2Service" src/
```

Limpiar cualquier import encontrado.

---

## 9. Tests a verificar post-demolición

Después de borrar, correr:

```bash
npm run test 2>&1 | grep -E "FAIL|PASS|test suites"
```

Resultado esperado:
- Tests del agente viejo: desaparecen
- Tests del rest del backend: todos PASS
- Módulos de NestJS cargan sin error

---

## 10. Estructura del repo post-demolición

```
tolvink-api/
├── src/
│   ├── agent/                   ← NUEVA (vacía, se llena en Etapa 1)
│   ├── whatsapp/                ← EXISTENTE, se actualiza
│   ├── freights/                ← SIN CAMBIOS
│   ├── auth/                    ← SIN CAMBIOS
│   ├── common/                  ← SIN CAMBIOS
│   ├── database/                ← SIN CAMBIOS
│   └── ... (resto igual)
├── legacy-reference/            ← NUEVA (archivos preservados para referencia)
│   ├── heuristics/
│   ├── prompts/
│   ├── catalogs/
│   └── ...
├── prisma/
│   ├── migrations/              ← nuevas migrations para Etapa 0
│   └── schema.prisma            ← tablas viejas eliminadas
├── package.json                 ← dependencias old agent removidas
├── .env.example                 ← vars de gemini/langchain removidas, anthropic agregadas
└── DEMOLITION_PLAN.md           ← este archivo
```

---

## 11. Checklist de demolición (para hacer después de confirmación)

- [ ] Backup: `git tag etapa-0-pre-demolition` en commit actual
- [ ] Remover imports de `AgentV2Module` en whatsapp.module.ts
- [ ] Remover imports de `AiModule` en whatsapp.module.ts
- [ ] Borrar `src/agent-v2/` completo
- [ ] Borrar `src/ai/` completo
- [ ] Copiar archivos a preservar a `legacy-reference/`
- [ ] Remover dependencias en `package.json`
- [ ] Crear migración Prisma para eliminar tablas viejas
- [ ] Limpiar imports rotos en el código
- [ ] Correr `npm install` y `npm run build`
- [ ] Correr tests: `npm test`
- [ ] Crear estructura vacía de `src/agent/` con estructura de carpetas
- [ ] Generar `ETAPA_0_REPORT.md`
- [ ] Hacer commit: "Etapa 0: demolición de agent-v2 (Gemini + LangGraph)"

---

## Notas

1. **No tocamos whatsapp.module.ts controlador** — solo limpiamos imports
2. **Conversation y Message tables se mantienen** — pero su significado cambia en Etapa 1
3. **OCR module**: verificar si usa OpenAI antes de remover `openai` del package.json
4. **Zona segura**: FreightsModule, AuthModule, todos los servicios de dominio quedan intactos
5. **Base de datos**: no se pierden datos de fletes, usuarios, etc. — solo metadata del agente viejo

