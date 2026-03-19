# Tolvink Plant-Centric — FASE 2 de 4: Hook de Permisos + Gestión de Empresas/Usuarios/Flota

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. No preguntar antes de implementar. Diagnosticar, implementar, testear y commitear cada paso. Si algo es ambiguo, tomar la decisión que mejor se alinee con el contexto descrito y seguir adelante.**

**PREREQUISITO: La Fase 1 (schema + backend) debe estar completada y commiteada.**

---

## Contexto

En la Fase 1 se creó el modelo CompanyAccess, los campos ownerCompanyId en Field y Truck, producerCompanyId en Freight, y los endpoints backend correspondientes. Ahora se implementa la capa de frontend: el hook de permisos y las pantallas de gestión para que la planta administre empresas, usuarios y flota.

**REGLA FUNDAMENTAL: CONSULTA = cero confirmaciones. Sin excepciones.** La UI nunca muestra botones de acción a usuarios CONSULTA. No botones deshabilitados — simplemente no se renderizan.

**PRINCIPIO CENTRAL: Todo lo que la planta crea para una empresa queda disponible inmediatamente para los usuarios de esa empresa.**

**ESTILO: Todo inline con `C`, `Ic`, `FONT` de `theme.jsx`. Cero clases CSS externas. Reusar componentes existentes.**

---

## PASO 1: Diagnosticar frontend actual

```bash
# Hook de auth y empresa activa
grep -n "useAuth\|activeCompany\|companyType\|activeCompanyId" src/hooks/ -r | head -20
grep -n "useAuth\|activeCompany" src/stores/ -r | head -20

# ProfileScreen / Admin existente
find src/ -name "*rofile*" -o -name "*dmin*" | head -15
grep -n "Administración\|Empresa\|Usuarios\|createUser\|addUser" src/screens/ProfileScreen.jsx | head -20

# Pantalla de flota existente
find src/ -name "*lota*" -o -name "*ruck*" -o -name "*Fleet*" | head -15
grep -n "TruckForm\|createTruck\|FlotaScreen\|trucks" src/ -r --include="*.jsx" | head -20

# Componentes reutilizables
grep -n "export.*Btn\|export.*Input\|export.*Select\|export.*Modal" src/components/ -r | head -20
ls src/components/ 2>/dev/null || ls src/ | head -30

# API helpers
grep -n "apiGet\|apiPost\|apiPatch\|api\." src/hooks/ -r | head -20
grep -n "apiGet\|apiPost\|apiPatch" src/services/ -r 2>/dev/null | head -20

# Theme tokens
grep -n "export.*const C\|export.*const FONT\|export.*const Ic" src/ -r --include="*.jsx" | head -10
```

---

## PASO 2: Crear useAccessLevel hook

Crear el hook centralizado de permisos. Ubicación: junto a los demás hooks existentes (verificar dónde están con el diagnóstico).

```javascript
// useAccessLevel hook
// Resuelve permisos del usuario actual en el contexto de una planta

// Retorna:
// accessLevel: 'NONE' | 'READONLY' | 'OPERATOR' | null
// can(action): boolean — resuelve si puede ejecutar una acción
// isPlant: boolean — el usuario es la planta del contexto
// isConsulta: boolean — shortcut para accessLevel === 'READONLY'
// loading: boolean — mientras carga el acceso

// Reglas de resolución:
// 1. Si el usuario ES la planta → can() siempre true para acciones
// 2. Si OPERATOR → can() por rol (gerente/operario/chofer del UserCompany)
// 3. Si READONLY (CONSULTA) → can() false para TODA acción, true para visualización
// 4. Si NONE → false para todo
```

El hook debe:
1. Obtener la empresa activa del usuario (del store/auth existente)
2. Identificar si la empresa activa es de tipo PLANT
3. Si no es planta: llamar a `GET /company-access/my-access` para obtener el accessLevel con la planta del contexto
4. Cachear el resultado (no llamar en cada render)
5. Exponer `can(action)` que evalúa accessLevel + rol del usuario

Acciones que `can()` debe soportar:

```javascript
// Acciones de escritura (requieren OPERATOR o ser planta)
'createFreight', 'editFreight', 'cancelFreight',
'assignTransport', 'acceptFreight', 'rejectFreight',
'updateStatus', 'startTrip', 'confirmLoad', 'finishTrip',
'createField', 'editField', 'deleteField',
'createTruck', 'editTruck', 'deleteTruck',
'manageUsers'

// Acciones de lectura (READONLY puede)
'viewFreights', 'viewFreightDetail', 'viewTimeline',
'viewTickets', 'viewDocuments', 'viewFleetDetails',
'viewLocations', 'viewMap'
```

Para acciones de lectura en modo CONSULTA, verificar si hay override en `permissions` (canViewTickets, etc.).

---

## PASO 3: Sección "Empresas vinculadas" en ProfileScreen (solo planta)

Agregar una nueva sección en la pantalla de perfil/administración que solo es visible cuando `activeCompany.type === 'PLANT'`.

### 3.1. Lista de empresas vinculadas

- Llamar a `GET /company-access/{plantCompanyId}` para obtener la lista
- Mostrar cada empresa con: nombre, tipo (Productor/Transportista badge), y un **toggle CONSULTA / USO**
- El toggle tiene dos estados claros:
  - **USO** (verde, OPERATOR): "Esta empresa puede operar normalmente"
  - **CONSULTA** (azul, READONLY): "Esta empresa solo puede ver. La planta gestiona todo."
- Al cambiar el toggle: `PATCH /company-access/:id/level` con el nuevo accessLevel
- El cambio es inmediato, sin modal de confirmación

### 3.2. Botón "Nueva empresa"

- Abre formulario/modal con campos: nombre (obligatorio), tipo (select: Productor / Transportista, obligatorio), RUT (opcional), email de contacto (opcional), tiene flota propia (checkbox, solo si tipo = Productor)
- Al guardar: `POST /company-access/create-company`
- Al completar: la empresa aparece en la lista con toggle en USO (default)

### 3.3. Expandir empresa → ver detalle

Al tocar una empresa de la lista, expandir o navegar a un detalle que muestre:
- Datos de la empresa (nombre, tipo, RUT, contacto)
- Lista de usuarios de esa empresa (ver paso 4)
- Acceso rápido a flota de esa empresa (ver paso 5)
- Acceso rápido a ubicaciones de esa empresa (link a LocationsScreen con filtro)

---

## PASO 4: Crear usuarios para empresas vinculadas (dentro de la ficha de empresa)

Dentro del detalle de cada empresa vinculada:

### 4.1. Lista de usuarios

- Listar usuarios de esa empresa (endpoint existente o nuevo que acepte companyId como filtro)
- Mostrar: nombre, teléfono, rol (Gerente/Operario/Chofer), email

### 4.2. Botón "Crear usuario"

- Abre formulario con: nombre (obligatorio), teléfono (obligatorio, formato uruguayo 09X XXX XXX), email (opcional), rol (select: Gerente / Operario / Chofer, obligatorio)
- Al guardar: `POST /company-access/create-user` con targetCompanyId = empresa actual
- El usuario queda operativo inmediatamente
- Mostrar confirmación breve y actualizar la lista

---

## PASO 5: Gestión de flota cross-company (pantalla de flota)

Buscar la pantalla de flota existente (FlotaScreen, TrucksScreen, o sección de flota en ProfileScreen). Agregar funcionalidad para que la planta vea y cree camiones para otras empresas.

### 5.1. Dropdown de empresa (solo planta)

En la parte superior de la pantalla de flota, agregar un dropdown:
- "Mi flota" (default) | [nombre transportista 1] | [nombre transportista 2] | [nombre productor 1]...
- Solo visible cuando `activeCompany.type === 'PLANT'`
- Datos: de las empresas vinculadas que tengan tipo TRANSPORTER o PRODUCER con hasInternalFleet
- Al seleccionar: filtra la lista de camiones con `GET /trucks?ownerCompanyId={empresaSeleccionada}` si es otra empresa, o sin filtro si es "Mi flota"

### 5.2. Crear camión para otra empresa

- Cuando hay una empresa seleccionada en el dropdown, el botón "Crear camión" envía `ownerCompanyId = empresaSeleccionada` en el POST /trucks
- El camión aparece inmediatamente en la lista
- Badge en cada camión indicando a qué empresa pertenece (nombre de la empresa)

### 5.3. Badge de empresa en camiones

Cada camión en la lista muestra un badge/subtítulo con el nombre de la empresa dueña. Si es propio de la planta, no muestra badge.

---

## PASO 6: Validación

```bash
npm run build
```

Build limpio obligatorio. Corregir todo error o warning.

Verificar manualmente (si es posible):
- El hook useAccessLevel retorna datos correctos
- La sección de empresas vinculadas aparece solo para planta
- El toggle CONSULTA/USO funciona y persiste
- Se puede crear empresa, usuario y camión para empresas vinculadas

Commitear: `git add . && git commit -m "feat: plant-centric frontend — useAccessLevel hook + gestión empresas/usuarios/flota"`

---

## Lo que NO hacer

- NO crear overrides de acción en el hook (canAcceptFreight NO EXISTE como override)
- NO mostrar la sección de empresas vinculadas a usuarios que no son planta
- NO permitir crear empresas/usuarios/camiones para empresas no vinculadas (validar CompanyAccess)
- NO usar clases CSS — todo inline con C, Ic, FONT de theme.jsx
- NO crear componentes nuevos si existe uno reutilizable (Btn, Input, Select, Modal)
