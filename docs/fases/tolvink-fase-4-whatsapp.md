# Tolvink Plant-Centric — FASE 4 de 4: Agente WhatsApp

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. No preguntar antes de implementar. Diagnosticar, implementar, testear y commitear cada paso. Si algo es ambiguo, tomar la decisión que mejor se alinee con el contexto descrito y seguir adelante.**

**PREREQUISITO: Fases 1, 2 y 3 deben estar completadas y commiteadas.**

---

## Contexto

El modelo plant-centric está implementado: CompanyAccess con niveles OPERATOR/READONLY, auto-aceptación para transportista CONSULTA, UI adaptada con botones condicionales. Ahora se adapta el agente de WhatsApp para respetar los mismos niveles de acceso.

**REGLA FUNDAMENTAL: CONSULTA = cero confirmaciones. El agente NO ejecuta tools de acción para usuarios CONSULTA. Redirige naturalmente a la planta.**

**REGLA DE TONO: NUNCA decir "no tenés permiso", "estás en modo consulta", "tu nivel de acceso no permite", ni ninguna variante técnica. Las respuestas redirigen al actor correcto de forma natural y ofrecen una alternativa útil (consultar estado).**

---

## PASO 1: Diagnosticar agente actual

```bash
# Estructura del agente
find src/ -path "*/ai/*" -o -path "*/whatsapp/*" | head -30

# Tools del agente
grep -rn "tool\|Tool\|function.*definition\|toolDefinition" src/ai/ --include="*.ts" | head -30

# Tools de acción (las que se deben bloquear para CONSULTA)
grep -n "create_freight\|accept_freight\|update_status\|cancel_freight\|start_trip\|confirm_load\|finish_trip\|assign_transport" src/ai/ -r --include="*.ts" | head -30

# Tools de consulta (las que siempre funcionan)
grep -n "get_freight\|freight_status\|list_freight\|search_freight\|get_trucks\|fleet_status" src/ai/ -r --include="*.ts" | head -20

# Cómo se identifica al usuario que habla
grep -n "userId\|companyId\|activeCompany\|phone\|sender\|from" src/whatsapp/ -r --include="*.ts" | head -20
grep -n "userId\|companyId\|activeCompany" src/ai/ -r --include="*.ts" | head -20

# System prompt del agente
grep -rn "system\|prompt\|instruction\|role.*system" src/ai/ --include="*.ts" | head -20

# Cómo se obtiene el contexto del usuario
grep -n "getUser\|getUserBy\|findUser\|resolveUser" src/ai/ -r --include="*.ts" | head -15
grep -n "getUser\|getUserBy\|findUser" src/whatsapp/ -r --include="*.ts" | head -15
```

---

## PASO 2: Agregar verificación de accessLevel al flujo del agente

### 2.1. Obtener accessLevel del usuario que habla

Antes de ejecutar cualquier tool de acción, el agente necesita saber el accessLevel del usuario con la planta relevante. Implementar una función helper:

```typescript
// En el servicio del agente o como utilidad
async function getUserAccessLevel(userId: string, plantCompanyId: string): Promise<AccessLevel | null> {
  // 1. Obtener empresa activa del usuario
  // 2. Si la empresa ES la planta → retornar null (planta, puede todo)
  // 3. Buscar CompanyAccess entre planta y empresa del usuario
  // 4. Retornar accessLevel o NONE si no existe relación
}
```

### 2.2. Determinar la planta del contexto

Cuando el usuario habla sobre un flete específico, la planta se infiere del flete. Cuando habla en general, la planta se infiere de la relación CompanyAccess del usuario (puede haber más de una — usar la activa o la más reciente).

---

## PASO 3: Bloquear tools de acción para CONSULTA

### 3.1. Tools que se bloquean si CONSULTA

Estas tools NO deben ejecutarse si el usuario tiene accessLevel = READONLY con la planta del contexto:

- `create_freight` (crear flete)
- `accept_freight` / `respond_freight` con accept (aceptar asignación)
- `reject_freight` / `respond_freight` con reject (rechazar asignación)
- `update_status` / `start_trip` / `confirm_load` / `finish_trip` (transiciones de estado)
- `cancel_freight` (cancelar flete)
- `assign_transport` (asignar transportista)

### 3.2. Tools que SIEMPRE funcionan (consulta)

Estas tools funcionan independientemente del accessLevel:

- `get_freight` / `freight_status` / `list_freights` (consultar fletes)
- `search_freight` (buscar flete por número)
- `get_trucks` / `fleet_status` (consultar flota)
- Cualquier tool de solo lectura

### 3.3. Implementación del bloqueo

Hay dos estrategias posibles — elegir la que mejor se alinee con la arquitectura actual del agente:

**Estrategia A — Pre-check antes de cada tool:**

```typescript
// Antes de ejecutar la tool
const accessLevel = await getUserAccessLevel(userId, plantCompanyId);
const isConsulta = accessLevel === 'READONLY';

if (isConsulta && isActionTool(toolName)) {
  // No ejecutar la tool
  // Retornar respuesta de redirección
  return getConsultaRedirectResponse(toolName, plantName);
}

// Ejecutar la tool normalmente
```

**Estrategia B — En el system prompt del agente:**

Agregar al system prompt una sección que indique el accessLevel del usuario y las reglas:

```
El usuario actual tiene nivel de acceso CONSULTA con la planta [nombre].
Esto significa que NO puede crear, editar, cancelar fletes, ni aceptar asignaciones, ni actualizar estados.
Si el usuario intenta una acción bloqueada, NO ejecutar la tool. En su lugar, responder redirigiendo a la planta.
NUNCA mencionar "permisos", "nivel de acceso", "modo consulta" ni terminología técnica.
```

**Elegir la estrategia que mejor se integre con la arquitectura actual. Si el agente usa function calling con validación previa, usar A. Si el agente depende del prompt para decidir, usar B. Si usa ambos, implementar ambos.**

---

## PASO 4: Respuestas de redirección (tono natural)

Cuando un usuario CONSULTA intenta una acción bloqueada, el agente responde redirigiendo naturalmente. Estas son las respuestas modelo — el agente debe adaptarlas al contexto conversacional:

### 4.1. Intentar crear flete

```
Usuario: "Necesito mandar 30 toneladas de soja a la planta"
Agente: "La gestión de fletes la maneja [nombre planta]. Contactalos directamente para solicitar un flete nuevo. ¿Querés que te pase el estado de algún flete existente?"
```

### 4.2. Intentar aceptar asignación

```
Usuario: "Acepto el flete 123"
Agente: "El flete F26-123 fue gestionado por [nombre planta] y ya está confirmado con camión [patente]. ¿Querés ver el detalle completo?"
```

### 4.3. Intentar actualizar estado

```
Usuario: "Ya cargué" / "Ya llegué" / "Estoy en camino"
Agente: "El estado de los fletes lo gestiona [nombre planta]. Avisale directamente cuando hayas completado la carga. ¿Querés que te pase el estado actual del flete?"
```

### 4.4. Intentar cancelar

```
Usuario: "Cancelá el flete 123"
Agente: "No es posible cancelar este flete desde acá. Contactá a [nombre planta] para gestionar cambios. ¿Necesitás el detalle del flete?"
```

### 4.5. Intentar asignar

```
Usuario: "Asignale el flete a Transportes Sur"
Agente: "La asignación de transporte la gestiona [nombre planta]. Contactalos para coordinar. ¿Querés ver qué fletes tenés pendientes?"
```

### 4.6. Consultas (siempre funcionan)

```
Usuario: "¿Cómo va mi flete?" / "¿Qué fletes tengo?" / "Estado del flete 123"
Agente: [Respuesta normal con toda la información, links, detalle. Sin restricciones.]
```

---

## PASO 5: Notificaciones WhatsApp para usuarios CONSULTA

Los usuarios CONSULTA reciben TODAS las notificaciones normales. El nivel de acceso no reduce las notificaciones — solo las acciones.

Verificar que las notificaciones existentes se envían correctamente cuando:
- La planta crea un flete en nombre de un productor CONSULTA → el productor recibe "Se creó un flete de [producto] desde [campo]"
- La planta asigna transporte con auto-aceptación → transportista CONSULTA recibe "Te asignaron flete F26-XXX con camión [patente]"
- La planta actualiza estado → todos los actores reciben la notificación correspondiente
- Flete finalizado → productor recibe "Tu flete llegó a destino"

Si alguna notificación no se envía porque asume que solo el "creador" o el "aceptante" recibe, ajustar para que el productor/transportista del flete siempre reciba.

---

## PASO 6: Contexto del agente — incluir accessLevel

En el contexto que se le pasa al agente al inicio de cada conversación (o que se obtiene al identificar al usuario), agregar:

```typescript
// Al construir el contexto del agente
const context = {
  // ... datos existentes del usuario
  
  // NUEVO: relaciones con plantas y su nivel de acceso
  plantAccess: [
    {
      plantId: "xxx",
      plantName: "Planta SOFOVAL",
      accessLevel: "READONLY",  // CONSULTA
      // El agente sabe que este usuario no puede operar con esta planta
    },
    {
      plantId: "yyy",
      plantName: "Planta Agroterra",
      accessLevel: "OPERATOR",  // USO — puede operar normalmente
      // El agente permite acciones con esta planta
    }
  ]
};
```

**IMPORTANTE:** Un usuario puede ser CONSULTA con una planta y OPERATOR con otra. El agente debe verificar el accessLevel POR PLANTA, no de forma global. Si el usuario dice "creá un flete para Planta SOFOVAL" y es CONSULTA con SOFOVAL, bloquear. Si dice "creá un flete para Agroterra" y es OPERATOR con Agroterra, permitir.

---

## PASO 7: Validación

```bash
npm run build
npm test
```

Build limpio obligatorio.

Verificar manualmente si es posible:
- Usuario CONSULTA intenta crear flete → respuesta de redirección natural
- Usuario CONSULTA consulta estado → respuesta normal sin restricción
- Usuario OPERATOR opera normalmente → sin cambios
- Notificaciones llegan a usuarios CONSULTA correctamente

Commitear: `git add . && git commit -m "feat: plant-centric WhatsApp — accessLevel verification + natural redirect responses"`

---

## PASO 8: Push final

```bash
git push
```

---

## Lo que NO hacer

- NUNCA decir "no tenés permiso", "modo consulta", "nivel de acceso", "restricción", ni ninguna variante técnica
- NO bloquear tools de consulta (get_freight, list_freights, etc.)
- NO reducir notificaciones para CONSULTA — reciben todas las notificaciones normales
- NO asumir que un usuario es CONSULTA globalmente — verificar POR PLANTA
- NO modificar las tools existentes que funcionan correctamente para OPERATOR
- NO cambiar el flujo conversacional para usuarios OPERATOR — cero cambios para ellos
