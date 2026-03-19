# Tolvink Plant-Centric — FASE 3 de 4: Adaptación de Pantallas

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. No preguntar antes de implementar. Diagnosticar, implementar, testear y commitear cada paso. Si algo es ambiguo, tomar la decisión que mejor se alinee con el contexto descrito y seguir adelante.**

**PREREQUISITO: Fases 1 (schema + backend) y 2 (hook + admin) deben estar completadas y commiteadas.**

---

## Contexto

El backend está listo (CompanyAccess, ownerCompanyId en Field/Truck, producerCompanyId en Freight, auto-aceptación). El hook useAccessLevel está implementado. Ahora se adaptan todas las pantallas operativas para que respeten el modelo plant-centric.

**REGLA FUNDAMENTAL: CONSULTA = cero confirmaciones. La UI nunca muestra botones de acción a usuarios CONSULTA. No deshabilitados — no se renderizan.**

**ESTILO: Todo inline con `C`, `Ic`, `FONT` de `theme.jsx`. Cero clases CSS externas.**

---

## PASO 1: Diagnosticar pantallas actuales

```bash
# LocationsScreen
grep -n "companyId\|activeCompany\|fields\|createField\|ownerCompany" src/screens/LocationsScreen.jsx | head -30
wc -l src/screens/LocationsScreen.jsx

# NewScreen
grep -n "originMode\|fieldId\|lotId\|plantId\|destMode\|catalog\|fields\|producerCompany" src/screens/NewScreen.jsx | head -30
wc -l src/screens/NewScreen.jsx

# DetailScreen — botones de acción
grep -n "handleAccept\|handleStart\|handleFinish\|handleCancel\|handleAssign\|Aceptar\|Iniciar\|Finalizar\|Cancelar\|Asignar" src/screens/DetailScreen.jsx | head -30
wc -l src/screens/DetailScreen.jsx

# AssignModal
find src/ -name "*ssign*" -o -name "*assign*" | head -10
grep -n "AssignModal\|TruckSelect\|transporterCompany\|handleAssign" src/ -r --include="*.jsx" | head -20

# ListScreen
grep -n "producerCompany\|producer\|filtro\|filter" src/screens/ListScreen.jsx | head -20

# HomeScreen
grep -n "Nuevo flete\|Solicitar\|crear\|new.*freight\|NewScreen" src/screens/HomeScreen.jsx | head -15

# API de catalog
grep -n "useCatalog\|catalog\|fields\|plants\|trucks" src/hooks/ -r | head -20
```

---

## PASO 2: LocationsScreen — filtro por empresa

Para usuarios tipo planta (`activeCompany.type === 'PLANT'`), agregar:

### 2.1. Dropdown de empresa

En la parte superior del panel lateral (antes de la lista de campos), agregar un dropdown/select:
- Opciones: "Todas" | "Mis ubicaciones" | [nombre productor 1] | [nombre productor 2]...
- Datos: llamar a `GET /fields/owners-summary` para obtener lista de empresas con campos
- Solo visible cuando activeCompany.type === 'PLANT'
- Al seleccionar: refiltrar la lista de campos y los marcadores del mapa

### 2.2. Crear campo con ownerCompanyId

Si hay una empresa seleccionada en el dropdown (que no sea "Todas" ni "Mis ubicaciones"), al crear un campo nuevo:
- Enviar `ownerCompanyId = empresaSeleccionada` en el POST /fields
- El campo se crea asignado a esa empresa

Si está en "Mis ubicaciones" o "Todas": crear sin ownerCompanyId (campo propio de la planta).

### 2.3. Badge de empresa

Cada campo en la lista muestra un badge/subtítulo con el nombre de la empresa asignada. Si es propio de la planta, no muestra badge.

### 2.4. Mapa filtrado

Los marcadores del mapa se filtran según la empresa seleccionada. Si "Todas", mostrar todos con color diferenciado por empresa.

---

## PASO 3: NewScreen — paso de selección de productor

Cuando `activeCompany.type === 'PLANT'`, el wizard de creación de flete cambia:

### 3.1. Paso 0 — Selección de productor (nuevo, antes del origen)

- Título: "¿Para qué productor es este flete?"
- Dropdown/select con lista de productores vinculados a la planta
  - Datos: `GET /company-access/{plantId}` filtrado por granteeType = PRODUCER
  - Mostrar nombre de cada empresa productora
- Input de búsqueda para filtrar si la lista es larga
- Al seleccionar: guardar `producerCompanyId` en el estado del formulario
- Avanzar al paso de origen

### 3.2. Paso de origen — filtrado por productor

Una vez seleccionado el productor:
- Fetch campos con `GET /fields?ownerCompanyId={selectedProducerId}`
- Si hay campos: mostrar dropdown normal de campos, luego lotes al seleccionar campo
- Si no hay campos: mostrar empty state con CTA "Crear campo para [nombre productor]"
  - Formulario inline: nombre del campo + LocationPicker
  - Al guardar: POST /fields con ownerCompanyId = producerSeleccionado
  - Actualizar dropdown con el nuevo campo
- Crear lote on-the-fly sigue funcionando (ya existe)
- El modo "mapa" (custom) sigue disponible como alternativa

### 3.3. Paso de destino — pre-selección

- Pre-seleccionar la planta del usuario como destino (la planta misma)
- Si tiene sucursales: mostrar selector de sucursal
- Se puede cambiar a otra planta o custom — no bloquear

### 3.4. Cambiar de productor

Si el usuario vuelve atrás al paso 0 y cambia de productor: resetear campo y lote seleccionados (son específicos del productor).

### 3.5. Submit con producerCompanyId

En el submit del formulario, incluir `producerCompanyId` en el body del POST /freights.

### 3.6. Si NO es planta

Si `activeCompany.type !== 'PLANT'`: NO mostrar paso 0. Flujo actual sin cambios.

---

## PASO 4: DetailScreen — botones condicionales

Usar el hook `useAccessLevel` para decidir qué botones renderizar. Importar el hook y aplicar en cada botón:

### 4.1. Lógica de renderizado

```jsx
const { can, isPlant, isConsulta } = useAccessLevel();

// Determinar si el transportista de este flete es CONSULTA
// (necesita accessLevel del transportista con la planta del flete)
const transporterIsConsulta = /* fetch o derivar del contexto del flete */;
```

Botones:

| Botón | Condición para mostrar |
|-------|----------------------|
| Asignar transporte | `can('assignTransport')` — planta siempre, productor OPERATOR si corresponde |
| Aceptar flete | `can('acceptFreight')` — solo transportista OPERATOR |
| Rechazar flete | `can('rejectFreight')` — solo transportista OPERATOR |
| Iniciar viaje | `can('startTrip')` — chofer OPERATOR, o planta si transportista es CONSULTA |
| Confirmar carga | `can('confirmLoad')` — chofer OPERATOR, o planta si transportista es CONSULTA |
| Finalizar | `can('finishTrip')` — chofer OPERATOR, o planta si transportista es CONSULTA |
| Editar flete | `can('editFreight')` — planta siempre, productor OPERATOR |
| Cancelar flete | `can('cancelFreight')` — planta siempre, productor OPERATOR |

### 4.2. Planta ve botones de estado cuando transportista es CONSULTA

Cuando la planta abre el detalle de un flete cuyo transportista es CONSULTA, la planta debe ver los botones de "Iniciar viaje", "Confirmar carga", "Finalizar" (según el estado actual del flete). Estos botones normalmente solo los ve el chofer, pero en este escenario la planta los absorbe.

### 4.3. Sección "Productor" en detalle

Si el flete tiene `producerCompanyId`, mostrar sección con nombre de la empresa productora en la información del flete.

### 4.4. CONSULTA no ve ningún botón de acción

Si el usuario actual es CONSULTA (isConsulta === true): no renderizar NINGÚN botón que modifique el flete. Solo información y visualización.

---

## PASO 5: AssignModal — variante según acceso

Buscar el componente AssignModal (o equivalente donde la planta asigna transportista). Modificar:

### 5.1. Después de seleccionar empresa transportista

Una vez que la planta elige un transportista en el selector:

1. Verificar el accessLevel de ese transportista con la planta: `GET /company-access/` y buscar la relación, o cachear del listado ya obtenido
2. Determinar la variante:

### 5.2. Variante OPERATOR (transportista opera)

- Solo selector de empresa transportista (ya existente)
- Camión/chofer los elige el transportista al aceptar
- Botón: "Asignar"
- Sin cambios respecto al flujo actual

### 5.3. Variante CONSULTA (planta asigna todo)

- Selector de empresa transportista (existente)
- **+ Selector de camión** de la flota del transportista: `GET /trucks?ownerCompanyId={transportistaId}`
  - Mostrar: patente + marca/modelo + capacidad
  - Si el camión tiene chofer default, pre-seleccionar
- **+ Selector de chofer** del transportista
  - Listar usuarios de la empresa con rol chofer
  - Auto-seleccionar si el camión tiene chofer default
- Los tres campos son **obligatorios**
- Texto explicativo visible: "Este transportista está en modo consulta. La asignación se confirma automáticamente."
- Botón: "Asignar y confirmar" (texto distinto para que sea claro)
- Al submit: enviar transporterCompanyId + truckId + driverId al backend (el backend auto-acepta)

### 5.4. Variante Flota propia

Sin cambios — ya existe.

---

## PASO 6: ListScreen — badge de productor y filtro

### 6.1. Badge de productor (solo vista planta)

Si `activeCompany.type === 'PLANT'` y el flete tiene `producerCompanyId`:
- Mostrar nombre del productor como subtítulo o badge en cada card de flete
- Tanto en vista cards mobile como tabla desktop

### 6.2. Filtro por productor (solo planta)

Agregar un filtro/dropdown en la barra de filtros:
- "Todos los productores" | [nombre productor 1] | [nombre productor 2]...
- Al seleccionar: filtrar lista por producerCompanyId

---

## PASO 7: HomeScreen — ocultar acciones para CONSULTA

### 7.1. Ocultar "Nuevo flete" para CONSULTA

Si `isConsulta === true`:
- Ocultar botón "Nuevo flete" / "Solicitar transporte" / FAB de creación
- Ocultar accesos rápidos a acciones de escritura
- Mantener métricas, lista de fletes activos, notificaciones

### 7.2. Badge de productor en cards de Home (solo planta)

Si la planta ve sus fletes en el Home: mostrar nombre del productor en las cards, igual que en ListScreen.

---

## PASO 8: Validación

```bash
npm run build
```

Build limpio obligatorio. Corregir todo error o warning.

Verificar:
- LocationsScreen muestra dropdown de empresa para planta
- NewScreen muestra paso 0 (productor) para planta, flujo normal para otros
- DetailScreen oculta botones para CONSULTA, muestra botones de estado a planta cuando transportista es CONSULTA
- AssignModal muestra selectores de camión/chofer para transportista CONSULTA
- ListScreen/HomeScreen ocultan acciones para CONSULTA

Commitear: `git add . && git commit -m "feat: plant-centric frontend — pantallas adaptadas (Locations, New, Detail, Assign, List, Home)"`

---

## Lo que NO hacer

- NO crear rutas separadas para CONSULTA — usar renderizado condicional con useAccessLevel
- NO mostrar botones deshabilitados — no renderizarlos
- NO tocar el flujo de NewScreen cuando el usuario NO es planta — cero cambios para no-planta
- NO crear componentes nuevos innecesarios — reusar Btn, Input, Select, Modal existentes
- NO hardcodear accessLevel — siempre obtenerlo del hook useAccessLevel
- NO usar clases CSS — todo inline con C, Ic, FONT
