# Tolvink — Roadmap Integral Post Plant-Centric

**Fecha:** Marzo 2026
**Estado:** Model plant-centric implementado, en fase de estabilización pre-piloto

---

## Clasificación

- 🔴 **BLOCKER** — Sin esto no se puede hacer el piloto
- 🟠 **CRÍTICO** — Afecta la experiencia del piloto significativamente
- 🟡 **IMPORTANTE** — Mejora notable pero no bloquea el piloto
- 🔵 **DESEABLE** — Post-piloto, mejora la plataforma
- ⚪ **FUTURO** — Diseñado pero diferido explícitamente

---

## FASE 0 — Bugs y estabilización (antes del piloto)

### 🔴 0.1 Bug: conversación duplicada al crear flete desde planta
**Estado:** Pendiente
**Problema:** `Unique constraint failed on (conversation_id, company_id)` cuando la planta crea un flete donde ella es creador Y destino. El código intenta agregar la planta como participante de la conversación dos veces.
**Solución:** Deduplicar participantes por companyId antes del insert. Usar Set o filtro.
**Impacto:** Blocker total — ningún flete se puede crear desde la planta hasta que se corrija.
**Esfuerzo:** 0.5 día

### 🔴 0.2 Bug: reactividad de UI
**Estado:** Pendiente (pre-existente)
**Problema:** Tras mutaciones (cambios de estado, asignaciones, ediciones), las pantallas DetailScreen, ListScreen, HomeScreen y LocationsScreen no se actualizan sin recarga manual.
**Solución:** Estrategia B definida previamente — invalidar caché + refetch inmediato tras cada mutación.
**Impacto:** El operador de planta crea un flete, vuelve a la lista y no lo ve. Tiene que recargar manualmente.
**Esfuerzo:** 2-3 días

### 🔴 0.3 Bug: destName guarda "Personalizado"
**Estado:** Pendiente (pre-existente)
**Problema:** Al seleccionar planta y sucursal como destino, el campo destName guarda "Personalizado" en lugar del nombre real, aunque destCompanyId y branchId se asignan correctamente.
**Solución:** Corregir la lógica que setea destName en NewScreen al seleccionar planta+sucursal.
**Esfuerzo:** 0.5 día

### 🟠 0.4 Migración de DB producción
**Estado:** Ejecutado parcialmente
**Problema:** Verificar que todas las columnas nuevas (ownerCompanyId en Field/Truck, producerCompanyId en Freight, tabla CompanyAccess) están correctamente creadas en la DB de producción.
**Solución:** Ejecutar script de verificación SQL o `prisma db push` contra producción.
**Esfuerzo:** 0.5 día

---

## FASE 1 — Experiencia de planta (core del piloto)

### 🟠 1.1 HomeScreen plant-centric
**Estado:** Por implementar
**Problema:** El HomeScreen de la planta muestra un dashboard genérico que no refleja el modelo plant-centric. El operador no tiene un panorama rápido de su operación.
**Solución:**
- Métricas principales: fletes activos total, pendientes de asignar transporte, en viaje, finalizados hoy/semana
- Cards agrupadas o filtrables por productor
- Sección "Requiere tu atención": fletes sin transporte, fletes rechazados por transportista, fletes CONSULTA esperando que la planta marque estado
- Accesos rápidos: "Crear flete", "Empresas vinculadas", "Ubicaciones"
**Esfuerzo:** 2 días

### 🟠 1.2 Onboarding / empty state para planta nueva
**Estado:** Por implementar
**Problema:** Cuando la planta se loguea por primera vez, no tiene empresas vinculadas, campos ni fletes. La pantalla está vacía sin guía.
**Solución:**
- Detectar si la planta tiene CompanyAccess registros: si count === 0, mostrar onboarding
- Onboarding en 3 pasos con ilustraciones simples:
  1. "Creá tus productores" → CTA a empresas vinculadas
  2. "Cargá las ubicaciones" → CTA a LocationsScreen
  3. "Creá tu primer flete" → CTA a NewScreen
- Cada paso desaparece cuando se completa
- Skeleton/empty state amigable en cada pantalla vacía (no solo blanco)
**Esfuerzo:** 1.5 días

### 🟠 1.3 Navegación: "Empresas" como item de menú de primer nivel
**Estado:** Por implementar
**Problema:** "Empresas vinculadas" está enterrado dentro de Perfil/Admin. Para el modelo plant-centric es una función central, no secundaria.
**Solución:**
- Agregar "Empresas" como item en el nav lateral / bottom nav para usuarios planta
- Ícono: building o users-group
- Navega a LinkedCompaniesScreen directamente
- Solo visible para empresas tipo PLANT
- Reorganizar menú: Inicio | Fletes | Empresas | Ubicaciones | Flota | Chat | Menú
**Esfuerzo:** 0.5 día

### 🟡 1.4 DetailScreen: "Creado por" visible
**Estado:** Por implementar
**Problema:** Cuando la planta tiene 50 fletes, no sabe cuáles creó ella y cuáles creó el productor directamente.
**Solución:**
- Mostrar línea "Creado por [nombre planta] para [nombre productor]" o "Creado por [nombre productor]"
- Ubicación: debajo del código del flete, antes de la timeline
- Solo visible cuando hay producerCompanyId (fletes plant-centric) o cuando el creador es distinto al productor
**Esfuerzo:** 0.5 día

### 🟡 1.5 ListScreen: indicadores visuales plant-centric
**Estado:** Parcialmente implementado (badge de productor existe)
**Problema:** La planta necesita diferenciar rápidamente entre fletes según su estado operativo.
**Solución:**
- Badge de estado de asignación: "Sin transporte" (rojo), "Esperando aceptación" (naranja), "Confirmado" (verde)
- Indicador de quién tiene que actuar: "Acción tuya" (planta debe hacer algo), "Esperando [transportista]", "En viaje"
- Filtro rápido por "Requiere mi acción" que muestra solo fletes donde la planta tiene un paso pendiente
**Esfuerzo:** 1 día

### 🟡 1.6 Notificaciones para flujo plant-centric
**Estado:** Por verificar/implementar
**Problema:** El NotificationService puede no enviar notificaciones al productor CONSULTA cuando la planta crea fletes y cambia estados en su nombre.
**Solución:**
- Verificar que al crear flete con producerCompanyId, el productor recibe notificación push web
- Verificar que al cambiar estado (in_progress, loaded, finished), todos los actores del flete reciben notificación
- Verificar que al asignar transporte con auto-aceptación, transportista y chofer reciben notificación
- Si alguna no se envía: agregar producerCompanyId como destinatario adicional en el servicio de notificaciones
**Esfuerzo:** 1 día

---

## FASE 2 — Experiencia de usuarios CONSULTA

### 🟡 2.1 HomeScreen para productor CONSULTA
**Estado:** Por implementar
**Problema:** El productor CONSULTA entra y ve un Home con botón "Nuevo flete" oculto, pero el resto del layout no está adaptado. Puede sentirse vacío.
**Solución:**
- Dashboard de solo lectura: métricas de sus fletes (activos, finalizados, toneladas del mes)
- Lista de fletes activos con estado visible y timeline resumida
- Acceso rápido a "Mis ubicaciones" (solo lectura) y "Mi flota" (si tiene)
- Sin sección de acciones de escritura
- Mensaje sutil: "Tus fletes son gestionados por [nombre planta]. Contactalos para solicitar cambios."
**Esfuerzo:** 1 día

### 🟡 2.2 HomeScreen para transportista CONSULTA
**Estado:** Por implementar
**Problema:** Similar al productor CONSULTA — el transportista entra y no tiene un dashboard adaptado.
**Solución:**
- Dashboard de solo lectura: fletes asignados, en viaje, finalizados
- Lista de viajes con estado, camión asignado, chofer
- Acceso a "Mi flota" (lectura + gestión interna no afectada por CONSULTA)
- Sin botones de aceptar/rechazar/actualizar estado
**Esfuerzo:** 1 día

### 🟡 2.3 Chofer de transportista CONSULTA — vista mínima
**Estado:** Por implementar
**Problema:** El chofer de un transportista CONSULTA ve su viaje asignado pero sin botones de acción. La interfaz actual del chofer (modo simple) está diseñada alrededor de los botones de acción — sin ellos, puede quedar confusa.
**Solución:**
- Vista dedicada "solo lectura" para chofer CONSULTA: muestra viaje asignado con toda la info (origen, destino, producto, mapa) pero sin botones
- Indicador claro de estado: "En espera — [nombre planta] gestiona el estado de este viaje"
- Cuando la planta marca un cambio de estado, la vista se actualiza automáticamente
**Esfuerzo:** 0.5 día

---

## FASE 3 — Mejoras de UI general

### 🟡 3.1 Acciones rápidas desde ListScreen
**Estado:** Por diseñar
**Problema:** La planta ve un flete en "pendiente de asignar" y tiene que entrar al detalle para asignar transporte. Con 20+ fletes al día, es mucho click.
**Solución:**
- Botón de acción rápida en cada card de flete (ícono de camión para asignar, check para aceptar, etc.)
- Solo muestra la acción más relevante según el estado del flete y quién debe actuar
- Al tocar: abre mini-modal de acción (no el detalle completo)
- Mobile: swipe para revelar acción rápida
**Esfuerzo:** 1.5 días

### 🟡 3.2 Bulk creation de fletes
**Estado:** Por diseñar
**Problema:** La planta crea 10 fletes para el mismo productor el mismo día. Tiene que repetir el wizard 10 veces.
**Solución:**
- Al finalizar un flete: botón "Crear otro similar" que mantiene productor, producto, destino, y opcionalmente transporte. Solo pide cambiar origen/cantidad.
- Opcionalmente: flujo de creación múltiple donde elige productor, destino, producto una vez y después agrega múltiples orígenes con cantidad
**Esfuerzo:** 1.5 días

### 🟡 3.3 LinkedCompaniesScreen — mejoras de UX
**Estado:** Implementado básico, mejoras pendientes
**Solución:**
- Buscar empresa vinculada por nombre (input de búsqueda en la lista)
- Indicador de "última actividad" en cada empresa (fecha del último flete)
- Contador de fletes activos por empresa
- Expandir empresa: ver resumen rápido (usuarios, camiones, campos, fletes activos) sin navegar
- Botón "Ver fletes" que abre ListScreen filtrada por esa empresa
**Esfuerzo:** 1 día

### 🔵 3.4 Mapa general en HomeScreen
**Estado:** Por diseñar
**Problema:** La planta no tiene una vista geográfica de su operación.
**Solución:**
- Mapa en HomeScreen mostrando marcadores de fletes activos
- Marcadores color-coded por estado (pendiente, en viaje, cargado)
- Click en marcador: mini-card con info del flete
- Toggle show/hide para no ocupar espacio cuando no se necesita
**Esfuerzo:** 2 días

### 🔵 3.5 Tabla desktop mejorada en ListScreen
**Estado:** Existe tabla básica
**Solución:**
- Columnas: código, productor, origen→destino, producto, cantidad, transportista, estado, fecha, acciones
- Columnas configurables (show/hide)
- Ordenable por cada columna
- Selección múltiple para acciones en lote (asignar transporte a varios, cancelar varios)
- Export a Excel/CSV
**Esfuerzo:** 2 días

---

## FASE 4 — Links compartibles y mapas

### 🟡 4.1 Links compartibles — tipo FREIGHT
**Estado:** Diseñado (documento completo), por implementar
**Problema:** El productor CONSULTA no tiene forma de ver estado de un flete fuera de la app web (necesita cuenta).
**Solución:**
- Modelo SharedLink con token nanoid (21 chars, URL-safe)
- Endpoint público GET /s/{token} que retorna vista de tracking sin autenticación
- Vista: timeline de estados, origen→destino, producto, estado actual
- Generación desde DetailScreen (botón "Compartir") y agente WhatsApp
- Expiración: 72h o al finalizar el flete
**Esfuerzo:** 3 días

### 🟡 4.2 Links compartibles — tipo TICKET
**Estado:** Diseñado, por implementar
**Problema:** El ticket de pesaje necesita ser compartible como comprobante digital.
**Solución:**
- Link público con datos del pesaje, foto del ticket, flete asociado
- Sin expiración (comprobante permanente)
- Generación desde TicketDetail y agente WhatsApp
**Esfuerzo:** 1 día

### 🔵 4.3 Links compartibles — tipo PORTAL
**Estado:** Diseñado, diferido
**Problema:** Vista completa de todos los fletes de un actor con una planta.
**Solución:** Dashboard público con métricas, lista de fletes filtrable, tickets asociados. CTA de conversión para que el actor se cree cuenta.
**Esfuerzo:** 3 días

### 🔵 4.4 Mapas en links compartibles
**Estado:** Diseñado (documento completo), diferido
**Solución:**
- Mapa interactivo (Google Maps JS) en link FREIGHT con ruta origen→destino
- Polyline pre-calculada en backend (Directions API server-side, 1 call por flete)
- Campos routePolyline, routeDistanceKm, routeDurationMin en modelo Freight
- API key pública separada restringida por referrer
- Mapa en link PORTAL con marcadores de fletes activos
**Esfuerzo:** 3 días

---

## FASE 5 — WhatsApp plant-centric

### 🟠 5.1 Verificación de accessLevel en tools del agente
**Estado:** Implementado (Fase 4 del deployment), por validar en producción
**Solución ya implementada:**
- Pre-check antes de tools de acción para usuarios CONSULTA
- Respuestas de redirección naturales (nunca dice "no tenés permiso")
- Tools de consulta sin restricción
**Esfuerzo:** 0.5 día (validación)

### 🟡 5.2 Agente genera links compartibles
**Estado:** Diseñado, por implementar
**Problema:** El agente WhatsApp debería poder enviar links de tracking y tickets automáticamente.
**Solución:**
- Nueva tool `generate_shared_link` que crea link y retorna URL
- Uso proactivo: cuando el productor pregunta estado, incluir link de tracking
- Uso reactivo: planta pide "mandale el link a [productor]"
**Esfuerzo:** 1 día (después de implementar links compartibles)

### 🔵 5.3 Agente crea fletes para planta
**Estado:** Por diseñar
**Problema:** La planta debería poder crear fletes por WhatsApp con el flujo plant-centric.
**Solución:**
- El agente pregunta productor, origen, destino, producto, cantidad
- Si productor es CONSULTA, ofrece asignar transporte en el mismo flujo
- Usa las mismas APIs que el wizard web
**Esfuerzo:** 2 días

---

## FASE 6 — Infraestructura y performance

### 🟡 6.1 Cache de CompanyAccess en sesión
**Estado:** Por implementar
**Problema:** Cada request que verifica accessLevel hace una query a CompanyAccess. Con alta concurrencia, puede ser costoso.
**Solución:**
- Cachear el accessLevel en la cookie/sesión del usuario
- Invalidar solo cuando la planta cambia el nivel (PATCH /company-access/:id/level)
- TTL de 5 minutos como fallback
**Esfuerzo:** 0.5 día

### 🟡 6.2 SSE: múltiples conexiones del mismo usuario
**Estado:** Problema observado en logs de producción
**Problema:** Los logs muestran el mismo usuario con 2-3 conexiones SSE simultáneas, con evictions. Puede causar pérdida de notificaciones.
**Solución:**
- Verificar que el frontend cierra la conexión SSE anterior antes de abrir una nueva
- Implementar heartbeat/reconnect más robusto
- Limit de 1 conexión por usuario con graceful close de la anterior
**Esfuerzo:** 1 día

### 🔵 6.3 Tests: estabilizar suite existente
**Estado:** 46 de 245 tests fallan (pre-existente, ts-jest config)
**Problema:** No hay red de seguridad para detectar regresiones.
**Solución:** Fix de configuración de ts-jest. Agregar tests para flujos plant-centric.
**Esfuerzo:** 2 días

---

## FASE 7 — Evoluciones futuras (post-piloto)

### ⚪ 7.1 Cualquier empresa como hub
**Estado:** Diseñado, diferido explícitamente
**Problema:** Hoy solo la planta puede tener empresas vinculadas. Productores y transportistas grandes también querrían gestionar terceros.
**Solución:** Cambiar condiciones `type === 'PLANT'` por `hasLinkedCompanies` en backend y frontend.
**Esfuerzo:** 2-3 días

### ⚪ 7.2 Modelo de acceso: nivel OPERATOR con restricciones
**Estado:** Conceptual
**Problema:** Hoy hay dos niveles: OPERATOR (todo) y CONSULTA (nada). Puede haber un punto medio: un transportista que puede aceptar fletes pero no crear.
**Solución:** Agregar overrides de acción al nivel OPERATOR (no al CONSULTA, que se mantiene sin excepciones). Un OPERATOR con `canCreateFreight: false` puede operar fletes pero no crearlos.
**Esfuerzo:** 2 días

### ⚪ 7.3 Módulo de contratos de campaña
**Estado:** Identificado como alta prioridad en documentos anteriores
**Problema:** Las plantas negocian volúmenes por campaña con productores. No hay forma de registrar ni trackear esos compromisos.
**Solución:** Modelo Contract con productor, producto, volumen comprometido, periodo, precio. Fletes se vinculan a contratos. Dashboard de cumplimiento.
**Esfuerzo:** 5-8 días

### ⚪ 7.4 Módulo de tickets de pesaje — UI web
**Estado:** Backend completo (6 endpoints + 30 tests + OCR), UI pendiente
**Problema:** Los tickets se crean y leen por API pero no hay pantalla web dedicada.
**Solución:** TicketsScreen con lista, detalle con foto, crear desde cámara/upload, vinculación a flete, OCR automático.
**Esfuerzo:** 3 días

### ⚪ 7.5 Módulo de insumos
**Estado:** Diseñado, diferido explícitamente
**Problema:** Sistema de cuenta corriente entre plantas y productores (fertilizantes, semillas, etc. a cuenta de la cosecha).
**Esfuerzo:** 8-12 días

### ⚪ 7.6 Dashboard analytics
**Estado:** Endpoints de analytics existen, UI por diseñar
**Solución:**
- Volumen por productor, por mes, por producto (gráficos)
- Tiempos promedio de viaje por ruta
- Utilización de flota (camiones activos vs inactivos)
- Ranking de transportistas por performance
**Esfuerzo:** 3-5 días

### ⚪ 7.7 LangGraph — migración del agente WhatsApp
**Estado:** Blueprint documentado (tolvink-langgraph-agent.ts), no en producción
**Problema:** El agente actual es stateless por conversación. LangGraph permite estado persistente, flujos multi-paso complejos, y mejor manejo de contexto.
**Esfuerzo:** 5-8 días

### ⚪ 7.8 PWA → Play Store (TWA)
**Estado:** Estrategia definida
**Solución:** Publicar como TWA en Play Store para mayor distribución y confianza.
**Esfuerzo:** 2 días

### ⚪ 7.9 Expansión regional
**Estado:** Argentina, Paraguay y sur de Brasil en el radar
**Problema:** Adaptación de formatos (RUT → CUIT, patentes, teléfonos), monedas, idioma brasileño.
**Esfuerzo:** Variable según mercado

---

## Timeline consolidado para piloto

```
SEMANA 1:
  🔴 0.1 Bug conversación duplicada          0.5 día
  🔴 0.2 Bug reactividad UI                  2 días
  🔴 0.3 Bug destName                        0.5 día
  🟠 0.4 Verificar migración producción      0.5 día

SEMANA 2:
  🟠 1.1 HomeScreen plant-centric            2 días
  🟠 1.2 Onboarding / empty state            1.5 días
  🟠 1.3 Navegación: Empresas en menú        0.5 día

SEMANA 3:
  🟡 1.4 DetailScreen "Creado por"           0.5 día
  🟡 1.5 ListScreen indicadores              1 día
  🟡 1.6 Notificaciones plant-centric        1 día
  🟡 2.1 HomeScreen productor CONSULTA       1 día
  🟡 2.2 HomeScreen transportista CONSULTA   1 día

SEMANA 4:
  🟡 4.1 Links compartibles FREIGHT          3 días
  🟡 4.2 Links compartibles TICKET           1 día
  🟠 5.1 Validar WhatsApp en producción      0.5 día

PILOTO LISTO: ~4 semanas
```

### Post-piloto (semanas 5-8):
```
  🔵 3.1 Acciones rápidas ListScreen         1.5 días
  🔵 3.2 Bulk creation                       1.5 días
  🔵 3.4 Mapa en HomeScreen                  2 días
  🔵 4.3 Link PORTAL                         3 días
  🔵 4.4 Mapas en links                      3 días
  🔵 6.3 Estabilizar tests                   2 días
```

### Horizonte (meses 2-3):
```
  ⚪ 7.1 Cualquier empresa como hub          2-3 días
  ⚪ 7.3 Contratos de campaña                5-8 días
  ⚪ 7.4 Tickets UI web                      3 días
  ⚪ 7.6 Dashboard analytics                 3-5 días
  ⚪ 7.7 LangGraph                           5-8 días
```
