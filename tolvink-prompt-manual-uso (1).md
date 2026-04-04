# Tolvink — Generar Manual de Uso HTML

**INSTRUCCIÓN: Generar un archivo HTML completo con el manual de uso de Tolvink. El HTML debe ser autocontenido (CSS inline o en `<style>`), profesional, responsive, y con navegación interna. No necesita conexión a internet para verse.**

---

## PASO 1 — Leer el proyecto para entender las pantallas y funcionalidades

```bash
# Pantallas disponibles
find src/screens -name "*.jsx" | sort

# Nombres de pantallas y navegación
grep -rn "screen.*=\|setScreen\|navigate\|MenuScreen\|navItems" src/ --include="*.jsx" | grep -v node_modules | head -40

# Funcionalidades por pantalla
for f in src/screens/*.jsx; do echo "=== $f ==="; head -5 "$f"; grep -n "function\|export\|const.*Screen\|handleSubmit\|handleCreate\|handleSave\|onClick" "$f" | head -10; echo ""; done

# Roles y tipos de empresa
grep -n "CompanyType\|UserRole\|PLANT\|PRODUCER\|TRANSPORTER\|MANAGER\|OPERATOR\|DRIVER" prisma/schema.prisma | head -20

# Access levels
grep -n "AccessLevel\|READONLY\|OPERATOR\|CONSULTA\|USO" prisma/schema.prisma | head -10
grep -rn "isConsulta\|accessLevel\|useAccessLevel\|can(" src/screens/ --include="*.jsx" | head -20

# Menú y navegación
grep -n "menuItems\|navItems\|sideNav\|bottomNav" src/layout/ -r --include="*.jsx" | head -15
cat src/screens/MenuScreen.jsx | head -60

# NewScreen wizard pasos
grep -n "step\|paso\|wizard\|Step\|Paso" src/screens/NewScreen.jsx | head -20

# Estados del flete
grep -n "pending_assignment\|assigned\|accepted\|in_progress\|loaded\|finished\|canceled" src/ -r --include="*.ts" | grep -i "enum\|status\|const" | head -10

# Funcionalidades plant-centric
grep -n "producerCompany\|ownerCompanyId\|LinkedCompanies\|CompanyAccess" src/screens/ -r --include="*.jsx" | head -20

# Documentos
grep -n "DocumentsScreen\|WeighTicket\|ocr\|OCR" src/screens/ -r --include="*.jsx" | head -15

# Flota
grep -n "TrucksScreen\|FleetScreen\|truck\|driver\|camión\|chofer" src/screens/ -r --include="*.jsx" | head -15

# Ubicaciones
grep -n "LocationsScreen\|field\|lot\|poi\|mapa" src/screens/ -r --include="*.jsx" | head -15

# Compartir links
grep -n "SharedLink\|share.*link\|compartir" src/screens/ -r --include="*.jsx" | head -10
```

---

## PASO 2 — Generar el HTML

Crear el archivo `/home/claude/manual-tolvink.html` con la siguiente estructura:

### Estructura del documento

```
MANUAL DE USO — TOLVINK
├── Índice general (con links internos a cada sección)
├── Introducción
│   ├── ¿Qué es Tolvink?
│   ├── Tipos de usuario
│   ├── Niveles de acceso (USO vs CONSULTA)
│   └── Cómo acceder (web + app)
│
├── PLANTA DE ACOPIO
│   ├── Manual Web
│   │   ├── Inicio / Dashboard
│   │   ├── Empresas vinculadas (crear, gestionar, cambiar nivel)
│   │   ├── Crear flete (wizard paso a paso)
│   │   ├── Asignar transporte (OPERATOR vs CONSULTA)
│   │   ├── Gestión de estados del flete
│   │   ├── Lista de fletes (filtros, búsqueda, acciones rápidas)
│   │   ├── Detalle del flete
│   │   ├── Ubicaciones (crear campos, lotes, cross-company)
│   │   ├── Flota (camiones, choferes, cross-company)
│   │   ├── Documentos (ver, OCR, exportar)
│   │   ├── Links compartibles
│   │   ├── Notificaciones
│   │   ├── Estadísticas
│   │   └── Administración
│   └── Manual App (WhatsApp)
│       ├── Primeros pasos
│       ├── Crear flete por WhatsApp
│       ├── Consultar estado
│       ├── Gestionar ubicaciones
│       └── Comandos disponibles
│
├── PRODUCTOR
│   ├── Productor USO (OPERATOR)
│   │   ├── Manual Web
│   │   │   ├── Inicio
│   │   │   ├── Crear flete
│   │   │   ├── Mis fletes (lista, detalle, estados)
│   │   │   ├── Mis ubicaciones
│   │   │   ├── Mi flota (si tiene)
│   │   │   ├── Documentos
│   │   │   ├── Notificaciones
│   │   │   └── Perfil y configuración
│   │   └── Manual App (WhatsApp)
│   │       ├── Crear flete
│   │       ├── Consultar estado
│   │       └── Gestionar ubicaciones
│   │
│   └── Productor CONSULTA (READONLY)
│       ├── Manual Web
│       │   ├── Inicio (dashboard solo lectura)
│       │   ├── Mis fletes (ver estado, sin acciones)
│       │   ├── Mis ubicaciones (solo lectura)
│       │   ├── Documentos (ver, descargar)
│       │   ├── Notificaciones
│       │   └── Qué NO puedo hacer (y quién lo gestiona)
│       └── Manual App (WhatsApp)
│           ├── Consultar estado de fletes
│           └── Qué NO puedo hacer
│
├── TRANSPORTISTA
│   ├── Transportista USO (OPERATOR)
│   │   ├── Manual Web
│   │   │   ├── Inicio
│   │   │   ├── Aceptar/rechazar fletes
│   │   │   ├── Mis viajes (lista, detalle)
│   │   │   ├── Mi flota (camiones, choferes)
│   │   │   ├── Documentos
│   │   │   ├── Notificaciones
│   │   │   └── Perfil y configuración
│   │   └── Manual App (WhatsApp)
│   │       ├── Aceptar fletes
│   │       ├── Consultar viajes
│   │       └── Gestionar flota
│   │
│   └── Transportista CONSULTA (READONLY)
│       ├── Manual Web
│       │   ├── Inicio (solo lectura)
│       │   ├── Mis viajes (ver estado, sin acciones)
│       │   ├── Mi flota (solo lectura)
│       │   ├── Documentos (ver, descargar)
│       │   └── Qué NO puedo hacer
│       └── Manual App (WhatsApp)
│           ├── Consultar estado de viajes
│           └── Qué NO puedo hacer
│
├── CHOFER
│   ├── Chofer de transportista USO
│   │   ├── Manual Web
│   │   │   ├── Inicio (mis viajes del día)
│   │   │   ├── Iniciar viaje
│   │   │   ├── Confirmar carga
│   │   │   ├── Finalizar viaje
│   │   │   └── Ver detalle del viaje
│   │   └── Manual App (WhatsApp)
│   │       ├── Ver viaje asignado
│   │       ├── Actualizar estado
│   │       └── Enviar ubicación
│   │
│   └── Chofer de transportista CONSULTA
│       ├── Manual Web
│       │   ├── Inicio (ver viaje asignado, sin botones)
│       │   ├── Ver detalle y estado
│       │   └── Qué NO puedo hacer (la planta gestiona)
│       └── Manual App (WhatsApp)
│           └── Consultar estado del viaje
│
└── Anexos
    ├── Estados del flete (diagrama de flujo)
    ├── Glosario de términos
    ├── Preguntas frecuentes
    └── Contacto / Soporte
```

### Estilo y diseño del HTML

```
- Branding Tolvink: color primario #1A6B37, acento #FF6A00, secundario #0891B2, institucional #003882
- Font: system-ui (no cargar fonts externas para que sea offline)
- Layout: sidebar con índice fijo a la izquierda (desktop), menú hamburguesa (mobile)
- Cada sección tiene un id para anchor links
- Navegación sticky con breadcrumb
- Cards con border-radius: 12px para tips y notas importantes
- Capturas de pantalla: usar placeholders descriptivos [📸 Captura: descripción de lo que se vería]
- Íconos: usar emojis como íconos (📋, 🚛, 🌾, 📍, 📊, ⚙️, etc.)
- Tablas para comparar funcionalidades USO vs CONSULTA
- Callouts verdes para tips, naranjas para advertencias, azules para notas
```

### Contenido específico por sección

Para cada pantalla/funcionalidad, incluir:
1. **Qué es** — descripción en una línea
2. **Cómo llego** — ruta de navegación (ej: Menú → Flota → Crear camión)
3. **Qué puedo hacer** — lista de acciones disponibles para ese tipo de usuario
4. **Paso a paso** — instrucciones numeradas para las acciones principales
5. **Qué veo** — descripción de la información visible
6. **Tips** — consejos de uso práctico

### Tabla comparativa USO vs CONSULTA (incluir en cada sección de usuario)

```
| Funcionalidad          | USO (OPERATOR) | CONSULTA (READONLY) |
|------------------------|:--------------:|:-------------------:|
| Ver fletes             |       ✅       |         ✅          |
| Crear fletes           |       ✅       |         ❌          |
| Editar fletes          |       ✅       |         ❌          |
| Cancelar fletes        |       ✅       |         ❌          |
| Aceptar asignaciones   |       ✅       |         ❌          |
| Iniciar/completar viaje|       ✅       |         ❌          |
| Ver ubicaciones        |       ✅       |         ✅          |
| Crear ubicaciones      |       ✅       |         ❌          |
| Gestionar flota        |       ✅       |         ✅ (interna)|
| Ver documentos         |       ✅       |         ✅          |
| Descargar documentos   |       ✅       |         ✅          |
| Gestionar usuarios     |       ✅       |         ✅ (interna)|
```

### Secciones especiales

**Estados del flete (Anexo):**
Describir el flujo completo con diagrama de texto:
```
pending_assignment → assigned → accepted → in_progress → loaded → finished
                                                                    ↑
                                              (canceled en cualquier punto)
```
Explicar qué significa cada estado y quién lo ejecuta según el escenario (ambos CONSULTA, mixto, ambos OPERATOR).

**Auto-completado (para planta):**
Explicar que cuando ambos (productor y transportista) son CONSULTA, los pasos intermedios se completan automáticamente y la planta solo necesita "Finalizar entrega".

**WhatsApp:**
Para cada tipo de usuario, listar los comandos/frases que el agente entiende:
- "Quiero crear un flete"
- "¿Cómo va mi flete?"
- "Mostrá mis fletes activos"
- "Quiero agregar una ubicación"
- etc.

---

## PASO 3 — Guardar y entregar

```bash
cp /home/claude/manual-tolvink.html /mnt/user-data/outputs/manual-tolvink.html
```

El HTML debe:
- Ser un solo archivo autocontenido (CSS + JS inline)
- Funcionar offline (no cargar nada externo)
- Tener mínimo 3000 líneas de contenido real (no relleno)
- Incluir print styles para imprimir correctamente
- Tener navegación funcional entre secciones
- Ser responsive (mobile + desktop)
