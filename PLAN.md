# Plan: Estandarización de Listados + Unificación de Mapas

## Diagnóstico

### 1. Listados — Estado actual

| Herramienta AI | Archivo | Usa lista interactiva | Necesita cambio |
|---|---|---|---|
| `toolListFreights` | ai.service.ts:996 | ✅ `_pendingSelection` | NO |
| `toolSwitchCompany` | ai.service.ts:2463 | ✅ `_pendingSelection` | NO |
| `toolListLots` | ai.service.ts:1178 | ❌ JSON texto | **SÍ** |
| `toolListFields` | ai.service.ts:1663 | ❌ JSON texto | **SÍ** |
| `toolListTrucks` | ai.service.ts:1745 | ❌ JSON texto | **SÍ** |
| `toolListTransporters` | ai.service.ts:2100 | ❌ JSON texto | **SÍ** |
| `toolListCompanyUsers` | ai.service.ts:2334 | ❌ JSON texto | **SÍ** |
| `toolListDrivers` | ai.service.ts:2375 | ❌ JSON texto | **SÍ** |
| `toolSearchPlants` | ai.service.ts:1123 | ❌ JSON texto | **SÍ** |

**7 herramientas** devuelven JSON plano que Claude formatea como texto numerado.

### 2. Mapas — Google Maps detectados

| Ubicación | Tipo | Archivo |
|---|---|---|
| FreightMap: botón "Abrir en Google Maps" | Link directo | maps.jsx:458-476 |
| MapOverlay: "Cómo llegar" en info window | Link secundario | maps.jsx:715-719 |
| AI tool desc: `generate_location_link` | Texto "Google Maps" | ai.service.ts:765 |
| AI tool desc: `generate_tracking_link` | Texto "Google Maps" | ai.service.ts:777 |

Backend genera URLs Tolvink internas correctamente. El problema está en frontend.

---

## Plan de implementación

### FASE 1: Backend — 7 herramientas AI → lista interactiva (ai.service.ts)

**Patrón uniforme** (mismo que `toolListFreights`):
1. Pasar `session` a cada tool en `executeTool()`
2. Construir `SelectionItem[]` con `id`, `title` (max 24), `description` (max 72)
3. Guardar `_pendingSelection` en sesión
4. Retornar `{ _selectionSent: true, message: "..." }`

**Detalle por herramienta:**

**a) `toolListLots`** — Lotes del productor
- Items: `id: lot:{uuid}`, title: nombre, description: campo asociado
- purpose: `lot_info`
- Cambiar `take: 20` → `take: 100`

**b) `toolListFields`** — Campos del productor
- Items: `id: field:{uuid}`, title: nombre, description: dirección + N lotes
- purpose: `field_info`
- Nota: tiene lotes anidados → incluir resumen en description

**c) `toolListTrucks`** — Camiones
- Items: `id: truck:{uuid}`, title: patente, description: modelo + chofer
- purpose: `truck_info`

**d) `toolListTransporters`** — Transportistas
- Items: `id: transporter:{uuid}`, title: nombre, description: teléfono
- purpose: `transporter_info`
- Preservar lógica "Flota interna" al inicio + campo NOTA

**e) `toolListCompanyUsers`** — Usuarios de la empresa
- Items: `id: user:{uuid}`, title: nombre, description: rol + email
- purpose: `user_info`
- Requiere agregar `m.user.id` al mapeo (actualmente no devuelve ID)

**f) `toolListDrivers`** — Choferes
- Items: `id: driver:{uuid}`, title: nombre, description: teléfono + camión
- purpose: `driver_info`

**g) `toolSearchPlants`** — Búsqueda de plantas
- Items: `id: plant:{uuid}`, title: nombre empresa, description: N sucursales
- purpose: `plant_info`
- Solo aplica cuando hay resultados y no fuzzy-match único

### FASE 2: Backend — Router dispatch (whatsapp-router.service.ts)

**En `dispatchSelectionResult`:** agregar un default handler genérico que, para cualquier purpose no manejado explícitamente, reenvíe la selección al AI como mensaje sintético:

```
default:
  await this.handleAiChat(phone, user, `[Seleccionó: ${item.title} (id: ${id})]`);
```

Esto permite que el AI reciba la selección y continúe el flujo (ej: el usuario lista transportistas → toca uno → el AI sabe cuál eligió para `assign_transporter`).

**En `handleListReply`:** ya maneja `freight:` y `selco:`. Los demás prefijos caen al default → `handleButtonReply` → no match. Cambiar: agregar lookup genérico que busque `selectionContext` y despache a `dispatchSelectionResult`.

### FASE 3: Backend — System prompt (ai.service.ts)

Actualizar la regla de `_selectionSent` para que cubra TODAS las herramientas de listado:

```
- Cuando una herramienta retorna _selectionSent: true, la lista YA se envió como menú interactivo.
  NO repita, NO reformatee, NO enumere. Solo confirme brevemente.
  Herramientas que usan este patrón: list_freights, list_lots, list_fields, list_trucks,
  list_transporters, list_company_users, list_drivers, search_plants, switch_company.
```

### FASE 4: Frontend — Eliminar Google Maps (maps.jsx)

**a) FreightMap (línea 458-476):**
- Eliminar botón "Abrir en Google Maps" completo
- Mover el botón expandir (goToMap) al lugar del botón eliminado con texto visible "Ver mapa"

**b) MapOverlay (línea 715-719):**
- Cambiar "Cómo llegar" de `google.com/maps/dir` a URL intent genérica:
  `geo:${lat},${lng}?q=${lat},${lng}` o `https://www.google.com/maps/dir/...`
- Nota: este link ES la acción secundaria desde dentro del mapa Tolvink (cumple requisito del usuario). Cambiar label a "Navegar" sin mencionar Google.

### FASE 5: Backend — Tool descriptions (ai.service.ts)

- `generate_location_link`: "mapa de Google Maps" → "mapa Tolvink"
- `generate_tracking_link`: "en Google Maps" → "en el mapa Tolvink"
- Actualizar descriptions de list tools para indicar que envían lista interactiva

---

## Archivos a modificar

1. `src/ai/ai.service.ts` — 7 tools + system prompt + tool descriptions + executeTool switch
2. `src/whatsapp/whatsapp-router.service.ts` — dispatchSelectionResult + handleListReply
3. `tolvink-deploy/src/maps.jsx` — FreightMap + MapOverlay

## Riesgos

1. **`toolSearchPlants` con fuzzy search**: tiene lógica compleja (matchType, branches anidadas). La lista interactiva mostrará empresas; el AI necesita las branches para el flujo. Solución: incluir branches en el JSON retornado al AI además de `_selectionSent`.
2. **`toolListCompanyUsers` sin ID**: el mapeo actual no incluye `user.id`. Se agrega.
3. **`toolListTransporters` con NOTA**: el campo NOTA para flota interna debe mantenerse en el JSON retornado al AI (no se pierde con `_selectionSent`).
4. **MapOverlay "Cómo llegar"**: es una acción de navegación, no de visualización. Usar intent URI genérico `geo:` funciona en Android; en iOS usa Apple Maps. Alternativa: mantener el link pero sin branding Google.
