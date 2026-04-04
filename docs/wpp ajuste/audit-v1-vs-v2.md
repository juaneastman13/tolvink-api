# Auditoría: PromptBuilder v1 → v2 (Haiku + Sonnet)

## Problemas del v1

### 1. CERO awareness de modelo dual

El v1 construye UN solo prompt para todos los casos. No hay concepto de "este mensaje es simple, podría ir a un modelo más barato". Toda consulta de estado, todo "hola", todo "mis fletes" paga $3/$15 de Sonnet cuando el 60-70% podría resolverse con Haiku a $1/$5.

**Impacto**: Estás pagando 3x de más en el 60-70% del tráfico.

### 2. Mismo prompt pesado para consultas simples

Un usuario escribe "mis fletes". El v1 le manda a Claude un prompt de ~4,500 tokens con instrucciones de cómo crear un flete one-shot, cómo asignar transportistas, cómo registrar gastos de flota... todo para que el modelo responda con `list_freights()`.

Es como llevar un manual de 50 páginas para contestar "¿qué hora es?".

### 3. Todas las tools siempre

El v1 envía las 57 tools en cada request. Un chofer que solo puede iniciar viaje y confirmar carga recibe tools de crear flete, asignar transportista, registrar gastos. Cada tool suma ~50-80 tokens de definición. 57 tools × ~65 tokens = ~3,700 tokens extra que se pagan en cada turno.

### 4. Sin mecanismo de escalamiento

Si Haiku recibe algo que no puede manejar, no hay forma de escalar a Sonnet. El v1 ni siquiera contempla esta posibilidad.

### 5. Fleet blocks mal manejados

El v1 appendea `STATIC_FLEET_MGMT + STATIC_FLEET_ECON` al bloque estático cuando el usuario tiene flota propia pero no es transportista. Pero lo hace en runtime, creando un nuevo string cada vez que aparece una combinación no pre-computada. Debería estar pre-computado.

### 6. La interfaz `PromptBlocks` no comunica qué modelo usar

Devuelve `system` y `contextMessage` pero no dice qué modelo usar ni qué tools filtrar. El consumidor tiene que adivinar.

---

## Qué resuelve el v2

### Arquitectura de 3 capas

```
Mensaje → Capa 0 (sin IA) → Capa 1 (Haiku) → Capa 2 (Sonnet)
               ↓                    ↓                  ↓
          Regex/Buttons         Consultas          Flujos complejos
          DB directa            Estado              Crear flete
          Greetings             Dashboard            Asignar
                                Detalle              Cancelar
                                                     Economía flota
```

### A. Router: decide modelo ANTES de construir el prompt

```typescript
import { routeMessage } from './prompt-builder-v2.service';

// En tu AIService:
const route = routeMessage(message, sessionState);
// → { model: 'haiku', reason: 'pattern:estado' }
// → { model: 'sonnet', reason: 'pattern:crear|nuevo|mandar' }
```

**Reglas del router:**

| Señal | Modelo | Ejemplo |
|-------|--------|---------|
| Flujo activo en sesión | Sonnet | Estaba creando un flete |
| Confirmación pendiente | Sonnet | Le preguntaste "¿Confirmás?" |
| Patrón de escritura | Sonnet | "mandá 30 de soja", "cancelalo" |
| Patrón de lectura | Haiku | "mis fletes", "estado", "dashboard" |
| Código de flete | Haiku | "F26-LCP.1822" |
| Mensaje corto sin señales | Haiku | "hola", "gracias" |
| Mensaje largo ambiguo | Sonnet | Párrafo sin patrones claros |

### B. Dos prompts, dos pesos

**Haiku (~1,500-2,000 tokens estáticos):**
- Identidad + tono + estados + safety (compartido)
- Reglas mínimas de búsqueda y flete activo
- Roles cortos (1-2 líneas por rol)
- Instrucción de escalamiento: "si piden crear/cancelar/asignar → escalate_to_sonnet"
- SIN create_freight, SIN assign_transport, SIN fleet_economics, SIN behavior detallado

**Sonnet (~3,500-4,500 tokens estáticos):**
- Todo lo compartido
- Reglas completas (core, behavior, selection)
- Roles completos
- Flujos complejos (create_freight, assign, fleet)
- Documents, locations

**Ahorro por prompt**: Un request de Haiku envía ~2,000 tokens de prompt vs ~5,000 de Sonnet. Combinado con el precio 3x menor de Haiku, un turno de consulta simple cuesta ~$0.002 vs ~$0.015 con Sonnet. 7.5x más barato.

### C. Tool filtering por tier Y por rol

```typescript
// Haiku: solo tools de lectura + escalate_to_sonnet
HAIKU_TOOLS = {
  get_dashboard, list_freights, get_freight_detail,
  list_trucks, get_truck_detail, search_plants,
  navigate_app, ...
}

// Sonnet: todas
SONNET_ONLY_TOOLS = {
  prepare_freight, confirm_create_freight, cancel_freight,
  assign_transporter, start_freight, confirm_loaded,
  register_truck_expense, ...
}
```

Además, se filtra por rol:
- Chofer: solo ~10 tools (de cualquier tier)
- Readonly: solo HAIKU_TOOLS (sin importar el tier)

**Impacto en tokens de tools**: Haiku con ~15 tools = ~975 tokens. Sonnet con ~40 tools = ~2,600 tokens. Chofer con ~10 tools = ~650 tokens.

### D. Escalamiento Haiku → Sonnet

Si Haiku no puede manejar el mensaje, tiene una tool `escalate_to_sonnet`. El flujo:

```
1. Usuario: "mandá 30 de soja a sofoval"
2. Router: no matchea patrón Sonnet (por la formulación)
3. → Haiku recibe el mensaje
4. Haiku: "Esto es crear flete, necesito escalar"
5. Haiku llama: escalate_to_sonnet({ reason: "create_freight" })
6. AIService detecta la tool → re-llama con Sonnet prompt completo
7. Sonnet procesa la creación normalmente
```

**Costo del escalamiento**: Pagás la llamada a Haiku (~$0.002) + la llamada a Sonnet (~$0.015) = ~$0.017. Es ~13% más caro que ir directo a Sonnet en ese caso. Pero como el 60-70% NO escala, el ahorro neto es enorme.

**Implementación de escalate_to_sonnet:**
```typescript
// En tus tool definitions:
{
  name: 'escalate_to_sonnet',
  description: 'Usar cuando el usuario pide una acción que no podés ejecutar: crear/cancelar/asignar flete, iniciar viaje, confirmar carga/entrega, registrar gastos, adjuntar documentos. Respondé "Dame un momento" y llamá esta tool.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Qué acción necesita el usuario'
      }
    },
    required: ['reason']
  }
}

// En tu AIService, después de la respuesta de Haiku:
const escalation = response.content.find(
  b => b.type === 'tool_use' && b.name === 'escalate_to_sonnet'
);
if (escalation) {
  this.logger.log('Haiku escalated', { reason: escalation.input.reason });
  // Re-llamar con Sonnet
  const sonnetPrompt = await this.promptBuilder.build(user, companyType, isWeb, plantAccessMap, 'sonnet');
  // ... construir messages y llamar con MODELS.sonnet
}
```

### E. Interfaz `PromptBlocks` completa

```typescript
interface PromptBlocks {
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  contextMessage?: string;
  model: ModelTier;        // ← NEW: qué modelo usar
  toolFilter: Set<string>; // ← NEW: qué tools enviar
  routeReason: string;     // ← NEW: para logging
}
```

El consumidor no adivina: `build()` le dice todo.

---

## Estimación de costos comparativa

### Escenario: 1,000 conversaciones/mes, 8 turnos promedio

**Distribución estimada**: 65% Haiku, 30% Sonnet directo, 5% Haiku→Sonnet escalado.

| Concepto | v1 (solo Sonnet) | v2 (Haiku + Sonnet) |
|----------|-----------------|---------------------|
| Turnos Haiku (5,200) | — | 5,200 × 2,800 tokens × $1/M = $14.56 |
| Turnos Sonnet (2,400) | — | 2,400 × 7,500 tokens × $3/M = $54.00 |
| Escalamientos (400) | — | 400 × 2,800 × $1/M = $1.12 (extra Haiku) |
| Prompt caching (90% reads) | Ahorra ~70% | Ahorra ~70% sobre los números de arriba |
| **Total input/mes** | ~$69 (v1 con caching) | ~$21 |
| Output Haiku (5,200 × 400 tokens) | — | 5,200 × 400 × $5/M = $10.40 |
| Output Sonnet (2,800 × 500 tokens) | — | 2,800 × 500 × $15/M = $21.00 |
| **Total output/mes** | ~$48 | ~$31 |
| **TOTAL** | **~$117/mes** | **~$52/mes** |

**Ahorro: ~55% adicional sobre el v1 ya optimizado.**

Comparado con el original sin optimizar (~$420/mes): **ahorro total ~88%**.

---

## Cosas que NO cambié (y por qué)

1. **Las queries de Prisma en buildProactiveData**: Son las mismas. El refactor es de prompt/routing, no de data layer.

2. **La lógica de plantAccessMap**: Funciona bien, solo la comprimí en el output.

3. **La estructura de resolveActiveRole/resolveCompanyTypes**: Son utils externos que no tocar.

4. **El manejo de ownFleet para producer**: La lógica de appendear fleet blocks sigue igual, solo pre-computo la variante `+fleet`.

---

## Riesgos y mitigaciones

### Haiku no entiende el contexto complejo
**Riesgo**: Haiku podría no interpretar bien mensajes ambiguos.
**Mitigación**: Default a Sonnet para mensajes largos (>30 chars sin patrón claro). Haiku tiene instrucción explícita de escalar si no puede.

### Falsos positivos del router
**Riesgo**: El router manda a Haiku algo que necesita Sonnet (ej: "mandame el resumen" se parsea como "mandar" → Sonnet, pero era consulta).
**Mitigación**: Los patrones de Sonnet son específicos (requieren contexto de flete/carga). "mandame el resumen" no matchea porque no tiene "flete"/"carga" después de "mandá". Monitorear tasa de escalamiento; si >15%, ajustar patrones.

### Cache fragmentation
**Riesgo**: Con 2 tiers × N roles × 2 canales, hay más variantes de cache.
**Mitigación**: Pre-computados al inicio. Haiku tiene menos combinaciones relevantes. En la práctica, 3-4 combinaciones concentran el 90% del tráfico.

### Haiku pierde contexto en conversaciones largas
**Riesgo**: Si una conversación empieza con Haiku y escala a Sonnet, el historial fue generado con respuestas de Haiku.
**Mitigación**: Las respuestas de Haiku para consultas son cortas y factuales. Sonnet las entiende bien en el historial. No hay degradación práctica.

---

## Checklist de implementación

- [ ] Agregar `routeMessage()` al AIService antes de `build()`
- [ ] Agregar tool `escalate_to_sonnet` a las definiciones
- [ ] Manejar escalamiento en el loop de respuesta
- [ ] Actualizar logging para incluir `model`, `routeReason`, `toolCount`
- [ ] Filtrar tools con `prompt.toolFilter` antes de enviar
- [ ] Agregar métrica: % requests por modelo, % escalamientos
- [ ] A/B test primera semana: 50% v1 / 50% v2, comparar calidad + costo
- [ ] Alerta si tasa de escalamiento > 15% (indica patrones del router mal calibrados)
- [ ] Alerta si Haiku produce respuestas con "no puedo"/"no tengo esa herramienta" sin escalar
