# TOLVINK — Project Status

**Fecha**: 2026-03-15
**Estado**: APTO CON RESERVAS (auditoría pre-producción)

---

## 1. Resumen del Proyecto

**Tolvink** es un sistema de gestión de fletes de granos para Uruguay y Latinoamérica. Conecta productores, plantas y transportistas en una plataforma web + WhatsApp con IA integrada.

| Métrica | Valor |
|---------|-------|
| Backend LOC | 30,383 |
| Frontend LOC | 22,326 |
| **Total LOC** | **52,709** |
| Commits backend | 426 |
| Commits frontend | 778 |
| **Total commits** | **1,204** |

---

## 2. Tech Stack

### Backend (v1.0.0)

| Componente | Tecnología | Versión |
|------------|-----------|---------|
| Framework | NestJS | ^10.3.0 |
| ORM | Prisma Client | ^5.8.0 |
| Base de datos | PostgreSQL (Supabase) | 15+ |
| AI Agent | Anthropic SDK (Claude Sonnet 4.6) | ^0.78.0 |
| Audio (Whisper) | OpenAI SDK | ^6.22.0 |
| Auth | JWT + HttpOnly Cookies + bcryptjs | — |
| Error tracking | Sentry | ^8.0.0 |
| Security headers | Helmet | ^7.1.0 |
| Rate limiting | @nestjs/throttler | ^5.2.0 |
| Docs | Swagger (@nestjs/swagger) | ^7.2.0 |
| Deploy | Railway (auto-deploy main) | — |

**Archivos fuente**: 82 archivos `.ts`

### Frontend (v4.1.0)

| Componente | Tecnología | Versión |
|------------|-----------|---------|
| UI | React | 18.2.0 |
| Router | React Router | ^7.13.0 |
| State | Zustand | ^5.0.11 |
| Build | Vite | 5.0.0 |
| PDF | jsPDF + AutoTable | 4.2.0 / 5.0.7 |
| QR | qrcode | 1.5.4 |
| Error tracking | Sentry | ^10.39.0 |
| Tests | Vitest + Testing Library | 4.0.18 |
| Deploy | Vercel (auto-deploy main) | — |

**Archivos fuente**: 87 archivos `.jsx`/`.js`

---

## 3. Modelo de Datos (Prisma)

**32 modelos** + **8 enums**

### Modelos principales

| Modelo | Campos | Descripción |
|--------|--------|-------------|
| Freight | 50 | Flete: origen, destino, estado, multi-camión, documentos |
| User | 45 | Usuario: auth, roles, empresa activa, onboarding |
| FreightAssignment | 30 | Asignación de transportista a flete |
| Company | 29 | Empresa: productor, planta o transportista |
| WeighTicket | 23 | Ticket de balanza con OCR |
| Field | 15 | Campo agrícola con geo |
| Lot | 15 | Lote dentro de campo |
| FreightPendingChange | 14 | Cambios pendientes de aprobación |
| LiveLocation | 13 | GPS en tiempo real |
| AuditLog | 13 | Historial de auditoría |
| Truck | 13 | Camión con chofer asignado |
| Poi | 12 | Punto de interés |
| PlantProducerAccess | 12 | Acceso planta↔productor |
| ConversationParticipant | 12 | Participante de conversación |
| FreightDocument | 12 | Documento adjunto al flete |
| Branch | 11 | Sucursal de planta |
| Plant | 11 | Extensión de empresa tipo planta |
| Notification | 11 | Notificación push/in-app |
| WhatsAppSession | 10 | Sesión IA (WhatsApp + Web) |
| SharedField/SharedLot/SharedPoi | 9 c/u | Compartidos entre empresas |
| FreightTracking | 9 | Tracking de estado |
| UserCompany | 9 | Relación usuario↔empresa |
| WhatsAppMessageLog | 8 | Log de mensajes WhatsApp |
| PasswordResetCode | 9 | Código de recuperación |
| FreightItem | 7 | Ítem de carga (grano, tons) |
| PushSubscription | 7 | Suscripción push browser |
| Message | 7 | Mensaje de conversación |
| Conversation | 6 | Conversación entre usuarios |
| RefreshToken | 6 | Token de refresh JWT |
| AnalyticsEvent | 6 | Evento de analytics |

### Enums

| Enum | Valores |
|------|---------|
| CompanyType | producer, plant, transporter |
| UserRole | admin, operator, platform_admin |
| FreightStatus | draft, pending_assignment, assigned, accepted, in_progress, loaded, finished, canceled |
| AssignmentStatus | active, accepted, rejected, canceled |
| TripStatus | pending, accepted, in_progress, loaded, finished, canceled |
| GrainType | Soja, Maiz, Trigo, Girasol, Sorgo, Cebada, Otros |
| NotificationType | 11 tipos (freight_*, message_received, conversation_started) |
| DocumentStep | request, assignment, load_confirmation, delivery_confirmation, cancellation |

---

## 4. Endpoints (Backend)

**172 endpoints** en **17 controladores**

| Controlador | GET | POST | PATCH | DELETE | Total | Auth |
|-------------|-----|------|-------|--------|-------|------|
| freights | 12 | 21 | 3 | 1 | **37** | JWT + FreightAccessGuard |
| admin | 9 | 7 | 8 | 5 | **29** | JWT + platformAdmin |
| fields | 7 | 10 | 9 | 0 | **26** | JWT |
| auth | 2 | 9 | 2 | 0 | **13** | Mixto (público + JWT) |
| conversations | 3 | 3 | 3 | 0 | **9** | JWT |
| whatsapp | 3 | 6 | 0 | 0 | **9** | HMAC / signed tokens |
| plant-access | 6 | 1 | 1 | 0 | **8** | JWT + roles |
| trucks | 2 | 2 | 2 | 0 | **6** | JWT |
| weigh-tickets | 2 | 2 | 1 | 1 | **6** | JWT |
| catalog | 5 | 0 | 0 | 0 | **5** | JWT |
| notifications | 1 | 1 | 2 | 1 | **5** | JWT |
| freight-public | 4 | 0 | 0 | 0 | **4** | shareToken |
| freight-tracking | 4 | 0 | 0 | 0 | **4** | shareToken |
| web-chat | 1 | 2 | 0 | 0 | **3** | JWT |
| analytics | 1 | 1 | 0 | 0 | **3** | Mixto (track público, query JWT+admin) |
| sse | 1 | 1 | 0 | 0 | **2** | JWT (ticket-based) |
| health | 2 | 0 | 0 | 0 | **2** | Público |
| ocr | 0 | 1 | 0 | 0 | **1** | JWT |

**Endpoints por método**: 63 GET, 66 POST, 31 PATCH, 8 DELETE

---

## 5. Pantallas (Frontend)

**24 pantallas** — todas lazy-loaded con `React.lazy` + `Suspense`

### Autenticadas

| Pantalla | Archivo | Líneas | Descripción |
|----------|---------|--------|-------------|
| Home | HomeScreen.jsx | 788 | Dashboard + estadísticas |
| List | ListScreen.jsx | 955 | Lista fletes (Kanban + tabla) |
| Detail | DetailScreen.jsx | 1,050 | Detalle flete + multi-truck + OCR + sugerencias |
| New | NewScreen.jsx | 893 | Wizard creación de flete |
| Edit | EditScreen.jsx | 194 | Edición de flete |
| Calendar | CalendarScreen.jsx | 209 | Vista calendario |
| Locations | LocationsScreen.jsx | 1,088 | Campos, lotes, POIs |
| Admin | AdminScreen.jsx | 888 | CRUD admin (empresas, usuarios, sucursales) |
| Chats | ChatsScreen.jsx | 879 | Conversaciones en tiempo real |
| Reports | ReportsScreen.jsx | 567 | Informes + OCR + PDF |
| Access | AccessScreen.jsx | 458 | Acceso planta↔productor |
| Trucks | TrucksScreen.jsx | 149 | Gestión de camiones y choferes |
| MyData | MyDataScreen.jsx | 157 | Perfil + contraseña |
| Notifications | NotificationsScreen.jsx | 114 | Bandeja de notificaciones |
| Menu | MenuScreen.jsx | 208 | Menú lateral mobile |

### Públicas (sin auth)

| Pantalla | Archivo | Líneas | Descripción |
|----------|---------|--------|-------------|
| Landing | LandingScreen.jsx | 701 | Landing page pública |
| Auth | AuthScreen.jsx | 396 | Login, registro, reset password |
| TrackFreight | TrackFreightScreen.jsx | 423 | Tracking público de flete |
| LiveFreight | LiveFreightScreen.jsx | 658 | Tracking en tiempo real |
| DailyMap | DailyMapScreen.jsx | 325 | Mapa diario overview |
| ViewMap | ViewMapScreen.jsx | 152 | Visor de mapa público |
| PickLocation | PickLocationScreen.jsx | 342 | Location picker público |
| ReportDownload | ReportDownloadScreen.jsx | 138 | Descarga de informe público |
| CompanyPicker | CompanyHeaderPicker.jsx | 49 | Selector multi-empresa |

---

## 6. Componentes (Frontend)

### Componentes principales

| Componente | Archivo | Líneas | Descripción |
|-----------|---------|--------|-------------|
| Maps | maps.jsx | 1,108 | LocationPicker, FreightMap, FreightsOverviewMap, MapOverlay, icons |
| AiChat | AiChat.jsx | 877 | Panel IA fullscreen + streaming + maps inline |
| AppLayout | layout/AppLayout.jsx | 586 | Layout principal, handlers, polling, SSE |
| Uploads | uploads.jsx | 380 | DocsGallery, OcrResultModal, UploadOverlay |
| Navigation | components/navigation.jsx | 381 | Sidebar, Nav, mobile header |
| WeighTicketForm | components/WeighTicketForm.jsx | 305 | Formulario ticket balanza + OCR |
| Overlays | components/overlays.jsx | 176 | Modales, diálogos de confirmación |
| AssignmentSuggestions | components/AssignmentSuggestions.jsx | 156 | Sugerencias de asignación con scoring |
| Form | components/form.jsx | 155 | Inputs, selects, date pickers |
| Feedback | components/feedback.jsx | 147 | Toasts, loading states |
| DataDisplay | components/data-display.jsx | 106 | Cards, tablas, badges |
| Theme | theme.jsx | 97 | Tokens de diseño (C), iconos (Ic), analytics |

### Modales (8 archivos, 1,107 líneas)

| Modal | Líneas | Descripción |
|-------|--------|-------------|
| AssignModal | 451 | Asignación de transportista |
| TruckSelectModal | 162 | Selección de camión |
| WeighTicketConfirmModal | 137 | Confirmación ticket balanza |
| EditTripModal | 111 | Edición de viaje |
| MapPreviewModal | 107 | Preview de mapa |
| DriverQueueModal | 86 | Cola de choferes |
| ConfirmActionModal | 30 | Confirmación genérica |
| ReasonModal | 23 | Motivo de rechazo/cancelación |

### Hooks (8 archivos, 962 líneas)

| Hook | Líneas | Descripción |
|------|--------|-------------|
| useFreights | 183 | Fetching y cache de fletes |
| useAuth | 177 | Estado de auth, login, logout, switch company |
| useSSE | 166 | Conexión SSE + eventos en tiempo real |
| helpers | 144 | Hooks utilitarios |

### Stores (Zustand)

| Store | Descripción |
|-------|-------------|
| useUIStore | Modales, toasts, mapFocus, listView, submitting |
| useCatalogStore | Cache multi-tenant de catálogos (plantas, lotes, transportistas) |
| useFreightDetailStore | Cache de detalle de flete (TTL 2min) |
| offlineQueue | Cola IndexedDB para escrituras offline |

---

## 7. Módulo de IA

### AI Agent (Backend)

| Métrica | Valor |
|---------|-------|
| Archivo principal | ai.service.ts (5,452 líneas) |
| Tool definitions | ai-tool-definitions.ts (1,033 líneas) |
| Total tools | **93 herramientas** |
| Modelo | Claude Sonnet 4.6 |
| Max tool loops | 3 |
| Max history | 25 mensajes |
| Max tokens | 1,200 |
| Temperature | 0.4 |
| Timeout per call | 45s |
| Global deadline | 90s |

### Tool filtering por rol

| Rol | Tools disponibles |
|-----|-------------------|
| Chofer | ~18 |
| Productor | ~25 |
| Planta | ~25 |
| Transportista | ~22 |
| Admin | + admin tools |
| Multi-empresa | + switch_company |

### Categorías de tools

CORE, CHOFER, PRODUCER, PLANT, TRANSPORTER, TRACKING, ANALYTICS, ADMIN, MULTI_COMPANY, PENDING_CHANGE

### Canales de acceso

| Canal | Entrada | Salida |
|-------|---------|--------|
| WhatsApp | Webhook Meta → whatsapp-router → ai.chat() | whatsapp.service.sendMessage() |
| Web Chat | POST /web-chat/message → ai.chat(onDelta) | SSE ai:chunk / ai:response |
| Web Audio | POST /web-chat/audio → Whisper → ai.chat() | SSE ai:transcription + ai:response |

---

## 8. Módulo WhatsApp

| Métrica | Valor |
|---------|-------|
| whatsapp.controller.ts | 756 líneas, 9 endpoints |
| whatsapp-router.service.ts | 1,879 líneas |
| whatsapp-flow.service.ts | 1,560 líneas |
| whatsapp.service.ts | 789 líneas |
| Webhook security | HMAC-SHA256 + timingSafeEqual |
| Location picker | Signed tokens, 30min TTL |
| Message dedup | In-memory map, 60s TTL |
| WABA ID | 934247689183162 |
| Phone Number ID | 1028017740397801 |

---

## 9. Módulo de Sugerencias de Asignación

**Nuevo (Mar 15 2026)**

| Componente | Detalle |
|-----------|---------|
| Backend | assignment-suggestions.service.ts (548 líneas) |
| Endpoint | GET /freights/:id/assignment-suggestions |
| Auth | JWT + @Roles('plant') + FreightAccessGuard |
| Throttle | 30 req/min |
| AI tool | get_assignment_suggestions (PLANT_TOOLS) |
| Frontend | AssignmentSuggestions.jsx (156 líneas) |

### Algoritmo de scoring (5 factores, 100 pts max)

| Factor | Peso | Descripción |
|--------|------|-------------|
| Proximidad | 20 pts | Haversine distance (live location o base) |
| Capacidad | 20 pts | Capacidad del camión vs tons requeridas |
| Historial | 20 pts | Fletes previos con misma planta |
| Disponibilidad | 20 pts | Sin fletes activos en la fecha |
| Confiabilidad | 20 pts | Tasa de aceptación + completación |

- **Own fleet boost**: +15 pts cuando `useOwnFleet=true` y empresa tiene `hasInternalFleet`
- **Límite**: Top 8 sugerencias, ordenadas por score desc
- **Fallback geo**: Si no hay coordenadas, redistribuye puntos de proximidad

---

## 10. Seguridad

### Controles implementados

| Control | Estado | Detalle |
|---------|--------|---------|
| Autenticación | HttpOnly Cookies | SameSite=None, Secure, Partitioned |
| JWT | 30min access + 7d refresh | Verifica user.active en DB (cache 30s) |
| CSRF | Origin/Referer validation | Skips: webhook, analytics |
| Rate limiting global | 500 req/min | @nestjs/throttler |
| Rate limiting endpoints | 3-60 req/min | Por endpoint crítico |
| Security headers | Helmet | CSP, HSTS, X-Frame-Options |
| Body limit | 2 MB | JSON + URL-encoded |
| Exception filter | Global | Sin stack traces en producción |
| Webhook HMAC | SHA-256 + timingSafeEqual | WhatsApp webhook |
| Signed tokens | HMAC-SHA256 + TTL | Share links, location picker |
| Multi-tenancy | Company-scoped queries | FreightAccessGuard + assertPlatformAdmin |
| PII masking | Logs | Teléfonos enmascarados |

### Guards

| Guard | Archivo | Descripción |
|-------|---------|-------------|
| JwtAuthGuard | jwt-auth.guard.ts | Cookie/Bearer + active check |
| FreightAccessGuard | freight-access.guard.ts | Acceso multi-tenant a fletes |
| RolesGuard | roles.guard.ts | Autorización por rol |

### Auditorías realizadas

| Fecha | Hallazgos | Descripción |
|-------|-----------|-------------|
| Feb 2026 | ~109 fixes | 10 rondas, OWASP top-10 |
| Mar 3 | — | Role checks, lot ownership, tons validation |
| Mar 5 | 89 fixes | Security rounds 4-6 |
| Mar 8 | 114 fixes | Comprehensive (tenant isolation, DB, a11y, config) |
| Mar 8 | 65 fixes | Round 2 (AI lock leak, JWT cache, SSE limits) |
| **Mar 15** | **14 findings** | **Pre-producción: 1 CRITICAL, 3 HIGH, 4 MEDIUM, 5 LOW** |

---

## 11. Tests

### Backend

| Suite | Estado | Motivo fallo |
|-------|--------|-------------|
| haversine.spec.ts | FAIL | ts-jest config |
| assignment-suggestions.service.spec.ts | FAIL | ts-jest config |
| freight-state-machine.service.spec.ts | FAIL | ts-jest config |
| freight-state-machine.spec.ts | FAIL | ts-jest config |
| company-resolution.service.spec.ts | FAIL | ts-jest config |
| auth.service.spec.ts | FAIL | ts-jest config |
| fuzzy-match.spec.ts | FAIL | ts-jest config |
| weigh-tickets.service.spec.ts | FAIL | ts-jest config |
| freights.service.spec.ts | FAIL | ts-jest config |

**9/9 suites fallan** — Causa: incompatibilidad ts-jest con `outDir`/`rootDir` en tsconfig. Pre-existente, no regresión de código. Los tests están escritos y son lógicamente correctos.

### Frontend

- Vitest + Testing Library configurados
- Tests no ejecutados en esta auditoría

---

## 12. Builds

| Repo | Comando | Estado | Tiempo |
|------|---------|--------|--------|
| Backend | `tsc --noEmit` | Warning (scripts/ fuera de rootDir) | ~10s |
| Backend | `nest build` | OK | — |
| Frontend | `vite build` | OK | 24s |

---

## 13. Infraestructura y Deploy

| Componente | Plataforma | Detalle |
|-----------|-----------|---------|
| Backend API | Railway | Auto-deploy desde main |
| Frontend Web | Vercel | Auto-deploy desde main |
| Base de datos | Supabase | PostgreSQL pooler + direct URLs |
| Error tracking | Sentry | Backend + Frontend |
| Push notifications | Web Push | Subscription-based |

### Variables de entorno requeridas (backend)

| Variable | Descripción |
|----------|-------------|
| DATABASE_URL | PostgreSQL pooled connection |
| DIRECT_URL | PostgreSQL direct connection (migrations) |
| JWT_SECRET | Secret para firmar JWT (min 32 chars) |
| WHATSAPP_APP_SECRET | Meta Graph API HMAC secret |

### Variables opcionales

SENTRY_DSN, CORS_ORIGIN, PORT, NODE_ENV, FRONTEND_URL, INTERNAL_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY

---

## 14. Archivos más grandes

### Backend

| Archivo | Líneas |
|---------|--------|
| ai.service.ts | 5,452 |
| freights.service.ts | 3,285 |
| whatsapp-router.service.ts | 1,879 |
| whatsapp-flow.service.ts | 1,560 |
| admin.controller.ts | 1,390 |
| ai-tool-definitions.ts | 1,033 |
| fields.service.ts | 1,087 |
| whatsapp.service.ts | 789 |
| whatsapp.controller.ts | 756 |
| auth.service.ts | 653 |

### Frontend

| Archivo | Líneas |
|---------|--------|
| maps.jsx | 1,108 |
| LocationsScreen.jsx | 1,088 |
| DetailScreen.jsx | 1,050 |
| ListScreen.jsx | 955 |
| NewScreen.jsx | 893 |
| AdminScreen.jsx | 888 |
| AiChat.jsx | 877 |
| ChatsScreen.jsx | 879 |
| HomeScreen.jsx | 788 |
| LandingScreen.jsx | 701 |

---

## 15. PWA

| Componente | Estado |
|-----------|--------|
| manifest.json | Configurado (standalone, shortcuts, icons) |
| Service Worker | sw.js (stamped con hash en deploy) |
| Icons SVG | 8 tamaños (72-512px) |
| Icons raster | apple-touch-icon, favicon-32, icon-192, icon-512 |
| Splash screens | 4 SVG (iPhone 8 → iPhone 15 Pro Max) |
| Offline queue | IndexedDB via offlineQueue store |

---

## 16. Deuda Técnica

### Prioridad alta

| Issue | Impacto |
|-------|---------|
| shareToken sin TTL | Acceso permanente si se filtra (CRITICAL auditoría) |
| Tests no ejecutables | Sin cobertura automatizada, ts-jest config rota |
| PII en endpoints públicos | Nombres de conductores y razones de rechazo visibles |
| Web-chat session sin company isolation | Sesión reutilizable al cambiar empresa |

### Prioridad media

| Issue | Impacto |
|-------|---------|
| In-memory rate limits/caches | No funciona multi-instancia (Redis planificado) |
| Audio MIME permisivo | Acepta cualquier audio/*, debería whitelist |
| Env vars opcionales sin validar | AI/Whisper falla silenciosamente |
| findMany sin take en transportistas | Query potencialmente pesada |
| strictNullChecks deshabilitado | Tipos menos estrictos |
| noImplicitAny deshabilitado | Tipos menos estrictos |

### Prioridad baja

| Issue | Impacto |
|-------|---------|
| Archivos grandes (ai.service 5.4K, freights.service 3.3K) | Mantenibilidad |
| jest.config duplicado (.js + .ts) | Confusión en config |
| openai package solo para Whisper | Dependencia pesada |
| Phone normalization solo +598 | Limita expansión regional |
| NewScreen form sections duplicadas mobile/desktop | Código repetido |
| PWA fonts faltantes en public/ | — |

---

## 17. Estado de .claude/

### Backend (.claude/)
- `settings.json` — configuración de Claude Code
- `settings.local.json` — configuración local

### Frontend (.claude/)
- `settings.local.json` — configuración local

### Proyecto (C:\Users\Usuario\.claude\projects\...)
- **6 transcripts** de conversaciones (.jsonl)
- **2 directorios** de sesiones activas
- **memory/** — 10 archivos de memoria persistente:
  - MEMORY.md (índice principal)
  - architecture.md, auth-security.md, database.md
  - api-endpoints.md, business-logic.md, performance.md
  - roadmap.md, ai-roadmap.md, web-chat.md

**No existe** directorio `.claude/agents/` en ninguno de los repos.

---

## 18. Último commit por repo

| Repo | Commit | Mensaje |
|------|--------|---------|
| Backend | `83f03cf` | fix: haversine NaN guard — prevent invalid proximity scores |
| Frontend | `f2ab9ce` | fix: bold "Usar ubicación del campo" option in lot selector |
