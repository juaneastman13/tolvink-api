# Tolvink — Mejoras Post Plant-Centric: FASE 2 de 3
# Links compartibles + ListScreen + WhatsApp + Infraestructura

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. Diagnosticar, implementar, testear y commitear cada paso.**

**PREREQUISITO: Fase 1 completada y commiteada.**

**Estilo: inline con C, Ic, FONT de theme.jsx. Cero clases CSS. Reusar componentes existentes.**

---

## BLOQUE 1 — Links compartibles: modelo + backend

### Diagnosticar

```bash
# Verificar si ya hay algo de shared links
grep -rn "SharedLink\|sharedLink\|shared.link\|share.*link" src/ --include="*.ts" | head -15
grep -rn "SharedLink\|shared_link" prisma/schema.prisma | head -5

# Verificar nanoid disponible
cat package.json | grep nanoid

# Endpoints públicos existentes (referencia)
grep -rn "Public\|public\|noAuth\|skipAuth\|isPublic" src/ --include="*.ts" | head -15
grep -n "/api/f/\|/api/track/" src/ -r --include="*.controller.ts" | head -10
```

### Implementar modelo Prisma

```prisma
enum SharedLinkType {
  FREIGHT
  PORTAL
  TICKET
}

enum LinkCreationChannel {
  WEB
  WHATSAPP
}

model SharedLink {
  id                String              @id @default(uuid())
  token             String              @unique
  linkType          SharedLinkType
  creatorCompanyId  String
  creatorCompany    Company             @relation("linksCreated", fields: [creatorCompanyId], references: [id])
  targetCompanyId   String
  targetCompany     Company             @relation("linksReceived", fields: [targetCompanyId], references: [id])
  freightId         String?
  freight           Freight?            @relation(fields: [freightId], references: [id])
  ticketId          String?
  createdBy         String?
  createdVia        LinkCreationChannel @default(WEB)
  expiresAt         DateTime?
  revokedAt         DateTime?
  lastAccessedAt    DateTime?
  accessCount       Int                 @default(0)
  createdAt         DateTime            @default(now())

  @@index([token])
  @@index([creatorCompanyId, linkType])
  @@index([targetCompanyId, linkType])
  @@index([freightId])
}
```

Agregar relaciones en Company y Freight. Instalar nanoid si no está: `npm install nanoid@3` (v3 para CommonJS).

### Implementar SharedLinksService

```typescript
// Métodos:
createLink(dto: { linkType, creatorCompanyId, targetCompanyId, freightId?, ticketId?, createdBy?, createdVia? }): Promise<SharedLink>
  // Genera token con nanoid(21)
  // Si ya existe link activo para el mismo recurso+target, reutilizar (no crear duplicado)
  // Si linkType === FREIGHT: expiresAt = now + 72h
  // Si linkType === TICKET o PORTAL: expiresAt = null

resolveToken(token: string): Promise<{ valid, linkType, data }>
  // Buscar por token
  // Verificar: existe? revokedAt null? expiresAt > now?
  // Si válido: incrementar accessCount, actualizar lastAccessedAt
  // Cargar datos según linkType (freight con relaciones, ticket con relaciones, etc.)

revokeLink(id: string): Promise<SharedLink>
regenerateLink(id: string): Promise<SharedLink>  // Revoca anterior, crea nuevo token
listByCompany(companyId: string, linkType?): Promise<SharedLink[]>
```

### Implementar SharedLinksController

Endpoints autenticados (para crear/gestionar):
- `POST /shared-links` — crear link
- `GET /shared-links/company/:id` — listar links de una empresa
- `PATCH /shared-links/:id/revoke` — revocar
- `POST /shared-links/:id/regenerate` — regenerar

Endpoint público (sin auth, con rate limit):
- `GET /s/:token` — resolver token y retornar datos
- `GET /s/:token/data` — JSON para SPA refresh

### Rate limiting en endpoint público

Agregar rate limit al endpoint GET /s/:token: 30 requests por minuto por IP. Usar el ThrottlerModule de NestJS que ya está importado.

---

## BLOQUE 2 — Links compartibles: vista pública FREIGHT

### Implementar en frontend

Crear una ruta pública `/s/:token` en el frontend (React Router) que NO requiere autenticación.

Al acceder:
1. Fetch `GET /s/{token}/data`
2. Si inválido/expirado: mostrar vista "Link expirado o revocado" con branding Tolvink
3. Si válido y linkType === FREIGHT: renderizar vista de tracking

**Vista FREIGHT:**
- Header: logo Tolvink + "Seguimiento de Flete" + código del flete
- Estado actual: badge grande con color (verde, naranja, azul según estado)
- Timeline/stepper vertical: los 6 estados, cada paso con fecha/hora si ya se alcanzó. Paso actual resaltado
- Info del flete: producto, cantidad, origen (nombre, no dirección exacta), destino (nombre)
- Transportista: nombre de empresa (si asignado). Sin datos de contacto
- Footer: "Compartido por [nombre planta] vía Tolvink" + link a tolvink.com
- Meta tags: `<meta name="robots" content="noindex, nofollow">`
- Auto-refresh: si el flete está activo (no finished/canceled), refrescar datos cada 30 segundos

Responsive: mobile-first. El 80%+ del tráfico será desde celulares (link recibido por WhatsApp).

---

## BLOQUE 3 — Links compartibles: vista pública TICKET

Si linkType === TICKET: renderizar vista de comprobante de pesaje.

**Vista TICKET:**
- Header: logo Tolvink + "Comprobante de Pesaje" + referencia del ticket
- Datos: peso bruto, tara, peso neto, producto/grano, fecha y hora
- Foto del ticket: imagen ampliable (si existe en Supabase Storage)
- Flete asociado: referencia con enlace al link FREIGHT si existe
- Footer: "Emitido por [nombre planta] vía Tolvink"

---

## BLOQUE 4 — Links compartibles: vista pública PORTAL

Si linkType === PORTAL: renderizar dashboard del actor.

**Vista PORTAL:**
- Header: logo Tolvink + nombre planta + nombre productor/transportista
- Métricas: cards con fletes totales, fletes activos, último flete, toneladas del periodo
- Lista de fletes: tabla/cards filtrable por estado y rango de fechas. Click en flete abre detalle inline
- Tickets: sección colapsable con tickets asociados
- Footer: "Portal de [nombre planta] — Powered by Tolvink" + CTA "¿Querés gestionar tus fletes? Creá tu cuenta gratis"

Paginación: la lista carga con paginación, no todo de una vez.

---

## BLOQUE 5 — Botón "Compartir" en DetailScreen y TicketDetail

En DetailScreen:
- Agregar botón "Compartir" (ícono share) en el header del detalle del flete
- Al tocar: `POST /shared-links` con linkType = FREIGHT, freightId, targetCompanyId = producerCompanyId
- Mostrar el link generado en un mini-modal con botón "Copiar" y botón "Enviar por WhatsApp" (abre wa.me con texto predefinido)
- Si ya existe link activo: mostrarlo directamente sin crear nuevo

En TicketDetail (si existe pantalla de ticket):
- Mismo patrón pero con linkType = TICKET

En LinkedCompaniesScreen, dentro de cada empresa:
- Botón "Link de portal" que genera/muestra link tipo PORTAL

---

## BLOQUE 6 — ListScreen: acciones rápidas + indicadores

### Diagnosticar

```bash
grep -n "card\|Card\|freightCard\|renderItem\|renderGroup" src/screens/ListScreen.jsx | head -20
grep -n "action\|button\|btn\|onPress\|onClick" src/screens/ListScreen.jsx | head -20
wc -l src/screens/ListScreen.jsx
```

### Implementar

**6.1. Indicador "quién debe actuar" en cada card:**
- Lógica: según estado del flete + roles + accessLevel, determinar quién tiene la acción pendiente
  - pending_assignment → "Asignar transporte" (acción de planta)
  - assigned → "Esperando [nombre transportista]" (transportista OPERATOR debe aceptar) O "Confirmado" (si auto-aceptado)
  - accepted → "En espera de inicio" (chofer debe iniciar) O "Iniciar viaje" (si planta opera porque transp CONSULTA)
  - in_progress / loaded → "En viaje" / "Cargado"
  - finished → "Finalizado"
- Mostrar como texto pequeño debajo del estado, color C.t3

**6.2. Botón de acción rápida en cada card (solo planta):**
- Un solo botón por card, la acción más relevante:
  - pending_assignment → ícono camión "Asignar" → abre AssignModal directamente
  - assigned (transp CONSULTA) → ícono play "Iniciar" → marca in_progress
  - loaded → ícono check "Finalizar" → marca finished
- El botón aparece a la derecha de la card, pequeño (32x32), solo ícono
- Solo visible para planta y cuando la acción le corresponde a ella
- Al tocar: ejecutar la acción directamente (con confirmación rápida para acciones irreversibles) o abrir mini-modal

**6.3. Filtro "Requiere mi acción":**
- Agregar chip/tab en la barra de filtros: "Requiere mi acción"
- Al activar: filtra la lista a solo fletes donde la planta tiene un paso pendiente
- Lógica: pending_assignment + fletes donde transportista es CONSULTA y estado necesita avance de planta

---

## BLOQUE 7 — ListScreen: tabla desktop mejorada

### Implementar (solo desktop, no tocar cards mobile)

**7.1. Columnas:**
- Código | Productor | Origen → Destino | Producto | Cantidad | Transportista | Estado | Fecha | Acciones

**7.2. Ordenable:**
- Click en header de columna → ordenar asc/desc
- Indicador visual de columna activa (flecha arriba/abajo)

**7.3. Acciones en columna:**
- Botón pequeño con la acción más relevante (igual que en cards)
- Botón "Ver" que abre DetailScreen

**7.4. Export a CSV:**
- Botón "Exportar" en la barra de herramientas de la tabla
- Genera CSV con todos los fletes filtrados (no solo la página actual)
- Descarga automática

---

## BLOQUE 8 — Bulk creation de fletes

### Implementar en NewScreen

Después de crear un flete exitosamente (el submit se completó), mostrar un modal/card de post-creación con dos opciones:

1. **"Crear otro similar"** (botón primario):
   - Vuelve al wizard manteniendo: productor, producto, destino, fecha, y transportista (si se asignó)
   - Resetea: origen (campo/lote) y cantidad
   - El wizard abre en el paso de origen (paso 3) directamente, no desde el paso 0
   - El usuario solo tiene que cambiar campo/lote y cantidad

2. **"Ver flete creado"** (botón secundario):
   - Navega al DetailScreen del flete recién creado

3. **"Ir a la lista"** (link terciario):
   - Navega a ListScreen

---

## BLOQUE 9 — WhatsApp: validar + agente genera links

### 9.1. Validar accessLevel en producción

```bash
# Verificar que la lógica de bloqueo está activa
grep -n "CONSULTA_BLOCKED_TOOLS\|accessLevel\|isConsulta\|READONLY" src/ai/ -r --include="*.ts" | head -15

# Verificar respuestas de redirección
grep -n "gestiona\|maneja\|contacta\|planta" src/ai/ -r --include="*.ts" | head -10

# Verificar que NO dice "permiso"
grep -rn "permiso\|no tenés\|modo consulta\|restricción" src/ai/ --include="*.ts" | head -5
```

Probar manualmente por WhatsApp:
- Con usuario CONSULTA: "quiero crear un flete" → debe redirigir naturalmente
- Con usuario CONSULTA: "cómo va mi flete?" → debe responder normalmente

### 9.2. Tool generate_shared_link (solo si links compartibles ya están implementados)

Agregar nueva tool al agente:

```typescript
{
  name: 'generate_shared_link',
  description: 'Genera un link compartible para un flete o ticket',
  parameters: {
    linkType: 'FREIGHT' | 'TICKET',
    freightId?: string,
    ticketId?: string,
    targetCompanyId: string,
  },
  returns: { url: string, isReused: boolean }
}
```

Uso proactivo: cuando un productor pregunta "cómo va mi flete?", incluir el link al final: "Podés ver el seguimiento en tiempo real acá: tolvink.com/s/xxx"

Uso reactivo: cuando la planta dice "mandá el link del flete 123 al productor", generar link y enviarlo al WhatsApp del productor.

### 9.3. Agente crea fletes para planta

Agregar sub-flujo conversacional cuando la planta dice "crear flete" o "necesito un flete":

1. "¿Para qué productor?" → fuzzy search en productores vinculados
2. "¿Qué producto?" → opciones de grano
3. "¿Cuántas toneladas?" → input numérico
4. "¿Desde dónde?" → fuzzy search en campos del productor
5. "¿Para cuándo?" → fecha (hoy si no especifica)
6. Si productor es CONSULTA: "¿Querés asignar transporte ahora?" → si sí, mismo flujo
7. Confirmar datos → POST /freights + POST /assign si corresponde

---

## BLOQUE 10 — Infraestructura

### 10.1. Cache de CompanyAccess

En el backend, al obtener accessLevel:
- Cachear resultado en memoria (Map con key = `${grantorId}:${granteeId}`, value = accessLevel, TTL 5 min)
- Invalidar al ejecutar PATCH /company-access/:id/level
- Usar un servicio de cache simple (no Redis para empezar — Map en memoria es suficiente para un solo proceso)

### 10.2. SSE: fix conexiones múltiples

Verificar el frontend:
```bash
grep -n "EventSource\|SSE\|sse\|eventSource" src/ -r --include="*.jsx" --include="*.js" | head -15
```

- El frontend debe cerrar la conexión SSE anterior antes de abrir una nueva (en useEffect cleanup)
- Si hay un reconnect automático, verificar que no crea conexiones duplicadas
- El backend ya tiene eviction (visto en logs) — verificar que el frontend maneja la desconexión gracefully

### 10.3. Tests: estabilizar suite

```bash
npm test 2>&1 | tail -10
```

- Identificar la causa raíz del fallo de ts-jest (46 tests)
- Probable fix: actualizar ts-jest config o tsconfig.spec.json
- Agregar al menos 3 tests para flujos plant-centric:
  - Test: crear flete con producerCompanyId
  - Test: auto-aceptación con transportista CONSULTA
  - Test: planta ejecuta transición de estado

---

## Validación

```bash
# Backend
npm run build
npm test

# Frontend
npm run build
```

Probar:
- Link compartible FREIGHT: generar desde DetailScreen, abrir en browser incógnito, ver vista pública
- Link compartible TICKET: generar y verificar vista
- Link compartible PORTAL: generar y verificar dashboard público
- Acciones rápidas en ListScreen: asignar desde la card sin entrar al detalle
- Filtro "Requiere mi acción" muestra solo fletes pendientes de la planta
- Tabla desktop: ordenar por columna, exportar CSV
- Crear flete → "Crear otro similar" → wizard con datos mantenidos
- WhatsApp: link en respuesta de estado, crear flete por conversación

Commitear: `git add . && git commit -m "feat: shared links + list improvements + bulk creation + whatsapp links + infra fixes"`
Pushear.
