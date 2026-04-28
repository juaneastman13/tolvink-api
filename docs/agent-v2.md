# Agent V2 WhatsApp

## Objetivo

Agent V2 es la base modular para operar Tolvink por WhatsApp sin depender de un mega prompt. El agente interpreta lenguaje natural, LangGraph orquesta pasos, las policies validan riesgo/permisos, las tools llaman servicios internos y el renderer arma respuestas para WhatsApp.

## Legacy y V2

- `src/ai`: agente legacy preservado.
- `src/agent-v2`: agente nuevo.
- `AGENT_MODE=legacy`: usa legacy.
- `AGENT_MODE=v2`: usa Agent V2.
- Sin `AGENT_MODE` o con valor invalido: fallback a legacy.

## Variables de entorno

- `AGENT_MODE=legacy|v2`
- `AGENT_V2_ENABLE_REAL_FREIGHT_CREATE=true|false`

La creacion real de fletes queda desactivada por defecto. Aunque se active, Agent V2 bloquea la creacion si falta lat/lng valida de origen y destino.

## Flujo general

```text
WhatsApp Webhook
-> Message Router
-> AgentV2Service
-> Session checkpoint from WhatsAppSession.flowState.agentV2
-> main.graph
-> intent router
-> freight graph / query flow
-> policy
-> tool
-> renderer
-> WhatsApp
```

## LangGraph

`main.graph.ts` carga estado, detecta intent, enruta y ejecuta subflujos. `freight.graph.ts` modela `create_freight` con conditional edges reales:

```text
START
-> extractSlots
-> validateSlots
-> askMissingSlot | askLocation | checkPolicy
-> prepareConfirmation
-> END

START
-> resolveConfirmation
-> executeAction | cancelPendingAction | askConfirmationAgain
-> END
```

Las pausas de WhatsApp se representan con `shouldPause` + checkpoint persistente en `WhatsAppSession.flowState.agentV2`. No se usa aun un checkpointer Postgres/Redis nativo de LangGraph; existe `AgentCheckpointStore` para migrarlo sin cambiar el contrato.

## State

`AgentState` contiene:

- canal, usuario, telefono, empresa activa y rol
- intent, flow y step actual
- slots conversacionales
- ubicacion de origen/destino georreferenciada
- pending action/confirmation
- idempotencia basica de acciones
- `auditTrail`, `nodeHistory`, `toolCalls`, `errors` con reducers acotados

## Create Freight

El flujo:

1. Extrae slots: producto, origen, destino, fecha, hora, camiones, observaciones.
2. Pregunta un dato faltante por vez.
3. Exige ubicacion exacta de origen por pin de WhatsApp.
4. Exige ubicacion exacta de destino por pin de WhatsApp.
5. Valida policy.
6. Presenta resumen.
7. Espera confirmacion explicita.
8. Ejecuta tool.

Resultado:

- Flag real apagado: responde "Pre-solicitud preparada".
- Flag real prendido + coordenadas validas: crea flete real.
- Coordenadas faltantes: no crea.

## Query Freights

Flujo read-only inicial:

- "que fletes tengo hoy"
- "viajes para manana"
- "mis fletes activos"
- "fletes pendientes"
- "detalle del flete F-123"
- "como va ese viaje" si hay `activeFreightCode`

Las tools filtran por empresa activa y relacion con el flete/chofer.

## Agregar un flujo

1. Agregar intent en `schemas/intent.schema.ts` y `catalogs/intents.catalog.ts`.
2. Crear flow en `flows`.
3. Crear nodes reutilizables si necesita state machine.
4. Conectar en `main.graph.ts`.
5. Agregar policy antes de cualquier mutacion.
6. Agregar renderer especifico.
7. Agregar tests de routing, policy y tool.

## Agregar una tool

1. Definir input tipado con Zod o TypeScript estricto.
2. Validar permisos/contexto antes de ejecutar.
3. Usar servicios internos, no DB directa desde el LLM.
4. Auditar mutaciones.
5. Agregar idempotency key si tiene efectos secundarios.

## Pruebas manuales

```text
AGENT_MODE=v2
AGENT_V2_ENABLE_REAL_FREIGHT_CREATE=false
```

Casos:

1. "Necesito 2 camiones manana para soja desde Ombues a Palmira"
2. Enviar ubicacion de origen por WhatsApp.
3. Enviar ubicacion de destino por WhatsApp.
4. Confirmar con "si".
5. Validar que responde pre-solicitud, no creacion real.
6. Preguntar "viajes para manana".
7. Preguntar "detalle del flete F-123".

## Limitaciones actuales

- Checkpoint durable usa `WhatsAppSession.flowState`, no checkpointer nativo de LangGraph.
- No hay streaming.
- No hay multi-camion complejo.
- No hay edicion/cancelacion compleja.
- Query freights es read-only inicial y usa heuristicas simples.
- No se geocodifica texto.

## Roadmap

1. Migrar checkpoint a Postgres/Redis checkpointer nativo.
2. Endurecer policies por company type, rol y estado real.
3. Agregar mas tests de conversacion completa.
4. Incorporar observabilidad agregada por tool success rate.
5. Implementar flows mutativos restantes cuando create/query esten estables.

