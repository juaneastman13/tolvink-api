# TOLVINK — STAGING ENVIRONMENT ROADMAP

**Generado:** 2026-04-23
**Ámbito:** Setup completo de un ambiente staging paralelo a producción, con aislamiento total de datos y servicios.

---

## 1. RESUMEN EJECUTIVO

### Qué se va a crear

Un ambiente **staging** completamente paralelo al de producción (`main`/`prod`):

- **Backend:** proyecto Railway nuevo (`tolvink-api-staging`) que corre el mismo código del repo `tolvink-api`, branch `staging`.
- **Frontend:** deploy de Vercel nuevo en subdominio `staging.tolvink.com`, que apunta al backend staging.
- **Base de datos:** proyecto Supabase nuevo separado (Free tier) — DB + Storage aislados.
- **Secrets propios** para JWT, WhatsApp (vacíos), AI keys (se pueden reusar prod o crear nuevas).

### Por qué

1. Testear cambios (UI, schema, agente WhatsApp, flujos críticos) sin riesgo de contaminar datos productivos.
2. Probar migraciones Prisma en un entorno idéntico antes de aplicarlas en prod.
3. Dar feedback rápido al equipo (link compartible `staging.tolvink.com`) sin pisar la app real.
4. Aislar cualquier experimento de IA (nuevo prompt, nuevo tool) de los usuarios reales.

### Qué queda completamente aislado de producción

| Recurso | Aislamiento |
|---|---|
| Base de datos (Postgres) | Proyecto Supabase separado |
| Supabase Storage (bucket `freight-docs`) | Proyecto Supabase separado |
| JWT secret | Propio de staging |
| Backend process (Railway) | Proyecto Railway separado |
| Frontend (Vercel) | Deploy separado, branch `staging` |
| Dominio | `staging.tolvink.com` vs `tolvink.com` |
| Datos productivos | Cero — solo datos seeded |

### Qué **NO** queda aislado (decisión explícita)

- **WhatsApp Meta Cloud API:** el webhook sigue apuntando al backend de producción. Staging no recibe mensajes reales. Los flujos de WhatsApp se testean con payloads mockeados via `curl` al webhook staging.
- **Google Maps / Gemini / OpenAI keys:** se pueden reusar las mismas keys (cuentan contra la misma quota). Si preferís quota separada, creás keys nuevas.

---

## 2. INVENTARIO DE SERVICIOS EXTERNOS

| # | Servicio | Uso actual | Requiere instancia separada | Tipo de acción |
|---|---|---|---|---|
| 1 | **Supabase (DB)** | Postgres productivo, project ref `mlmecljidioymujsazrs` | SÍ — proyecto separado | MANUAL — crear proyecto Free |
| 2 | **Supabase (Storage)** | Bucket `freight-docs` para archivos WhatsApp | SÍ — viene con el proyecto nuevo | MANUAL — crear bucket en el proyecto staging |
| 3 | **Railway** | Backend prod `tolvink-api-production.up.railway.app` | SÍ — proyecto separado | MANUAL — nuevo proyecto Railway |
| 4 | **Vercel** | Frontend prod `tolvink.com` | SÍ — deploy separado (mismo proyecto, distinta branch) | MANUAL — configurar env por branch |
| 5 | **WhatsApp Meta Cloud API** | Webhook apunta a `tolvink-api-production` | NO — se mantiene en prod | NINGUNA |
| 6 | **Google Gemini** | IA principal, key `AIzaSyDB...` | OPCIONAL — se puede reusar | OPCIONAL — key nueva |
| 7 | **OpenAI (Whisper)** | Transcripción de audios | OPCIONAL — se puede reusar | OPCIONAL — key nueva |
| 8 | **Google Maps** | Frontend (`VITE_GMAPS_KEY`) + Backend Directions | OPCIONAL — se puede reusar | OPCIONAL — restringir key staging al dominio staging |
| 9 | **Sentry** | Error tracking prod | SÍ — project separado recomendado | MANUAL — nuevo project Sentry |
| 10 | **LangSmith** | Tracing opcional (no activo hoy) | OPCIONAL | NINGUNA |
| 11 | **Serper API** | Búsqueda opcional (no crítica) | OPCIONAL | NINGUNA |
| 12 | **Web Push (VAPID)** | Notificaciones push | SÍ — keys separadas | CLAUDE (genera con `npx web-push generate-vapid-keys`) |
| 13 | **DNS (registrador del dominio tolvink.com)** | Apex `tolvink.com` apunta a Vercel prod | SÍ — subdominio `staging` | MANUAL — crear CNAME |

---

## 3. ROADMAP DE IMPLEMENTACIÓN

### FASE 1 — Infraestructura externa (ACCIÓN MANUAL DE JUAN)

Todo lo que requiere clicks en dashboards externos. Claude NO puede ejecutar esto.

#### 1.1 Branch `staging` en los 2 repos

Hay que crear una branch `staging` tanto en el repo del frontend (`Tolvink`) como en el del backend (`tolvink-api`) para que Vercel y Railway puedan apuntar a una branch estable distinta de `main`.

- **Frontend:** `git checkout -b staging && git push -u origin staging`
- **Backend:** idem

#### 1.2 Crear proyecto Supabase de staging

- URL: https://supabase.com/dashboard
- Crear un nuevo Project en la misma organización (Free tier permite hasta 2 proyectos).
- Nombre sugerido: `tolvink-staging`
- Región: la misma que prod (`aws-1-sa-east-1`) para latencia coherente.
- Plan: Free.
- Anotar: `Project Ref`, `DB password`, `URL del proyecto`.

#### 1.3 Crear bucket `freight-docs` en staging

Dentro del proyecto Supabase staging:
- Storage → Create bucket → nombre: `freight-docs`, público o privado según cómo esté hoy en prod (verificar y replicar).

#### 1.4 Crear proyecto Railway de staging

- URL: https://railway.app
- New Project → Deploy from GitHub → seleccionar `tolvink-api`, branch `staging`.
- Desactivar autodeploy si querés tener control manual.
- Anotar: URL pública del deploy (p. ej. `tolvink-api-staging.up.railway.app`).

**Minimizar costo:**
- Plan Hobby ($5/mes incluye $5 de credit). Servicio 24/7 con poco tráfico consume ~$3-5/mes → queda dentro del credit incluido.
- Si querés costo real $0: apagar el servicio cuando no testeás (Railway → service → Settings → "Remove" o Pause). El URL se mantiene al volver a deployar.
- No activar autodeploy para evitar consumir credit en rebuilds innecesarios.

#### 1.5 Configurar Vercel para staging

Vercel ya tiene el proyecto del frontend. El enfoque más limpio:
- Ir al proyecto `Tolvink` en Vercel.
- Settings → Domains → agregar `staging.tolvink.com`, asignarlo a la branch `staging`.
- Settings → Environment Variables → Preview/Production → agregar variables específicas para `staging` (usando el filtro "Branch" en Vercel cuando sea posible).

#### 1.6 DNS `staging.tolvink.com`

- En el registrador del dominio `tolvink.com` (GoDaddy, Namecheap, Cloudflare, lo que sea).
- Agregar un registro **CNAME**: `staging` → `cname.vercel-dns.com` (Vercel te dice el valor exacto al agregar el dominio).

#### 1.7 Crear project Sentry de staging (opcional pero recomendado)

- URL: https://sentry.io
- Nuevo project → Node.js (backend) y React (frontend).
- Anotar los 2 `DSN`.

---

### FASE 2 — Configuración de archivos (CLAUDE EJECUTA)

Cambios en el código base, sin tocar archivos de producción existentes.

#### 2.1 Resolver hardcodeos de URL (bloqueantes reales)

**Backend — `src/main.ts:75`:**
Reemplazar el CSP `connectSrc` hardcodeado con Supabase prod por una variable configurable:

```ts
// Antes:
connectSrc: ["'self'", 'https://mlmecljidioymujsazrs.supabase.co', 'https://maps.googleapis.com', 'https://graph.facebook.com'],

// Después:
const supabaseHost = process.env.SUPABASE_URL || 'https://mlmecljidioymujsazrs.supabase.co';
connectSrc: ["'self'", supabaseHost, 'https://maps.googleapis.com', 'https://graph.facebook.com'],
```

**Frontend — `vercel.json:17`:**
Vercel no expande env vars en `vercel.json`. El CSP productivo tiene `https://tolvink-api-production.up.railway.app` hardcodeado en `connect-src`. Opción pragmática:

- Dejar ambas URLs permitidas en el CSP (`tolvink-api-production.up.railway.app` **y** `tolvink-api-staging.up.railway.app`). Así un solo `vercel.json` sirve a los 2 deploys.

#### 2.2 Crear `.env.staging` (backend)

En `tolvink/tolvink-api/tolvink-api/.env.staging`, sin tocar el `.env` de producción. Contenido detallado en **FASE 4**.

#### 2.3 Crear `.env.staging.local` (frontend)

En `tolvink-deploy/.env.staging.local`, sin tocar el `.env` de producción. Contenido detallado en **FASE 4**.

#### 2.4 Scripts npm en `tolvink-api/package.json`

Agregar sin modificar los existentes:

```json
"start:staging":   "dotenv -e .env.staging -- node dist/main.js",
"dev:staging":     "dotenv -e .env.staging -- nest start --watch",
"migrate:staging": "dotenv -e .env.staging -- npx prisma migrate deploy",
"seed:staging":    "dotenv -e .env.staging -- npx ts-node prisma/seed.staging.ts",
"studio:staging":  "dotenv -e .env.staging -- npx prisma studio"
```

Requiere agregar `dotenv-cli` como devDependency: `npm i -D dotenv-cli`.

#### 2.5 Script npm en `tolvink-deploy/package.json`

```json
"dev:staging":   "vite --mode staging",
"build:staging": "vite build --mode staging"
```

Vite lee automáticamente `.env.staging.local` / `.env.staging` cuando el modo es `staging`. No hace falta `dotenv-cli`.

#### 2.6 Seed de staging — `prisma/seed.staging.ts`

Nuevo archivo separado de `seed.ts`. Debe:
- Crear al menos 1 Producer, 1 Plant, 1 Transporter (con `hasInternalFleet: true` en uno).
- Crear usuarios para cada empresa (manager + operator + driver).
- Crear campos, lotes, camiones, choferes.
- Crear accesos cruzados (PlantProducerAccess con USO y CONSULTA).
- Crear un par de fletes en distintos estados (`pending_assignment`, `in_progress`, `finished`).
- Crear un flete autónomo si hay autonomousDriverEnabled.
- Datos ficticios pero realistas (nombres uruguayos: "Est. Los Ceibos", "Cooperativa del Sur", "Transportes Artigas", etc.).
- Un usuario `platform_admin` con password conocido para entrar rápido.

**Cero datos productivos reales.**

#### 2.7 Actualizar `.gitignore` si hace falta

El `.gitignore` de backend ya ignora `.env.*` excepto `.env.example`, así que `.env.staging` queda fuera del repo automáticamente ✓.
Frontend ignora `.env` pero no `.env.staging.local` — agregar explícitamente.

---

### FASE 3 — Base de datos staging

Ejecutar en orden:

1. **Verificación previa:** imprimir `echo $DATABASE_URL` con el `.env.staging` cargado. Debe mostrar el URL del proyecto Supabase staging (NO prod).
2. `npm run migrate:staging` → aplica las 34 migraciones a la DB staging.
3. `npm run seed:staging` → popula con datos ficticios.
4. Verificación: abrir `npm run studio:staging` y confirmar que las tablas `Company`, `User`, `Freight` tienen los registros seed (y **ninguno** de prod).

Si cualquier paso falla con error de credenciales, conexión, o muestra que el DATABASE_URL apunta a producción → **STOP inmediato** y reporto el error completo.

---

### FASE 4 — Variables de entorno

#### 4.1 Estructura completa de `.env.staging` (backend)

```bash
# ──────────── SERVER ────────────
PORT=4000
NODE_ENV=staging

# ──────────── DATABASE ────────────
# Valor: Supabase staging project (dashboard → Settings → Database → Connection string)
DATABASE_URL=postgresql://postgres.<STAGING_REF>:<STAGING_PASSWORD>@aws-1-sa-east-1.pooler.supabase.com:5432/postgres
DIRECT_URL=postgresql://postgres:<STAGING_PASSWORD>@db.<STAGING_REF>.supabase.co:5432/postgres

# ──────────── JWT ────────────
# Nuevo secret para staging (generar con: openssl rand -hex 32)
JWT_SECRET=<GENERAR_NUEVO_64_CHARS>
JWT_EXPIRES_IN=24h

# ──────────── CORS ────────────
CORS_ORIGIN=https://staging.tolvink.com,http://localhost:3000
FRONTEND_URL=https://staging.tolvink.com

# ──────────── SUPABASE ────────────
# Valor: dashboard del proyecto staging → Settings → API
SUPABASE_URL=https://<STAGING_REF>.supabase.co
SUPABASE_SERVICE_KEY=<STAGING_SERVICE_ROLE_KEY>

# ──────────── AI (Gemini) ────────────
# Se puede reusar la key de prod o crear una nueva
AI_PROVIDER=gemini
GEMINI_MODEL=gemini-2.5-pro
GEMINI_API_KEY=<KEY_DE_STAGING_O_LA_MISMA_DE_PROD>

# ──────────── OpenAI Whisper ────────────
# Opcional. Si se deja vacío, el módulo de audio queda desactivado en staging.
OPENAI_API_KEY=

# ──────────── WhatsApp Meta Cloud ────────────
# Se dejan VACÍOS a propósito. Staging no recibe webhooks reales.
# El webhook de Meta sigue apuntando al backend de producción.
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=

# ──────────── Web Push ────────────
# Generar con: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=<GENERAR>
VAPID_PRIVATE_KEY=<GENERAR>
VAPID_SUBJECT=mailto:staging@tolvink.com

# ──────────── Sentry (backend) ────────────
# Del project Sentry staging
SENTRY_DSN=<DSN_SENTRY_STAGING>
SENTRY_TRACES_RATE=0.5

# ──────────── Internal API key ────────────
# Generar nuevo, distinto de prod
INTERNAL_API_KEY=<GENERAR_32_CHARS>
```

#### 4.2 Estructura completa de `.env.staging.local` (frontend)

```bash
# Backend staging
VITE_API_URL=https://tolvink-api-staging.up.railway.app/api

# Dominio frontend staging
VITE_FRONTEND_URL=https://staging.tolvink.com

# Google Maps (misma o nueva key; si es nueva, restringirla al dominio staging)
VITE_GMAPS_KEY=<KEY>

# Sentry (frontend staging, distinto project de prod)
VITE_SENTRY_DSN=<DSN_SENTRY_FRONT_STAGING>

# Supabase staging (si el frontend usa anon key, p. ej. Storage público)
VITE_SUPABASE_URL=https://<STAGING_REF>.supabase.co
VITE_SUPABASE_ANON_KEY=<STAGING_ANON_KEY>

# Web Push VAPID public
VITE_VAPID_PUBLIC_KEY=<MISMO_PUBLIC_KEY_DE_BACKEND_STAGING>

# Debug
VITE_DEBUG=true
```

#### 4.3 Variables en Railway staging

Las mismas del `.env.staging` cargadas via dashboard Railway → Variables.

#### 4.4 Variables en Vercel staging

Las mismas del `.env.staging.local` cargadas via Vercel → Settings → Environment Variables, scope = branch `staging`.

---

### FASE 5 — Scripts y shortcuts

Tras FASE 2, tendrás disponibles:

**Backend:**
```bash
npm run dev:staging       # Levanta servidor local contra DB staging
npm run start:staging     # Levanta build contra staging
npm run migrate:staging   # Aplica migraciones a DB staging
npm run seed:staging      # Popula DB staging con datos de prueba
npm run studio:staging    # Abre Prisma Studio apuntando a staging
```

**Frontend:**
```bash
npm run dev:staging       # Vite dev server apuntando a backend staging
npm run build:staging     # Build de staging
```

---

### FASE 6 — Validación y checklist final

Al finalizar todo, se genera `STAGING_CHECKLIST.md` con ítems tildables para verificar:

- Infraestructura (Supabase, Railway, Vercel, DNS, migraciones, seed)
- Backend (start sin errores, health check, DB conectada, WhatsApp apagado)
- Frontend (apunta a staging, sin hardcodeos de prod, Vercel OK)
- **Aislamiento crítico:** staging no puede escribir en prod, WhatsApp no dispara a usuarios reales, cero datos productivos
- Datos de prueba: al menos 1 Producer, 1 Plant, 1 Transporter, fletes y viajes

---

## 4. RIESGOS DETECTADOS

### 4.1 Hardcodeos encontrados en el código

| Ubicación | Contenido | Severidad | Acción en roadmap |
|---|---|---|---|
| `tolvink-api/src/main.ts:75` | CSP `connectSrc` con `https://mlmecljidioymujsazrs.supabase.co` | ALTA | Resolver en FASE 2.1 (bloqueante) |
| `tolvink-deploy/vercel.json:17` | CSP `connect-src` con `https://tolvink-api-production.up.railway.app` | ALTA | Resolver en FASE 2.1 (agregar ambos) |
| `tolvink-deploy/src/AiChat.jsx:33` | Fallback `tolvink.com` | MEDIA | Tiene override via `VITE_FRONTEND_URL` ✓ |
| `tolvink-deploy/src/utils/pdf-report.js:313` | QR URL `https://tolvink.com/freight/...` hardcoded | MEDIA | Necesita refactor a usar `VITE_FRONTEND_URL`. Dejar fuera del scope staging y crear ticket. |
| `tolvink-deploy/src/screens/SharedLinkScreen.jsx:607,670` | Link `tolvink.com` hardcoded | BAJA | Branding — dejar como está |
| `tolvink-deploy/src/screens/LandingScreen.jsx:632` | Branding `tolvink.com` | BAJA | Dejar como está |
| `tolvink-api/src/ai/core/constants.ts:12` | Fallback `tolvink.com` | BAJA | Tiene override via `FRONTEND_URL` ✓ |
| `tolvink-api/src/whatsapp/whatsapp-router.service.ts:43` | Idem | BAJA | Idem ✓ |

### 4.2 Riesgo de contaminación de datos

- **Mayor riesgo identificado:** al correr `prisma migrate` o `prisma db seed` con el `.env` equivocado cargado, se puede modificar producción.
  - **Mitigación:** todos los scripts `:staging` usan `dotenv-cli` para cargar `.env.staging` explícitamente. Verificación previa al ejecutar: imprimir `DATABASE_URL` y comprobar que contiene el ref staging.
- **Riesgo menor:** si alguien copia un `.env.staging` con el `DATABASE_URL` de prod, se rompe el aislamiento.
  - **Mitigación:** documentar en `.env.staging` que el ref debe ser distinto de `mlmecljidioymujsazrs`.

### 4.3 Costos adicionales

| Servicio | Plan requerido | Costo extra |
|---|---|---|
| Supabase | Free (2do proyecto) | $0 — se pausa tras 7 días inactividad (resumible con 1 click) |
| Railway | Hobby | $5/mes incluye $5 de credit → staging con poco tráfico queda dentro del credit. $0 real solo apagando el servicio cuando no se testea. |
| Vercel | Hobby | $0 (el plan actual cubre múltiples dominios) |
| Sentry (staging project) | Developer | $0 (5k eventos/mes gratis) |
| Gemini / OpenAI / Google Maps | Pay-as-you-go | $0 adicional si se reusan keys de prod. Si se crean nuevas, la quota es independiente. |

**Total estimado:** < $10/mes, principalmente Railway staging.

### 4.4 Límites de APIs sandbox

- **Supabase Free:** 500 MB DB, 1 GB storage, 2 GB bandwidth/mes, 50k MAU auth. Para staging sobra.
- **Supabase Free (pausa):** el proyecto se pausa después de 7 días sin actividad. Hay que restaurarlo manualmente (1 click). Riesgo menor pero real.
- **Railway Hobby:** $5 de credit incluidos por mes. Un staging 24/7 con tráfico bajo cabe dentro del credit. Para costo real $0 hay que parar/iniciar el servicio manualmente según uso.
- **Meta WhatsApp Cloud API:** NO requiere sandbox porque staging no usa webhook.

### 4.5 Secretos presentes en `.env` local productivo

**Detectado durante el audit** (no bloqueante del staging pero reportable):

- `tolvink/tolvink-api/tolvink-api/.env` contiene secrets reales de prod: `GEMINI_API_KEY`, `DATABASE_URL` con password, `SUPABASE_SERVICE_KEY`. **El archivo está en `.gitignore`** ✓ pero si el laptop se compromete, se filtra todo. Recomendación fuera de scope: rotar estos secrets periódicamente y considerar un secret manager (1Password, Vault, Doppler).

---

## PUNTOS DE DETENCIÓN (STOP)

1. **Fin del roadmap (ahora):** esperar aprobación explícita de Juan antes de presentar acciones manuales agrupadas.
2. **Post acciones manuales (FASE 1):** esperar que Juan confirme que completó todo y pase los datos requeridos antes de tocar archivos.
3. **Pre-migración de DB (FASE 3):** verificar en voz alta el `DATABASE_URL` activo antes de cualquier `prisma migrate`. Si apunta a prod, STOP inmediato.
4. **Cualquier error inesperado:** reportar mensaje completo y parar hasta recibir instrucción.

---

**FIN DEL ROADMAP — ESPERANDO OK DE JUAN PARA CONTINUAR**
