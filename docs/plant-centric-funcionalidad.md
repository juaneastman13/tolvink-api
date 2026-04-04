# Tolvink — Modelo Plant-Centric: Funcionalidades y Guía de UI

## Resumen

El modelo plant-centric convierte a la **planta** en el hub operativo central. La planta configura qué empresas (productores y transportistas) pueden operar con ella, y con qué nivel de acceso:

- **USO (OPERATOR)**: Opera normalmente — crea fletes, acepta asignaciones, actualiza estados.
- **CONSULTA (READONLY)**: Solo puede ver — no puede crear, aceptar, ni modificar nada. La planta absorbe todas las acciones.

---

## 1. Gestión de Empresas Vinculadas (solo Planta)

### Dónde: Menú → Empresas vinculadas (LinkedCompaniesScreen)

**Qué deberías ver:**
- Lista de empresas vinculadas, separadas por tipo:
  - **Productores** (badge naranja)
  - **Transportistas** (badge turquesa)
- Cada empresa muestra:
  - Nombre
  - Badge **USO** (verde) o **CONSULTA** (azul)
  - Botón para activar/desactivar la vinculación

**Acciones disponibles:**
- **Cambiar nivel de acceso**: Click en el badge USO/CONSULTA para alternar
- **Crear empresa nueva**: Formulario con nombre, tipo (Productor/Transportista), RUT, email, flota propia, y nivel inicial (USO o CONSULTA)
- **Expandir empresa**: Click para ver los usuarios de esa empresa
- **Crear usuario para empresa vinculada**: Dentro de la empresa expandida, agregar usuario con nombre, teléfono, email, rol (Gerente/Operario/Chofer)

---

## 2. Crear Flete en Nombre de un Productor (solo Planta)

### Dónde: Nuevo Flete (NewScreen)

**Qué deberías ver:**
- **Paso 0 nuevo — "¿Para qué productor es este flete?"**: Lista de productores vinculados como botones seleccionables
- Al seleccionar productor, los campos de origen se cargan desde los campos de ESE productor (no los de la planta)
- El destino se pre-selecciona a la planta actual
- Al crear el flete, aparece el `producerCompanyId` asociado

**Flujo:**
1. Seleccionar productor vinculado
2. Elegir campo/lote del productor
3. El destino es tu planta (pre-seleccionado)
4. Grano, toneladas, fecha, hora
5. Confirmar → el flete se crea con el productor como originCompany

---

## 3. Badge de Productor en Fletes (solo Planta)

### Dónde: Lista de Fletes (ListScreen) + Tarjetas (FreightCard)

**Qué deberías ver:**
- En cada tarjeta de flete creado en nombre de un productor: badge con icono de usuario + nombre del productor en color acento
- **Filtro nuevo "Productor"**: Dropdown en la barra de filtros que permite filtrar fletes por empresa productora
- En la vista tabla: columna de origen muestra subtítulo con nombre del productor
- En la vista kanban: badge de productor debajo del origen

---

## 4. Detalle de Flete — CONSULTA Gating

### Dónde: Detalle del Flete (DetailScreen)

**Qué deberías ver según tu rol:**

#### Si sos Productor/Transportista CONSULTA:
- **Cero botones de acción**: No aparecen Aceptar, Iniciar, Confirmar carga, Finalizar, Cancelar, Editar, Asignar
- Solo ves información de lectura: estado, datos del flete, mapa, documentos
- No podés editar la cantidad de camiones ni asignaciones

#### Si sos Planta y el transportista es CONSULTA:
- **Vos absorbés las acciones del transportista**: Aparecen botones de "Iniciar viaje", "Confirmar carga", "Confirmar entrega" que normalmente serían del transportista
- Cada assignment muestra si el transportista es CONSULTA

#### Si sos Planta y el transportista es USO:
- Flujo normal — el transportista gestiona sus propias acciones

#### Fila de Productor:
- Si el flete tiene `producerCompanyName`, aparece una fila con icono de usuario + "Productor" + nombre

---

## 5. Asignación de Transporte — Flujo CONSULTA

### Dónde: Modal de Asignación (AssignModal)

**Qué deberías ver cuando asignás un transportista CONSULTA:**
- Banner informativo: *"Este transportista está en modo consulta. Seleccioná vehículo y chofer. La asignación se confirma automáticamente."*
- **No hay paso de delegación** — la planta debe elegir camión y chofer directamente
- Pasos: Vehículo → Chofer → Toneladas
- Botón de confirmación dice **"Asignar y confirmar"** (en vez de solo "Confirmar")
- No aparecen opciones de "Crear camión" ni "Crear chofer" (la planta no crea recursos en la empresa CONSULTA)
- El flete pasa directamente a estado **Aceptado** (auto-accept)

**Cuando asignás un transportista USO:**
- Flujo normal de delegación: la planta asigna empresa, el transportista luego asigna camión y chofer

---

## 6. Ubicaciones — Filtro Cross-Company (solo Planta)

### Dónde: Ubicaciones (LocationsScreen)

**Qué deberías ver:**
- **Dropdown de empresa**: Filtra campos por "Todos", "Mis ubicaciones", o una empresa productora vinculada específica
- Al seleccionar un productor, se muestran solo los campos de ese productor
- Al crear un campo nuevo con un productor seleccionado, el campo se crea con `ownerCompanyId` del productor

---

## 7. Flota — Gestión Cross-Company (solo Planta)

### Dónde: Flota / Camiones (TrucksScreen)

**Qué deberías ver:**
- **Dropdown de empresa**: Seleccionar de qué empresa ver/gestionar la flota
- Opciones: tu empresa + todas las empresas transportistas vinculadas (y productores con flota propia)
- Al seleccionar una empresa, se cargan sus camiones y choferes
- Al crear un camión con una empresa seleccionada, se guarda con `ownerCompanyId`

---

## 8. Pantalla Inicio — CONSULTA Bloqueado

### Dónde: Home (HomeScreen) + Navegación

**Qué deberías ver si sos CONSULTA:**
- **Sin botón "Nuevo flete"**: El botón de crear flete no aparece (no se muestra, no está deshabilitado)
- Sin acciones en las tarjetas de la pantalla de inicio
- Solo navegación a ver fletes, detalle, mapa

---

## 9. WhatsApp / AI Chat — CONSULTA Natural

### Dónde: WhatsApp Bot + Chat Web

**Qué deberías ver si sos CONSULTA:**
- **Consultas funcionan normal**: "¿Cómo va mi flete?", "Estado del flete 123", "Mis fletes" → respuesta completa
- **Acciones bloqueadas con redirección natural**:
  - "Necesito mandar soja" → *"La gestión de fletes la maneja [Planta X]. Contactalos para solicitar un flete nuevo. ¿Querés que te pase el estado de algún flete existente?"*
  - "Acepto el flete" → *"El flete fue gestionado por [Planta X] y ya está confirmado. ¿Querés ver el detalle?"*
  - "Ya cargué" → *"El estado lo gestiona [Planta X]. Avisale directamente. ¿Querés que te pase el estado actual?"*
- **NUNCA dice**: "no tenés permiso", "modo consulta", "nivel de acceso", "restricción"
- **Siempre ofrece alternativa**: consultar estado, ver detalle, etc.

**Si sos USO:** Todo funciona normal, sin cambios.

---

## 10. Notificaciones — Sin Cambios para CONSULTA

Los usuarios CONSULTA **reciben todas las notificaciones** normales:
- Flete creado en su nombre → notificación
- Camión asignado (auto-aceptado) → notificación
- Estado actualizado → notificación
- Flete finalizado → notificación

El nivel de acceso solo restringe **acciones**, nunca **notificaciones**.

---

## Tabla Resumen de Permisos

| Acción | Planta | Productor USO | Productor CONSULTA | Transportista USO | Transportista CONSULTA |
|--------|--------|---------------|--------------------|--------------------|------------------------|
| Ver fletes | ✅ | ✅ | ✅ | ✅ | ✅ |
| Crear flete | ✅ (en nombre de) | ✅ | ❌ | ❌ | ❌ |
| Asignar transporte | ✅ | ❌ | ❌ | ❌ | ❌ |
| Aceptar asignación | N/A | N/A | N/A | ✅ (camión+chofer) | ❌ (auto-accept) |
| Iniciar viaje | ✅ (si transp. CONSULTA) | ✅ (flota propia) | ❌ | ✅ | ❌ |
| Confirmar carga | ✅ (si transp. CONSULTA) | ✅ | ❌ | ✅ | ❌ |
| Confirmar entrega | ✅ | ❌ | ❌ | ✅ | ❌ |
| Cancelar flete | ✅ | ✅ | ❌ | ❌ | ❌ |
| Editar flete | ✅ | ✅ | ❌ | ❌ | ❌ |
| Gestionar empresas | ✅ | ❌ | ❌ | ❌ | ❌ |
| Ver notificaciones | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usar WhatsApp (consultas) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Usar WhatsApp (acciones) | ✅ | ✅ | ❌ | ✅ | ❌ |
