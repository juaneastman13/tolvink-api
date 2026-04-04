# Tolvink — Mejoras Post Plant-Centric: FASE 3 de 3
# Evoluciones post-piloto: Hub universal + Tickets UI + Analytics + Mapas

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. Diagnosticar, implementar, testear y commitear cada paso.**

**PREREQUISITO: Fases 1 y 2 completadas y commiteadas. Piloto en marcha.**

**Estilo: inline con C, Ic, FONT de theme.jsx. Cero clases CSS. Reusar componentes existentes.**

---

## BLOQUE 1 — Cualquier empresa como hub

### Contexto

Hoy solo la planta puede tener empresas vinculadas (CompanyAccess como grantor). Este bloque abre esa capacidad a productores y transportistas. Un productor grande puede vincular transportistas; un transportista grande puede vincular productores.

### Diagnosticar

```bash
# Todas las condiciones que restringen a PLANT
grep -rn "type.*===.*PLANT\|type.*===.*'PLANT'\|companyType.*PLANT\|isPlant\|activeCompany.*type" src/ --include="*.ts" --include="*.tsx" --include="*.jsx" | grep -v node_modules | grep -v test | head -40

# Backend: condiciones en CompanyAccess
grep -n "PLANT\|type.*plant\|isPlant" src/company-access/ -r --include="*.ts" | head -20

# Frontend: condiciones de visibilidad
grep -n "type.*===.*PLANT\|isPlant\|PLANT" src/screens/ -r --include="*.jsx" | head -30
grep -n "type.*===.*PLANT\|isPlant" src/layout/ -r --include="*.jsx" | head -15
grep -n "type.*===.*PLANT\|isPlant" src/hooks/ -r --include="*.jsx" --include="*.js" | head -10
```

### Implementar

**1.1. Backend: relajar restricción de tipo**

En CompanyAccessService y controller:
- Reemplazar validaciones que chequean `company.type === 'PLANT'` por una validación más flexible
- Cualquier empresa puede ser grantor en CompanyAccess
- La validación debe ser: la empresa que otorga acceso existe y el usuario tiene rol admin/gerente en ella
- Al crear vinculación, inferir granteeType del tipo de la empresa receptora

En FieldsService, TrucksService:
- El ownerCompanyId ya es genérico — no depende del tipo de empresa. Verificar que no hay checks de tipo.

En FreightsService:
- La auto-aceptación para transportista CONSULTA no depende de quién es el grantor. Verificar.

**1.2. Frontend: condiciones de visibilidad**

Cambiar todas las condiciones `activeCompany.type === 'PLANT'` por una nueva condición: `hasLinkedCompanies` o `isHub`.

```javascript
const isHub = linkedCompanies.length > 0;
```

Pantallas afectadas:
- **Navegación**: "Empresas" en menú → visible si `isHub` (no solo si PLANT)
- **LocationsScreen**: dropdown de empresa → visible si `isHub`
- **Flota**: dropdown de empresa → visible si `isHub`
- **NewScreen**: paso 0 (productor) → visible si `isHub` y tiene productores vinculados
- **AssignModal**: lógica de transportista CONSULTA → funciona para cualquier grantor
- **LinkedCompaniesScreen**: accesible si `isHub`

**1.3. Crear vinculaciones desde cualquier empresa**

En LinkedCompaniesScreen, permitir que:
- Un productor vincule transportistas (granteeType = TRANSPORTER)
- Un transportista vincule productores (granteeType = PRODUCER)
- Las opciones de tipo de empresa al crear dependen del tipo del grantor:
  - Si grantor es PLANT: puede crear PRODUCER o TRANSPORTER
  - Si grantor es PRODUCER: puede crear TRANSPORTER (no otro productor)
  - Si grantor es TRANSPORTER: puede crear PRODUCER (no otro transportista)

---

## BLOQUE 2 — Módulo de tickets de pesaje: UI web

### Diagnosticar

```bash
grep -rn "weigh-ticket\|WeighTicket\|weighTicket" src/ --include="*.ts" | head -20
grep -n "WeighTicket" prisma/schema.prisma | head -5
cat prisma/schema.prisma | grep -A 20 "model WeighTicket"
grep -rn "weigh-tickets" src/ --include="*.controller.ts" | head -15
grep -rn "ocr\|OCR" src/ --include="*.ts" | head -10
grep -rn "ticket\|Ticket\|weigh" src/screens/ --include="*.jsx" | head -15
find src/ -name "*icket*" | head -10
```

### Implementar

**2.1. TicketsScreen (nueva pantalla)**

Pantalla accesible desde el menú: "Tickets de pesaje"

- **Lista de tickets**: cards con datos básicos de cada ticket
  - Número/referencia del ticket
  - Fecha y hora del pesaje
  - Producto y peso neto
  - Flete asociado (código + badge estado)
  - Miniatura de la foto (si existe)
  - Badge: "Con OCR" si tiene datos extraídos

- **Filtros**: por flete, por fecha, por producto

- **Click en ticket**: abre TicketDetailScreen o expande inline

**2.2. TicketDetailScreen**

- Datos del pesaje: peso bruto, tara, peso neto, producto, fecha, hora
- Foto del ticket: imagen grande ampliable (desde Supabase Storage)
- Datos OCR: si se procesó, mostrar datos extraídos con indicador de confianza
- Flete asociado: card resumen con link al DetailScreen del flete
- Botón "Compartir" → genera link compartible tipo TICKET (si SharedLinks está implementado)

**2.3. Crear ticket desde la web**

Botón "Nuevo ticket" que abre formulario:
- Selector de flete (obligatorio) — dropdown de fletes activos/recientes
- Peso bruto (kg, obligatorio)
- Tara (kg, obligatorio)
- Peso neto (calculado automáticamente: bruto - tara)
- Producto (pre-llenado del flete seleccionado)
- Fecha y hora (default: ahora)
- Foto: upload desde cámara (mobile) o archivo
- Al subir foto: ofrecer "Extraer datos con OCR" → POST /ocr/analyze → pre-llenar campos

**2.4. Tickets en DetailScreen**

En el detalle de un flete, sección "Tickets de pesaje":
- Lista de tickets asociados al flete
- Botón "Agregar ticket" → abre formulario con flete pre-seleccionado
- Click en ticket → navega a TicketDetailScreen

---

## BLOQUE 3 — Dashboard analytics

### Diagnosticar

```bash
grep -rn "analytics" src/ --include="*.controller.ts" | head -10
grep -rn "analytics" src/ --include="*.service.ts" | head -15
grep -A 20 "summary\|track\|events" src/analytics/ -r --include="*.service.ts" 2>/dev/null | head -40
```

### Implementar

**3.1. AnalyticsScreen (nueva pantalla)**

Accesible desde menú: "Estadísticas" o "Reportes"

**Sección 1 — Métricas generales (cards):**
- Fletes totales (período seleccionable: semana / mes / campaña)
- Toneladas totales
- Fletes activos ahora
- Tiempo promedio de viaje

**Sección 2 — Volumen por productor (gráfico de barras):**
- Eje X: productores
- Eje Y: toneladas
- Solo visible para plantas (muestra sus productores vinculados)
- Usar recharts (ya disponible como librería en el frontend)

**Sección 3 — Volumen por producto (gráfico de torta/dona):**
- Distribución de toneladas por tipo de grano

**Sección 4 — Actividad por mes (gráfico de línea):**
- Últimos 6-12 meses
- Línea de fletes creados y línea de toneladas

**Sección 5 — Ranking de transportistas (tabla):**
- Nombre, fletes completados, toneladas, tiempo promedio de viaje
- Ordenable por cada columna
- Solo visible para plantas

**3.2. Backend: endpoints de analytics**

Si no existen los endpoints necesarios, crear:

- `GET /analytics/summary?period=week|month|campaign` — métricas generales
- `GET /analytics/by-producer?period=month` — volumen por productor (solo para plantas)
- `GET /analytics/by-product?period=month` — volumen por producto
- `GET /analytics/by-month?months=12` — actividad mensual
- `GET /analytics/transporters-ranking?period=month` — ranking de transportistas

Filtrar siempre por activeCompanyId. No exponer datos de otras empresas.

---

## BLOQUE 4 — Mapas en links compartibles

### Contexto

Los links compartibles tipo FREIGHT y PORTAL pueden incluir mapas interactivos mostrando la ruta y ubicaciones.

### Implementar

**4.1. Ruta pre-calculada en Freight (backend)**

Agregar campos al modelo Freight:

```prisma
model Freight {
  // ... existentes
  routePolyline      String?
  routeDistanceKm    Float?
  routeDurationMin   Int?
  routeCalculatedAt  DateTime?
}
```

Al crear flete (si tiene coordenadas de origen y destino):
- Llamar a Google Directions API server-side (una sola vez)
- Guardar polyline codificada, distancia y duración
- Si falla: no bloquear creación, dejar campos null

**4.2. API key pública para mapas**

- Crear API key separada en Google Cloud Console para vistas públicas
- Restringir por referrer: `tolvink.com/s/*`, `www.tolvink.com/s/*`, `localhost:*/s/*`
- Solo habilitar Maps JavaScript API en esta key
- Variable de entorno: `VITE_GOOGLE_MAPS_PUBLIC_KEY`

**4.3. Mapa en vista FREIGHT**

En la vista pública de link FREIGHT:
- Mapa Google Maps interactivo (zoom, pan)
- Marcador de origen (verde, ícono campo) + marcador destino (naranja, ícono planta)
- Polyline de ruta entre ambos (si routePolyline existe)
- Overlay semitransparente con distancia y duración estimada
- Contenedor: 100% ancho, 280px alto mobile, 360px desktop, border-radius 12px
- Si routePolyline no existe: mapa con solo los dos marcadores, sin ruta

**4.4. Mapa en vista PORTAL**

En la vista pública de link PORTAL:
- Mapa con marcadores de todos los fletes activos del actor
- Marcadores color-coded por estado
- Click en marcador: mini-card con info del flete
- Clustering si >10 marcadores en la misma zona

**4.5. Carga lazy de Google Maps**

- Cargar Google Maps JS solo cuando el contenedor del mapa entra en viewport (Intersection Observer)
- Skeleton/placeholder mientras carga
- Fallback si falla: card estática con texto "Origen: [nombre] → Destino: [nombre] — [distancia] km, ~[duración] min"

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
- Crear vinculación desde un productor (no planta) → funciona
- TicketsScreen: lista, detalle, crear con foto, OCR
- AnalyticsScreen: gráficos renderizan con datos reales
- Link FREIGHT con mapa: ruta visible entre origen y destino
- Link PORTAL con mapa: marcadores de fletes activos

Commitear: `git add . && git commit -m "feat: universal hub + tickets UI + analytics + maps in links"`
Pushear.
