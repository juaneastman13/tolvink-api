# Instrucciones para Claude Code: Refactoring PromptBuilder Haiku/Sonnet

## Contexto del proyecto

Este es un backend NestJS para Tolvink, plataforma de logística de fletes de granos en Uruguay. El módulo de AI tiene un agente de WhatsApp (y web chat) que usa Claude Sonnet con ~57 tools. El objetivo es refactorizar el sistema para usar Haiku para consultas simples y Sonnet para flujos complejos, reduciendo costos ~55%.

## Arquitectura actual

```
src/
  ai/
    ai.module.ts
    ai.service.ts              ← Servicio principal que llama a Claude
    ai.constants.ts
    ai.utils.ts
    prompt/
      prompt-builder.service.ts  ← REEMPLAZAR con v2
    tools/
      *.tool.ts                  ← Definiciones de tools
```

## Tareas a ejecutar (en orden)

### Tarea 1: Reemplazar PromptBuilderService

Reemplazar `src/ai/prompt/prompt-builder.service.ts` con el contenido del archivo adjunto `prompt-builder-v2.service.ts`.

Verificar que los imports de `ai.constants` y `ai.utils` sean correctos según la estructura real del proyecto. Los imports esperados son:
- `URUGUAY_UTC_OFFSET_MS`, `FREIGHT_STATUS_SHORT`, `APP_URL` desde `ai.constants`
- `resolveActiveRole`, `resolveCompanyTypes`, `hasType`, `sanitizeForPrompt`, `isProducerMembership` desde `ai.utils`

Si los paths son distintos, ajustarlos.

### Tarea 2: Crear el tool `escalate_to_sonnet`

Buscar dónde se definen las tools (probablemente un archivo de definiciones o array en el servicio de AI). Agregar esta tool:

```typescript
{
  name: 'escalate_to_sonnet',
  description: 'Usar cuando el usuario pide una acción que no podés ejecutar con tus herramientas disponibles: crear flete, cancelar, asignar transportista, iniciar viaje, confirmar carga/entrega, registrar gastos, adjuntar documentos, autorizar. Respondé "Dame un momento que proceso eso" y llamá esta tool.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Breve descripción de qué acción necesita el usuario. Ej: "create_freight", "cancel_freight", "assign_transporter", "start_trip", "register_expense"'
      },
      user_message: {
        type: 'string',
        description: 'El mensaje original del usuario que necesita procesamiento complejo'
      }
    },
    required: ['reason']
  }
}
```

Esta tool NO necesita handler real — se intercepta antes de ejecutar (ver Tarea 4).

### Tarea 3: Crear constantes de modelos

En `ai.constants.ts`, agregar:

```typescript
export const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6-20260401',
} as const;

export type ModelTier = keyof typeof MODELS;
```

Si ya existe una constante de modelo, reemplazarla con este map.

### Tarea 4: Refactorizar AIService

Este es el cambio más importante. Buscar el servicio que actualmente:
1. Construye el prompt con `promptBuilder.build()`
2. Arma los messages
3. Llama a la API de Anthropic
4. Procesa la respuesta y ejecuta tools

Refactorizar siguiendo este patrón:

```typescript
import { routeMessage, MODELS, HAIKU_TOOLS, SONNET_ONLY_TOOLS } from './prompt/prompt-builder.service';
// O desde donde estén exportados

async handleMessage(
  user: any,
  message: string,
  companyType: string,
  isWeb: boolean,
  plantAccessMap?: Map<string, string>,
  sessionState?: { activeFlow?: string; pendingConfirmation?: boolean },
) {
  // ═══ PASO 1: Router decide modelo ═══
  const route = routeMessage(message, sessionState);

  // ═══ PASO 2: Build prompt para el tier elegido ═══
  const prompt = await this.promptBuilder.build(
    user, companyType, isWeb, plantAccessMap, route.model,
  );

  // ═══ PASO 3: Filtrar tools ═══
  const filteredTools = this.allToolDefinitions
    .filter(t => prompt.toolFilter.has(t.name))
    .map((tool, i, arr) => ({
      ...tool,
      // Cache control en la última tool
      ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));

  // ═══ PASO 4: Armar messages ═══
  const messages = [];
  // Inyectar contexto proactivo solo en el primer turno de la sesión
  if (prompt.contextMessage && this.isFirstTurn(sessionId)) {
    messages.push({ role: 'user', content: prompt.contextMessage });
    messages.push({ role: 'assistant', content: 'Entendido.' });
  }
  messages.push(...this.getConversationHistory(sessionId));
  messages.push({ role: 'user', content: message });

  // ═══ PASO 5: Llamar a la API ═══
  this.logger.log('LLM call', {
    model: route.model,
    reason: route.reason,
    toolCount: filteredTools.length,
    systemTokensEstimate: prompt.system.reduce((acc, b) => acc + b.text.length / 4, 0),
  });

  let response = await this.anthropic.messages.create({
    model: MODELS[route.model],
    max_tokens: route.model === 'haiku' ? 512 : 4096,
    system: prompt.system,
    tools: filteredTools,
    messages,
  });

  // ═══ PASO 6: Detectar escalamiento ═══
  const escalation = response.content.find(
    (b: any) => b.type === 'tool_use' && b.name === 'escalate_to_sonnet',
  );

  if (escalation) {
    this.logger.log('Escalating Haiku → Sonnet', {
      reason: escalation.input?.reason,
      originalRoute: route.reason,
    });

    // Re-build con Sonnet
    const sonnetPrompt = await this.promptBuilder.build(
      user, companyType, isWeb, plantAccessMap, 'sonnet',
    );

    const sonnetTools = this.allToolDefinitions
      .filter(t => sonnetPrompt.toolFilter.has(t.name))
      .map((tool, i, arr) => ({
        ...tool,
        ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
      }));

    // Re-armar messages (sin el intento de Haiku)
    const sonnetMessages = [];
    if (sonnetPrompt.contextMessage && this.isFirstTurn(sessionId)) {
      sonnetMessages.push({ role: 'user', content: sonnetPrompt.contextMessage });
      sonnetMessages.push({ role: 'assistant', content: 'Entendido.' });
    }
    sonnetMessages.push(...this.getConversationHistory(sessionId));
    sonnetMessages.push({ role: 'user', content: message });

    response = await this.anthropic.messages.create({
      model: MODELS.sonnet,
      max_tokens: 4096,
      system: sonnetPrompt.system,
      tools: sonnetTools,
      messages: sonnetMessages,
    });
  }

  // ═══ PASO 7: Procesar respuesta (tool loop existente) ═══
  // ... el loop de ejecución de tools que ya tenés sigue igual
  // Solo asegurate de que el loop use el modelo correcto si necesita re-llamar:
  // const currentModel = escalation ? MODELS.sonnet : MODELS[route.model];

  // ═══ PASO 8: Logging de costos ═══
  this.logger.log('LLM response', {
    model: escalation ? 'sonnet' : route.model,
    escalated: !!escalation,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheRead: response.usage.cache_read_input_tokens ?? 0,
    cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
    toolsUsed: response.content
      .filter((b: any) => b.type === 'tool_use')
      .map((b: any) => b.name),
  });
}
```

IMPORTANTE: Este es un PATRÓN, no copy-paste literal. Adaptarlo a la estructura real del AIService:
- Buscar cómo se llama actualmente a la API de Anthropic (puede ser `this.anthropic.messages.create`, un wrapper, o un SDK custom)
- Buscar cómo se maneja el historial de conversación (Redis, memoria, Prisma)
- Buscar cómo se ejecuta el tool loop (probablemente un while con tool_use → execute → re-call)
- El tool loop existente debe mantener el modelo elegido (Haiku o Sonnet) durante toda la conversación, no volver a rutear

### Tarea 5: Actualizar el tool loop para mantener modelo

Dentro del loop de ejecución de tools (donde se detecta `tool_use` en la respuesta, se ejecuta la tool, y se re-llama a Claude), asegurarse de que:

1. El modelo usado sea consistente durante todo el loop (no re-rutear en cada iteración)
2. Si hubo escalamiento, el resto del loop use Sonnet
3. El `system` prompt y `tools` filtradas se mantengan iguales en todo el loop

Buscar algo como:
```typescript
// Patrón existente probable:
while (response.stop_reason === 'tool_use') {
  // ejecutar tools...
  response = await this.anthropic.messages.create({
    model: MODEL_NAME,  // ← AQUÍ: usar el modelo decidido, no hardcodeado
    system: systemPrompt, // ← AQUÍ: usar el system del prompt construido
    tools: tools,         // ← AQUÍ: usar las tools filtradas
    messages: updatedMessages,
  });
}
```

### Tarea 6: Actualizar sessionState para el router

El router necesita saber si hay un flujo activo. Buscar dónde se guarda el estado de la sesión (probablemente Redis) y asegurarse de que se trackee:

```typescript
interface SessionState {
  // ... campos existentes ...
  activeFlow?: string;           // 'create_freight' | 'assign_transport' | etc.
  pendingConfirmation?: boolean; // true si se envió un prepare_ y se espera confirm
}
```

Estos campos probablemente ya existen de alguna forma. Mapearlos a lo que usa `routeMessage()`. Si no existen, agregarlos:

- `activeFlow`: setear cuando se llama a `prepare_freight`, `prepare_*`, etc. Limpiar cuando se ejecuta `confirm_*` o el usuario cambia de tema.
- `pendingConfirmation`: setear cuando la respuesta incluye un resumen de confirmación. Limpiar al confirmar o cancelar.

### Tarea 7: Registrar el servicio en el módulo

Si `PromptBuilderService` ya está registrado en `ai.module.ts`, no se necesita cambio. Solo verificar que implemente `OnModuleInit` (ya lo hace en v2) y que NestJS lo detecte.

Si usa `@Module({ providers: [...] })`, debería estar incluido. Verificar.

### Tarea 8: Agregar max_tokens diferenciado

En todas las llamadas a la API, usar max_tokens según el modelo:

```typescript
max_tokens: currentModel === MODELS.haiku ? 512 : 4096
```

Haiku para consultas simples no necesita generar más de 512 tokens. Esto también funciona como safety net: si Haiku intenta generar una respuesta larga (señal de que está fuera de su alcance), se corta.

### Tarea 9: Tests

Crear tests para el router:

```typescript
describe('routeMessage', () => {
  it('routes greetings to haiku', () => {
    expect(routeMessage('hola').model).toBe('haiku');
    expect(routeMessage('buenas tardes').model).toBe('haiku');
  });

  it('routes status queries to haiku', () => {
    expect(routeMessage('mis fletes').model).toBe('haiku');
    expect(routeMessage('cómo va el F26-LCP.1822').model).toBe('haiku');
    expect(routeMessage('dashboard').model).toBe('haiku');
  });

  it('routes create freight to sonnet', () => {
    expect(routeMessage('mandá 30 de soja a sofoval').model).toBe('sonnet');
    expect(routeMessage('crear flete nuevo').model).toBe('sonnet');
    expect(routeMessage('quiero enviar una carga').model).toBe('sonnet');
  });

  it('routes cancellations to sonnet', () => {
    expect(routeMessage('cancelá el flete').model).toBe('sonnet');
  });

  it('routes confirmations to sonnet', () => {
    expect(routeMessage('ya cargué').model).toBe('sonnet');
    expect(routeMessage('ya llegué').model).toBe('sonnet');
    expect(routeMessage('iniciá el viaje').model).toBe('sonnet');
  });

  it('routes active flows to sonnet', () => {
    expect(routeMessage('dale', { activeFlow: 'create_freight' }).model).toBe('sonnet');
    expect(routeMessage('sí', { pendingConfirmation: true }).model).toBe('sonnet');
  });

  it('routes freight codes to haiku', () => {
    expect(routeMessage('F26-LCP.1822').model).toBe('haiku');
  });

  it('routes short ambiguous to haiku', () => {
    expect(routeMessage('ok').model).toBe('haiku');
    expect(routeMessage('gracias').model).toBe('haiku');
  });

  it('routes long ambiguous to sonnet', () => {
    expect(routeMessage('necesito organizar el transporte de grano para la semana que viene con varios camiones').model).toBe('sonnet');
  });
});

describe('PromptBuilderService', () => {
  // Testear que build() con tier='haiku' genera prompts más cortos
  it('haiku prompt is shorter than sonnet', async () => {
    const haiku = await service.build(mockUser, 'producer', false, undefined, 'haiku');
    const sonnet = await service.build(mockUser, 'producer', false, undefined, 'sonnet');
    const haikuLen = haiku.system.reduce((a, b) => a + b.text.length, 0);
    const sonnetLen = sonnet.system.reduce((a, b) => a + b.text.length, 0);
    expect(haikuLen).toBeLessThan(sonnetLen * 0.6); // Haiku debe ser <60% del tamaño
  });

  // Testear que haiku toolFilter no incluye tools de escritura
  it('haiku tools are read-only', async () => {
    const result = await service.build(mockUser, 'producer', false, undefined, 'haiku');
    expect(result.toolFilter.has('prepare_freight')).toBe(false);
    expect(result.toolFilter.has('cancel_freight')).toBe(false);
    expect(result.toolFilter.has('list_freights')).toBe(true);
    expect(result.toolFilter.has('escalate_to_sonnet')).toBe(true);
  });

  // Testear que sonnet incluye todas las tools
  it('sonnet includes write tools', async () => {
    const result = await service.build(mockUser, 'producer', false, undefined, 'sonnet');
    expect(result.toolFilter.has('prepare_freight')).toBe(true);
    expect(result.toolFilter.has('list_freights')).toBe(true);
  });

  // Testear chofer tool filtering
  it('chofer gets minimal tools regardless of tier', async () => {
    const result = await service.build(mockChofer, 'transporter', false, undefined, 'sonnet');
    expect(result.toolFilter.has('prepare_freight')).toBe(false);
    expect(result.toolFilter.has('start_freight')).toBe(true);
    expect(result.toolFilter.size).toBeLessThan(15);
  });
});
```

### Tarea 10: Logging y métricas

Agregar o actualizar logging para poder monitorear:

```typescript
// Después de cada respuesta, loguear:
{
  event: 'llm_call',
  model: 'haiku' | 'sonnet',
  escalated: boolean,
  routeReason: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  toolCount: number,
  toolsUsed: string[],
  latencyMs: number,
  estimatedCostUsd: number, // calcular con los precios
}
```

Función helper para estimar costo:

```typescript
function estimateCost(
  model: ModelTier,
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number },
): number {
  const prices = {
    haiku: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  };
  const p = prices[model];
  const regularInput = usage.input_tokens - (usage.cache_read_input_tokens ?? 0) - (usage.cache_creation_input_tokens ?? 0);
  return (
    (regularInput * p.input +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      usage.output_tokens * p.output) /
    1_000_000
  );
}
```

## Orden de ejecución

1. Leer el código actual del proyecto para entender la estructura real
2. Tarea 3 (constantes) — es un cambio chico sin riesgo
3. Tarea 1 (reemplazar prompt builder) — el cambio más grande
4. Tarea 2 (tool escalate_to_sonnet)
5. Tarea 4 + 5 (refactorizar AIService + tool loop)
6. Tarea 6 (sessionState)
7. Tarea 7 (verificar módulo)
8. Tarea 8 (max_tokens)
9. Tarea 9 (tests)
10. Tarea 10 (logging)

## Verificación post-implementación

Después de implementar, verificar:

1. `npm run build` compila sin errores
2. Los tests del router pasan
3. Los tests del prompt builder pasan
4. Hacer una llamada manual simulando un "hola" → debe usar Haiku
5. Hacer una llamada simulando "mandá 30 de soja a sofoval" → debe usar Sonnet
6. Verificar en logs que `cache_read_input_tokens > 0` después del primer request
7. Verificar que el tool loop mantiene el modelo durante toda la ejecución

## Archivos de referencia

Los archivos generados están en:
- `prompt-builder-v2.service.ts` — El nuevo PromptBuilderService completo
- `audit-v1-vs-v2.md` — Documentación de los cambios y por qué

## Notas importantes

- NO borrar el archivo original hasta verificar que todo funciona. Renombrarlo a `prompt-builder.service.old.ts`.
- El `routeMessage()` y los sets `HAIKU_TOOLS`/`SONNET_ONLY_TOOLS` están en el mismo archivo del prompt builder. Si el proyecto prefiere separarlos, extraer a `src/ai/router/message-router.ts`.
- Los nombres de tools en `HAIKU_TOOLS` y `SONNET_ONLY_TOOLS` deben coincidir EXACTAMENTE con los `name` de las definiciones de tools del proyecto. Verificar cruzando con las definiciones reales.
- Si hay tools que no están en ninguno de los dos sets, agregarlas al set correspondiente según si son de lectura (Haiku) o escritura (Sonnet).
