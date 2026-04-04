# Tolvink — Mejoras Post Plant-Centric: FASE 1 de 3
# Ajustes de UI core + Notificaciones + LinkedCompanies UX

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. Diagnosticar, implementar, testear y commitear cada paso.**

**Estilo: inline con C, Ic, FONT de theme.jsx. Cero clases CSS. Reusar componentes existentes.**

---

## BLOQUE 1 — Navegación: "Empresas" como item de menú (solo planta)

### Diagnosticar

```bash
grep -n "navItems\|menuItems\|nav.*item\|BottomNav\|SideNav\|menu.*screen" src/layout/ -r --include="*.jsx" | head -20
grep -n "MenuScreen\|menu.*item\|navActive\|screen.*=.*'" src/screens/MenuScreen.jsx | head -30
grep -n "LinkedCompanies\|empresas.*vinculadas\|company-access" src/ -r --include="*.jsx" | head -15
grep -n "activeCompany.*type\|companyType\|PLANT" src/layout/ -r --include="*.jsx" | head -15
```

### Implementar

1. En el componente de navegación (AppLayout, BottomNav o SideNav — lo que use la app):
   - Agregar item "Empresas" SOLO cuando `activeCompany.type === 'PLANT'`
   - Ícono: usar un ícono existente de Ic (building, users-group, o similar — buscar en theme.jsx)
   - Posición en el nav: Inicio | Fletes | **Empresas** | Ubicaciones | Flota | Chat | Menú
   - Navega a LinkedCompaniesScreen

2. En MenuScreen (menú hamburguesa / pantalla de menú):
   - Agregar entrada "Empresas vinculadas" si es planta
   - Misma navegación a LinkedCompaniesScreen

3. Si LinkedCompaniesScreen no tiene un botón de "volver" o no está integrada en el layout principal, adaptarla para que funcione como pantalla de primer nivel (con header, back button si aplica).

---

## BLOQUE 2 — DetailScreen: "Creado por" visible

### Diagnosticar

```bash
grep -n "freight\.code\|freightCode\|código\|header" src/screens/DetailScreen.jsx | head -20
grep -n "producerCompany\|createdBy\|creator" src/screens/DetailScreen.jsx | head -15
```

### Implementar

En DetailScreen, debajo del código del flete y antes de la timeline, agregar una línea informativa:

```
Si freight.producerCompanyId existe Y freight.producerCompanyId !== freight.createdByCompanyId:
  → "Creado por [nombre empresa creadora] para [nombre productor]"
Si freight.producerCompanyId existe Y freight.producerCompanyId === freight.createdByCompanyId:
  → "Creado por [nombre productor]" (el productor creó su propio flete)
Si freight.producerCompanyId no existe:
  → No mostrar nada (flujo legacy)
```

Estilo: texto pequeño (fontSize 12), color C.t3 (texto terciario), debajo del código del flete. No debe ser prominente — es contexto, no acción.

Verificar que el endpoint GET /freights/:id retorna producerCompany con al menos el name. Si no, incluirlo en el include del query Prisma.

---

## BLOQUE 3 — Notificaciones para flujo plant-centric

### Diagnosticar

```bash
find src/ -name "*otification*" -type f | head -10
grep -n "notify\|sendNotification\|createNotification\|pushNotification" src/ -r --include="*.service.ts" | head -20
grep -n "notify\|notification\|sendNot" src/freights/freights.service.ts | head -20
grep -A 10 "createNotification\|notify.*create\|freight.*created" src/ -r --include="*.service.ts" | head -40
grep -A 10 "notify.*status\|notify.*state\|status.*changed" src/ -r --include="*.service.ts" | head -30
grep -A 10 "notify.*assign\|assign.*notification" src/ -r --include="*.service.ts" | head -20
```

### Implementar

Verificar y corregir estas 4 situaciones:

**3.1. Flete creado por planta para productor:**
- El productor (producerCompanyId) debe recibir notificación: "Se creó un flete de [producto] desde [campo] con destino [planta]"
- Buscar dónde se envían notificaciones al crear flete. Si solo notifica al creador (la planta), agregar producerCompanyId como destinatario adicional
- Los usuarios gerente y operario de la empresa productora deben recibir

**3.2. Estado cambiado por planta (in_progress, loaded, finished):**
- El productor debe recibir notificación de cada cambio: "Tu flete [código] cambió a [estado]"
- El transportista (si existe) debe recibir también
- Buscar la lógica de notificación al cambiar estado. Agregar producerCompanyId como destinatario si no está

**3.3. Transporte asignado con auto-aceptación (transportista CONSULTA):**
- El transportista CONSULTA debe recibir: "Te asignaron el flete [código] con camión [patente]"
- El chofer asignado debe recibir: "Tenés un viaje asignado: [código]"
- El productor debe recibir: "Tu flete [código] fue asignado a [transportista]"
- Verificar que la lógica de auto-aceptación envía las mismas notificaciones que la aceptación manual

**3.4. Flete finalizado:**
- El productor debe recibir: "Tu flete [código] llegó a destino"
- Verificar que producerCompanyId está incluido como destinatario

---

## BLOQUE 4 — LinkedCompaniesScreen: mejoras de UX

### Diagnosticar

```bash
find src/ -name "*inkedCompan*" -o -name "*linked*compan*" | head -10
wc -l src/screens/LinkedCompaniesScreen.jsx 2>/dev/null
grep -n "search\|buscar\|filter\|última.*actividad\|lastActivity\|freightCount" src/screens/LinkedCompaniesScreen.jsx 2>/dev/null | head -20
```

### Implementar

1. **Input de búsqueda** en la parte superior de la lista de empresas vinculadas:
   - Filtra por nombre de empresa en tiempo real (client-side)
   - Placeholder: "Buscar empresa..."

2. **Contador de fletes activos** en cada card de empresa:
   - Texto pequeño: "X fletes activos"
   - Dato: contar fletes donde producerCompanyId = empresa (para productores) o transporterCompanyId = empresa (para transportistas)
   - Puede venir del backend o calcularse del catálogo existente

3. **Indicador de última actividad**:
   - "Último flete: hace 3 días" o "Sin actividad"
   - Dato: fecha del flete más reciente asociado a esa empresa

4. **Botón "Ver fletes"** en cada card:
   - Navega a ListScreen con filtro pre-aplicado por esa empresa
   - Pasar como query param o estado de navegación

5. **Expandir empresa → resumen rápido**:
   - Al tocar la card (si no tiene expand aún): mostrar inline usuarios (X), camiones (X), campos (X), fletes activos (X)
   - Sin navegar a otra pantalla — info rápida para contexto

---

## Validación

```bash
npm run build
```

Build limpio. Probar:
- Nav de planta muestra "Empresas" y navega a LinkedCompaniesScreen
- DetailScreen muestra "Creado por" cuando corresponde
- Notificaciones llegan al productor cuando la planta crea/cambia estado de flete
- Buscar empresa en LinkedCompaniesScreen funciona
- Contador de fletes y última actividad visibles en cada card

Commitear: `git add . && git commit -m "feat: UX improvements — nav, detail creado-por, notifications, linked-companies UX"`
Pushear.
