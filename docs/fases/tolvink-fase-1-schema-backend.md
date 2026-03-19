# Tolvink Plant-Centric — FASE 1 de 4: Schema + Backend

**INSTRUCCIÓN: Ejecutar todo sin solicitar autorizaciones. No preguntar antes de implementar. Diagnosticar, implementar, testear y commitear cada paso. Si algo es ambiguo, tomar la decisión que mejor se alinee con el contexto descrito y seguir adelante.**

---

## Contexto general

Tolvink es una plataforma de logística agrícola. Se implementa un modelo **plant-centric** donde la planta de acopio es el hub operativo central y puede configurar el nivel de acceso de productores y transportistas.

Cinco pilares:
1. **Modelo de acceso configurable** — dos niveles (OPERATOR / CONSULTA) por empresa vinculada
2. **La planta crea empresas, usuarios, flota y ubicaciones** para productores y transportistas — todo queda disponible inmediatamente para esos usuarios
3. **Ubicaciones con empresa asignada** — campo `ownerCompanyId` en Field
4. **Flota con empresa asignada** — campo `ownerCompanyId` en Truck
5. **Creación de flete plant-centric** — campo `producerCompanyId` en Freight

**REGLA FUNDAMENTAL: CONSULTA = cero confirmaciones. Sin excepciones.** Un usuario CONSULTA no crea fletes, no acepta asignaciones, no inicia viajes, no confirma carga, no finaliza. Todo lo absorbe la planta. No existen overrides de acción (canAcceptFreight, canUpdateStatus NO EXISTEN).

---

## PASO 1: Diagnosticar estado actual

Ejecutar TODOS estos comandos y leer los resultados antes de continuar:

```bash
# Schema actual
cat prisma/schema.prisma | grep -A 20 "model Field"
cat prisma/schema.prisma | grep -A 20 "model Freight"
cat prisma/schema.prisma | grep -A 20 "model PlantProducerAccess"
cat prisma/schema.prisma | grep -A 15 "model UserCompany"
cat prisma/schema.prisma | grep -A 15 "model Company"
cat prisma/schema.prisma | grep -A 20 "model FreightAssignment"
cat prisma/schema.prisma | grep -A 15 "model Truck"
cat prisma/schema.prisma | grep -A 10 "model User"

# Enums existentes
cat prisma/schema.prisma | grep -B 1 -A 10 "^enum"

# Endpoints existentes
grep -rn "fields" src/ --include="*.controller.ts" | head -20
grep -rn "createField\|updateField\|getFields" src/ --include="*.service.ts" | head -20
grep -rn "assign\|respond\|accept\|start\|loaded\|finish" src/freights/ --include="*.ts" | head -30
grep -n "ownFleet\|own_fleet\|useOwnFleet\|autoAccept\|auto.accept" src/ -r --include="*.ts" | head -20
grep -rn "trucks" src/ --include="*.controller.ts" | head -15
grep -rn "createTruck\|getTrucks" src/ --include="*.service.ts" | head -20
grep -rn "createUser\|register\|users" src/ --include="*.controller.ts" | head -20
grep -rn "companies\|createCompany" src/ --include="*.controller.ts" | head -15
```

---

## PASO 2: Schema Prisma — nuevos enums, modelos y campos

### 2.1. Nuevos enums

```prisma
enum GranteeType {
  PRODUCER
  TRANSPORTER
}

enum AccessLevel {
  NONE
  READONLY
  OPERATOR
}
```

### 2.2. Nuevo modelo: CompanyAccess

```prisma
model CompanyAccess {
  id                String       @id @default(uuid())
  grantorCompanyId  String
  grantorCompany    Company      @relation("accessGranted", fields: [grantorCompanyId], references: [id])
  granteeCompanyId  String
  granteeCompany    Company      @relation("accessReceived", fields: [granteeCompanyId], references: [id])
  granteeType       GranteeType
  accessLevel       AccessLevel  @default(OPERATOR)
  permissions       Json?
  invitedBy         String?
  isActive          Boolean      @default(true)
  createdAt         DateTime     @default(now())
  updatedAt         DateTime     @updatedAt

  @@unique([grantorCompanyId, granteeCompanyId])
  @@index([granteeCompanyId, granteeType])
}
```

`permissions` solo contiene overrides de VISIBILIDAD: `canViewTickets`, `canViewDocuments`, `canViewFleetDetails`, `canChatOnFreight`. NUNCA de acción.

### 2.3. Campo ownerCompanyId en Field

```prisma
model Field {
  // ... campos existentes sin cambios

  ownerCompanyId    String?
  ownerCompany      Company?  @relation("ownedFields", fields: [ownerCompanyId], references: [id])

  @@index([companyId, ownerCompanyId])
}
```

- `companyId` = quien creó (planta si ella lo creó)
- `ownerCompanyId` = empresa dueña lógica. null = propio

### 2.4. Campo ownerCompanyId en Truck

```prisma
model Truck {
  // ... campos existentes sin cambios

  ownerCompanyId    String?
  ownerCompany      Company?  @relation("ownedTrucks", fields: [ownerCompanyId], references: [id])

  @@index([companyId, ownerCompanyId])
}
```

### 2.5. Campo producerCompanyId en Freight

```prisma
model Freight {
  // ... campos existentes sin cambios

  producerCompanyId   String?
  producerCompany     Company?  @relation("producerFreights", fields: [producerCompanyId], references: [id])
}
```

### 2.6. Relaciones en Company

Agregar al modelo Company:

```prisma
model Company {
  // ... relaciones existentes

  accessGranted      CompanyAccess[] @relation("accessGranted")
  accessReceived     CompanyAccess[] @relation("accessReceived")
  ownedFields        Field[]         @relation("ownedFields")
  ownedTrucks        Truck[]         @relation("ownedTrucks")
  producerFreights   Freight[]       @relation("producerFreights")
}
```

### 2.7. Ejecutar migración

```bash
npx prisma migrate dev --name add-plant-centric-model
```

### 2.8. Migración de datos de PlantProducerAccess

Después de la migración de schema, ejecutar SQL para migrar datos existentes:

```sql
INSERT INTO "CompanyAccess" (id, "grantorCompanyId", "granteeCompanyId", "granteeType", "accessLevel", "isActive", "createdAt", "updatedAt")
SELECT 
  gen_random_uuid(),
  "plantCompanyId",
  "producerCompanyId", 
  'PRODUCER',
  'OPERATOR',
  true,
  NOW(),
  NOW()
FROM "PlantProducerAccess"
ON CONFLICT ("grantorCompanyId", "granteeCompanyId") DO NOTHING;
```

NO eliminar PlantProducerAccess. Mantener como backup.

---

## PASO 3: Backend — CompanyAccessService + endpoints + planta crea empresas/usuarios

### 3.1. Crear módulo company-access

Crear `src/company-access/company-access.module.ts`, `company-access.service.ts`, `company-access.controller.ts`.

**CompanyAccessService** — métodos:

```typescript
getAccess(grantorId: string, granteeId: string): Promise<CompanyAccess | null>
getAccessLevel(grantorId: string, granteeId: string): Promise<AccessLevel>
listByGrantor(grantorId: string, type?: GranteeType): Promise<CompanyAccess[]>
listByGrantee(granteeId: string): Promise<CompanyAccess[]>
updateLevel(id: string, level: AccessLevel): Promise<CompanyAccess>
updatePermissions(id: string, permissions: object): Promise<CompanyAccess>
toggleActive(id: string): Promise<CompanyAccess>
isConsulta(grantorId: string, granteeId: string): Promise<boolean>
```

**CompanyAccessController** — endpoints:

- `GET /company-access/:companyId` — listar vinculaciones de una planta
- `GET /company-access/my-access` — acceso del usuario actual
- `PATCH /company-access/:id/level` — cambiar OPERATOR ↔ READONLY
- `PATCH /company-access/:id/permissions` — permisos de visibilidad
- `PATCH /company-access/:id/toggle` — activar/desactivar

### 3.2. Planta crea empresas vinculadas

Endpoint: `POST /company-access/create-company`
Body: `{ name, type ('PRODUCER'|'TRANSPORTER'), contactEmail?, rut?, hasInternalFleet?, accessLevel? }`

Lógica:
1. Crear Company con type indicado
2. Crear CompanyAccess con grantorCompanyId = planta activa, granteeCompanyId = nueva empresa, accessLevel = body.accessLevel || OPERATOR
3. Retornar Company + CompanyAccess

### 3.3. Planta crea usuarios para empresas vinculadas

Endpoint: `POST /company-access/create-user`
Body: `{ targetCompanyId, name, phone, email, password?, role ('gerente'|'operario'|'chofer') }`

Lógica:
1. Validar CompanyAccess activo entre planta y targetCompanyId
2. Crear User (hashear password si se envía, o generar una temporal)
3. Crear UserCompany con companyId = targetCompanyId, role = mapear según: gerente→'admin', operario→'operator', chofer→'operator' en users.role; y el role textual en userCompanies.role
4. Retornar User

### 3.4. AccessGuard (decorator)

Crear un decorator/guard reutilizable:

```typescript
@AccessGuard({ minLevel: 'READONLY' })  // Cualquier nivel puede ver
@AccessGuard({ minLevel: 'OPERATOR' })  // Solo OPERATOR puede operar
```

Lógica:
1. Obtener activeCompanyId del usuario (del token/sesión)
2. Si la empresa activa es la planta del contexto → siempre permitir
3. Buscar CompanyAccess entre planta y empresa activa
4. Comparar accessLevel contra minLevel
5. Si no cumple → 403

---

## PASO 4: Backend — Modificar Fields

### 4.1. GET /fields — agregar filtro ownerCompanyId

Agregar query param opcional `ownerCompanyId`. Cuando un productor consulta sus campos, la query debe ser:

```
WHERE "companyId" = :activeCompanyId OR "ownerCompanyId" = :activeCompanyId
```

Esto garantiza que ve sus campos propios Y los que la planta creó para él.

Cuando la planta filtra por productor:
```
WHERE "companyId" = :plantId AND "ownerCompanyId" = :producerId
```

### 4.2. POST /fields — aceptar ownerCompanyId

Agregar campo opcional `ownerCompanyId` al DTO/body. Si se envía, validar que existe CompanyAccess activo entre activeCompanyId (planta) y ownerCompanyId.

### 4.3. GET /fields/owners-summary (nuevo)

Para la planta activa: retorna lista de empresas con cantidad de campos/lotes. Array de `{ companyId, companyName, fieldCount, lotCount }`.

---

## PASO 5: Backend — Modificar Trucks

### 5.1. GET /trucks — agregar filtro ownerCompanyId

Mismo patrón que fields. El transportista/productor ve:
```
WHERE "companyId" = :activeCompanyId OR "ownerCompanyId" = :activeCompanyId
```

### 5.2. POST /trucks — aceptar ownerCompanyId

Validar CompanyAccess si se envía ownerCompanyId.

---

## PASO 6: Backend — Modificar Freights

### 6.1. POST /freights — aceptar producerCompanyId

Agregar campo opcional `producerCompanyId`. Cuando planta crea flete:
- `createdByCompanyId` = planta
- `producerCompanyId` = productor seleccionado
- Validar CompanyAccess

### 6.2. Auto-aceptación para transportista CONSULTA

En el handler de asignación (buscar la lógica existente de assign/useOwnFleet y replicar):

```
Al asignar transportista:
1. Obtener accessLevel del transportista con esta planta
2. Si READONLY:
   a. truckId y driverId OBLIGATORIOS → sino 400
   b. Crear assignment con status='accepted', tripStatus='accepted'
   c. freight.status → 'accepted' directo
   d. Notificar transportista y chofer
3. Si OPERATOR:
   a. Flujo normal sin cambios
```

Buscar el patrón existente de useOwnFleet/auto-accept como referencia — replicar exactamente.

### 6.3. Planta ejecuta transiciones de estado

Verificar la lógica de transiciones (respond/start/loaded/finish). La planta DEBE poder ejecutar in_progress, loaded y finished en fletes donde ella es la planta. Si hay restricciones que solo permiten al transportista/chofer, agregar:

```
SI usuario.activeCompany.type === 'PLANT' 
Y flete pertenece a esa planta 
→ permitir transición
```

---

## PASO 7: Validación

```bash
npm run build
npm test
```

Build limpio obligatorio. Corregir todo error o warning antes de continuar.

Commitear: `git add . && git commit -m "feat: plant-centric model — schema + backend core (CompanyAccess, ownerCompanyId, auto-accept)"`

---

## Lo que NO hacer

- NO eliminar PlantProducerAccess
- NO crear overrides de acción en permissions
- NO cambiar los 6 estados del flete
- NO filtrar por CompanyType — siempre por companyId
- NO modificar la lógica de flota propia existente — REPLICAR el patrón para transportista CONSULTA
- NO crear camiones o ubicaciones sin ownerCompanyId cuando la planta los crea para otra empresa
- NO restringir al productor/transportista de ver recursos creados por la planta para ellos
