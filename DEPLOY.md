# TOLVINK BACKEND — Deploy a Producción
# Fase 1: Deploy · Fase 2: Validación · Fase 3: Frontend

═══════════════════════════════════════════════════════
BLOQUEANTES RESUELTOS ANTES DEL DEPLOY
═══════════════════════════════════════════════════════

1. AuthModule usaba process.env directo → Cambiado a ConfigModule async
   (Railway inyecta env vars después de la carga de módulos)

2. Faltaba @nestjs/config → Agregado como dependencia

3. Faltaba health endpoint → Creado /api/health para Railway health check

4. app.listen sin '0.0.0.0' → Railway requiere binding a 0.0.0.0

5. build script sin prisma generate → Agregado en build y postinstall

6. @@unique en schema conflictuaba con partial index → Removido,
   el partial index se aplica vía constraints.sql

═══════════════════════════════════════════════════════
FASE 1 — DEPLOY BACKEND
═══════════════════════════════════════════════════════

────────────────────────────────────────────────────
PASO 1.1 — Crear base de datos en Supabase
────────────────────────────────────────────────────

1. Ir a: https://supabase.com
2. Sign up con GitHub (gratis)
3. Click "New Project"
4. Configurar:
   - Name: tolvink
   - Database Password: generá uno seguro (GUARDALO)
   - Region: South America (São Paulo) — el más cercano a Uruguay
5. Esperar ~2 minutos que se cree
6. Ir a: Settings → Database → Connection string
7. Copiar la URI de conexión (la que dice "URI")
   Ejemplo: postgresql://postgres.[id]:[password]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
8. IMPORTANTE: Reemplazar [YOUR-PASSWORD] con la password que elegiste

Guardar esta URL. Es tu DATABASE_URL.

────────────────────────────────────────────────────
PASO 1.2 — Subir backend a GitHub
────────────────────────────────────────────────────

En tu terminal:

  cd tolvink-api
  git init
  git add .
  git commit -m "Tolvink API v1.0"

Crear repo en GitHub (https://github.com/new):
  - Name: tolvink-api
  - Private (recomendado)

  git remote add origin https://github.com/juaneastman13/tolvink-api.git
  git branch -M main
  git push -u origin main

────────────────────────────────────────────────────
PASO 1.3 — Crear proyecto en Railway
────────────────────────────────────────────────────

1. Ir a: https://railway.app
2. Sign up con GitHub
3. Click "New Project"
4. Elegir "Deploy from GitHub repo"
5. Seleccionar "tolvink-api"
6. Railway detecta Node.js automáticamente

────────────────────────────────────────────────────
PASO 1.4 — Configurar variables de entorno
────────────────────────────────────────────────────

En Railway → tu proyecto → Variables:
Agregar UNA POR UNA:

  DATABASE_URL = postgresql://postgres.[id]:[password]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
  JWT_SECRET = (generar con: openssl rand -hex 32)
  JWT_EXPIRES_IN = 24h
  NODE_ENV = production
  CORS_ORIGIN = https://tolvink.vercel.app
  ENABLE_SWAGGER = true
  PORT = 4000

IMPORTANTE sobre DATABASE_URL:
- Agregar ?pgbouncer=true al final si usás Supabase pooler
- Si Supabase te da dos URLs (pooler y directa), usá la directa
  para migraciones y la pooler para la app

────────────────────────────────────────────────────
PASO 1.5 — Configurar Build & Start
────────────────────────────────────────────────────

En Railway → Settings:

  Build Command:  npm install && npm run build
  Start Command:  npx prisma migrate deploy && node dist/main.js

Esto hace que CADA deploy:
1. Instale dependencias
2. Genere Prisma client + compile TypeScript
3. Ejecute migraciones pendientes
4. Arranque el servidor

────────────────────────────────────────────────────
PASO 1.6 — Primera migración
────────────────────────────────────────────────────

ANTES del primer deploy, en tu computadora local:

  cd tolvink-api
  npm install

Crear el archivo .env local:
  DATABASE_URL=postgresql://postgres.[id]:[password]@aws-0-sa-east-1.pooler.supabase.com:6543/postgres
  JWT_SECRET=local-dev-secret

Ejecutar:
  npx prisma migrate dev --name init

Esto crea la carpeta prisma/migrations/ con el SQL.
Commitear y pushear:

  git add .
  git commit -m "Initial migration"
  git push

Railway redeploya automáticamente.

────────────────────────────────────────────────────
PASO 1.7 — Aplicar constraints adicionales
────────────────────────────────────────────────────

Los constraints de constraints.sql no se aplican con Prisma migrate.
Ejecutarlos manualmente en Supabase:

1. Ir a Supabase → SQL Editor
2. Pegar el contenido de prisma/constraints.sql
3. Ejecutar

Esto crea:
- Partial unique index (una asignación activa por flete)
- CHECK en cancel_reason
- CHECK en assignment reason
- CHECK en freight code format

────────────────────────────────────────────────────
PASO 1.8 — Seed (datos iniciales)
────────────────────────────────────────────────────

Desde tu computadora local:

  npx prisma db seed

Esto crea las empresas demo, usuarios y un flete de ejemplo.

────────────────────────────────────────────────────
PASO 1.9 — Verificar deploy
────────────────────────────────────────────────────

Railway te da una URL tipo: https://tolvink-api-production.up.railway.app

Verificar:

  1. Health: GET https://[tu-url]/api/health
     Esperar: { "status": "ok", "db": "connected" }

  2. Swagger: https://[tu-url]/docs
     Esperar: Documentación interactiva

  3. Login:
     POST https://[tu-url]/api/auth/login
     Body: { "email": "carolina@planta.com", "password": "1234" }
     Esperar: { "access_token": "...", "user": {...} }

Si los 3 funcionan → FASE 1 COMPLETADA.

────────────────────────────────────────────────────
CHECKLIST PRE-ESTABLE
────────────────────────────────────────────────────

[ ] Health endpoint devuelve db: connected
[ ] Swagger carga correctamente
[ ] Login funciona con usuario seed
[ ] JWT_SECRET es random de 64+ chars (NO el default)
[ ] DATABASE_URL apunta a Supabase producción
[ ] CORS_ORIGIN tiene la URL exacta del frontend
[ ] NODE_ENV = production
[ ] Railway logs no muestran errores
[ ] constraints.sql ejecutado en Supabase


═══════════════════════════════════════════════════════
FASE 2 — VALIDACIÓN FUNCIONAL COMPLETA
═══════════════════════════════════════════════════════

Usar Swagger (/docs) o curl/Postman. Base URL: https://[tu-url]/api

────────────────────────────────────────────────────
TEST 1 — Register + Login
────────────────────────────────────────────────────

A. Registrar productor:
POST /auth/register
{
  "name": "Test Productor",
  "email": "test-prod@test.com",
  "password": "test1234",
  "companyType": "producer",
  "companyName": "Agro Test"
}
→ Esperar 201 con access_token
→ Guardar token como TOKEN_PROD

B. Registrar planta:
POST /auth/register
{
  "name": "Test Planta",
  "email": "test-plant@test.com",
  "password": "test1234",
  "companyType": "plant",
  "companyName": "Planta Test"
}
→ Guardar token como TOKEN_PLANT

C. Registrar transportista:
POST /auth/register
{
  "name": "Test Transp",
  "email": "test-transp@test.com",
  "password": "test1234",
  "companyType": "transporter",
  "companyName": "Transp Test"
}
→ Guardar token como TOKEN_TRANSP
→ Guardar company.id como TRANSP_COMPANY_ID

D. Login con usuario existente:
POST /auth/login
{ "email": "test-prod@test.com", "password": "test1234" }
→ Esperar 200 con token

E. Login con password incorrecto:
POST /auth/login
{ "email": "test-prod@test.com", "password": "wrong" }
→ Esperar 401

────────────────────────────────────────────────────
TEST 2 — Crear datos auxiliares
────────────────────────────────────────────────────

Necesitás IDs de lot y plant. Usar los del seed o crear vía Supabase SQL:

INSERT INTO lots (name, company_id, lat, lng)
VALUES ('Lote Test', '[PRODUCER_COMPANY_ID]', -34.0, -56.0)
RETURNING id;

INSERT INTO plants (name, company_id, lat, lng)
VALUES ('Planta Test', '[PLANT_COMPANY_ID]', -34.3, -56.5)
RETURNING id;

Guardar LOT_ID y PLANT_ID.

────────────────────────────────────────────────────
TEST 3 — Crear flete (Productor)
────────────────────────────────────────────────────

POST /freights (Authorization: Bearer TOKEN_PROD)
{
  "originLotId": "LOT_ID",
  "destPlantId": "PLANT_ID",
  "loadDate": "2026-03-01",
  "loadTime": "08:00",
  "items": [{ "grain": "Soja", "tons": 30 }],
  "notes": "Test freight"
}
→ Esperar 201 con status: pending_assignment
→ Guardar id como FREIGHT_ID

────────────────────────────────────────────────────
TEST 4 — Asignar transportista (Planta)
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/assign (Bearer TOKEN_PLANT)
{ "transportCompanyId": "TRANSP_COMPANY_ID" }
→ Esperar 200/201 con status: assigned

────────────────────────────────────────────────────
TEST 5 — Rechazar con motivo (Transportista)
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/respond (Bearer TOKEN_TRANSP)
{ "action": "rejected", "reason": "Sin disponibilidad de camiones" }
→ Esperar 200 con status: pending_assignment

TEST 5b — Rechazar SIN motivo (debe fallar):
POST /freights/FREIGHT_ID/respond (Bearer TOKEN_TRANSP)
{ "action": "rejected" }
→ Esperar 400

────────────────────────────────────────────────────
TEST 6 — Reasignar (Planta)
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/assign (Bearer TOKEN_PLANT)
{ "transportCompanyId": "TRANSP_COMPANY_ID" }
→ Esperar status: assigned (nueva asignación)

────────────────────────────────────────────────────
TEST 7 — Aceptar (Transportista)
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/respond (Bearer TOKEN_TRANSP)
{ "action": "accepted" }
→ Esperar status: accepted

────────────────────────────────────────────────────
TEST 8 — Iniciar viaje
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/start (Bearer TOKEN_TRANSP)
→ Esperar status: in_progress

────────────────────────────────────────────────────
TEST 9 — Intentar cancelar en in_progress (DEBE FALLAR)
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/cancel (Bearer TOKEN_PROD)
{ "reason": "Ya no necesito" }
→ Esperar 400: "No se puede cancelar un flete en curso"

────────────────────────────────────────────────────
TEST 10 — Finalizar
────────────────────────────────────────────────────

POST /freights/FREIGHT_ID/finish (Bearer TOKEN_TRANSP)
→ Esperar status: finished

────────────────────────────────────────────────────
TEST 11 — Multi-tenant
────────────────────────────────────────────────────

A. Crear otro productor (empresa diferente):
POST /auth/register
{ "name": "Otro", "email": "otro@test.com", "password": "1234",
  "companyType": "producer", "companyName": "Otra Empresa" }

B. Intentar ver el flete del primer productor:
GET /freights/FREIGHT_ID (Bearer TOKEN_OTRO)
→ Esperar 403: "Tu empresa no participa en este flete"

C. Listar fletes:
GET /freights (Bearer TOKEN_OTRO)
→ Esperar lista vacía (0 resultados)

────────────────────────────────────────────────────
TEST 12 — Cancelar flete nuevo (estado válido)
────────────────────────────────────────────────────

Crear otro flete (test 3) y cancelar:
POST /freights/NEW_ID/cancel (Bearer TOKEN_PROD)
{ "reason": "Cambio de planes" }
→ Esperar status: canceled

Cancelar SIN motivo (debe fallar):
POST /freights/NEW_ID/cancel
{ "reason": "" }
→ Esperar 400

────────────────────────────────────────────────────
VALIDACIONES TÉCNICAS
────────────────────────────────────────────────────

[ ] Login devuelve JWT válido
[ ] JWT expira (probar con token viejo después de cambiar exp a 5s)
[ ] 401 sin token
[ ] 401 con token inválido
[ ] 403 multi-tenant (no ver fletes de otra empresa)
[ ] 400 en transición inválida (ej: finished → assigned)
[ ] 400 si falta motivo en rechazo
[ ] 400 si falta motivo en cancelación
[ ] No se puede cancelar in_progress
[ ] Partial unique: intentar doble asignación activa → error DB
[ ] CHECK: intentar cancelar freight sin reason directo en DB → error
[ ] Audit log tiene registro de cada transición


═══════════════════════════════════════════════════════
FASE 3 — PREPARACIÓN PARA FRONTEND
═══════════════════════════════════════════════════════

Solo después de que TODOS los tests de Fase 2 pasen.

────────────────────────────────────────────────────
3.1 — Base URL por entorno
────────────────────────────────────────────────────

En el frontend (React), crear:

  // src/config.js
  const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
  export default API_URL;

En .env.local (desarrollo):
  VITE_API_URL=http://localhost:4000/api

En Vercel (producción), agregar variable de entorno:
  VITE_API_URL=https://tolvink-api-production.up.railway.app/api

────────────────────────────────────────────────────
3.2 — Manejo de JWT en frontend
────────────────────────────────────────────────────

  // Guardar en memoria (NO localStorage para máxima seguridad)
  // En MVP es aceptable usar localStorage
  let token = null;

  function setToken(t) { token = t; localStorage.setItem('token', t); }
  function getToken() { return token || localStorage.getItem('token'); }
  function clearToken() { token = null; localStorage.removeItem('token'); }

────────────────────────────────────────────────────
3.3 — API Client (fetch wrapper)
────────────────────────────────────────────────────

  // src/api.js
  import API_URL from './config';

  async function api(path, options = {}) {
    const token = getToken();
    const res = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401) {
      clearToken();
      window.location.href = '/'; // Redirigir a login
      throw new Error('Sesión expirada');
    }

    const data = await res.json();

    if (!res.ok) {
      throw { status: res.status, message: data.error, details: data.details };
    }

    return data;
  }

  // Uso:
  // const { access_token, user } = await api('/auth/login', { method: 'POST', body: { email, password } });
  // const freights = await api('/freights');
  // await api('/freights/123/assign', { method: 'POST', body: { transportCompanyId: '...' } });

────────────────────────────────────────────────────
3.4 — Manejo de errores por status
────────────────────────────────────────────────────

  400 → Mostrar error.message al usuario (validación/regla de negocio)
  401 → Redirigir a login (token expirado o inválido)
  403 → Mostrar "Sin permisos" (multi-tenant o rol incorrecto)
  404 → Mostrar "No encontrado"
  409 → Mostrar "Email ya registrado" (conflicto)
  422 → Mostrar error.details por campo (validación DTO)
  500 → Mostrar "Error del servidor, intentá de nuevo"

────────────────────────────────────────────────────
3.5 — Estados del flete en UI
────────────────────────────────────────────────────

  const STATUS_CONFIG = {
    draft:              { label: 'Borrador',       color: '#71717A', actions: ['submit'] },
    pending_assignment: { label: 'Disponible',     color: '#1A6B37', actions: ['assign', 'cancel'] },
    assigned:           { label: 'Asignado',       color: '#2563EB', actions: ['respond', 'cancel'] },
    accepted:           { label: 'Aceptado',       color: '#7C3AED', actions: ['start', 'cancel'] },
    in_progress:        { label: 'En curso',       color: '#E07A12', actions: ['finish'] },
    finished:           { label: 'Finalizado',     color: '#1A6B37', actions: [] },
    canceled:           { label: 'Cancelado',      color: '#DC2626', actions: [] },
  };

  // Para mostrar acciones: filtrar por rol del usuario y estado actual
  // Para mostrar badge: usar color del estado
  // Para progress bar: mapear a posición en la secuencia

────────────────────────────────────────────────────
3.6 — Orden de implementación frontend
────────────────────────────────────────────────────

1. Reemplazar login mock → POST /auth/login real
2. Guardar token → setToken(response.access_token)
3. Reemplazar lista de fletes mock → GET /freights
4. Reemplazar detalle mock → GET /freights/:id
5. Reemplazar crear flete mock → POST /freights
6. Conectar acciones (assign, respond, start, finish, cancel)
7. Conectar chat → POST/GET /freights/:id/messages (pendiente backend)
