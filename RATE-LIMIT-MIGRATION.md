# TOLVINK — Rate Limiting: Current State & Migration Plan

**Fecha:** 2026-03-13
**Estado:** In-memory (single-instance only)

---

## 1. Current Architecture

Tolvink uses **two layers** of in-memory rate limiting, both reset on deploy/restart:

### Layer 1: NestJS ThrottlerGuard (global)

- **Config:** `ThrottlerModule.forRoot([{ ttl: 60000, limit: 500 }])` in `app.module.ts`
- **Storage:** Default NestJS in-memory store
- **Scope:** Applied globally via `APP_GUARD`

### Layer 2: UserRateLimitInterceptor (per-user/IP)

- **File:** `src/common/interceptors/user-rate-limit.interceptor.ts`
- **Limits:** 500 req/min (authenticated users by ID), 100 req/min (unauthenticated by IP)
- **Storage:** In-memory `Map` with periodic cleanup (every 5 min, hard cap at 10K entries)
- **Response:** HTTP 429 — `"Demasiadas solicitudes, intenta en un minuto"`

### Endpoint-Level Overrides (@Throttle decorator)

| Module | Endpoint | Limit |
|--------|----------|-------|
| Auth | `POST /login`, `/register`, `/identify-for-reset` | 5/min |
| Auth | `POST /request-code` | 3/min |
| Auth | `POST /verify-code`, `/reset-password` | 5/min |
| Auth | `POST /refresh`, `PATCH /change-password`, `GET /switch-company` | 10/min |
| Admin | Controller-level | 30/min |
| Admin | `POST /admin/users`, `PATCH /admin/me` | 5/min |
| Conversations | Controller-level | 60/min |
| Conversations | `POST /:id/typing` | 30/min (1 per 2s) |
| Conversations | `POST /:id/messages` | 30/min |
| Freights | List endpoints | 60/min |
| Freights | `POST /freights` (create) | 20/min |
| Freight Public | Controller-level | 60/min |
| Freight Tracking | Controller-level | 60/min |
| Analytics | Controller-level | 30/min |
| Notifications | Controller-level | 30/min |
| OCR | Controller-level | 20/min |
| SSE | `POST /sse/ticket` | 10/min |
| Web Chat | Controller-level 30/min, specific endpoints 10/min |
| Weigh Tickets | Controller-level | 10/min |
| WhatsApp | 10-30/min (varies) |

**Skip:** `GET /auth/ping` uses `@SkipThrottle()`.

---

## 2. Limitation: Per-Instance Only

Both rate limiting layers store counters in process memory. This means:

- **Multiple Railway instances** (horizontal scaling) each have independent counters — a user could make `N × limit` requests across `N` instances
- **Deploys reset all counters** — rate limits disappear on every deploy
- **Memory pressure** — the `UserRateLimitInterceptor` can accumulate up to 10K entries before culling

The codebase already acknowledges this:
> `user-rate-limit.interceptor.ts`: *"SCALING NOTE: In-memory store. Limits are per-instance, not global. For multi-instance deployments, replace with Redis-based rate limiting."*

> `whatsapp-router.service.ts`: Similar note about distributed locks needing Redis.

---

## 3. Risk Assessment

| Risk | Severity | When |
|------|----------|------|
| Rate limits ineffective under horizontal scaling | HIGH | If Railway scales to 2+ instances |
| Brute-force login not properly throttled across instances | HIGH | Multi-instance |
| Counter reset on deploy | LOW | Acceptable for current scale |
| Memory accumulation (10K cap) | LOW | Manageable for single instance |

**Current impact:** LOW — Tolvink runs on a single Railway instance. The in-memory approach is adequate for now.

**Future impact:** HIGH — If the app scales horizontally, rate limiting becomes effectively disabled.

---

## 4. Migration Path: Redis-Backed Rate Limiting

### Step 1: Add Redis dependency

```bash
npm install @nestjs-modules/ioredis ioredis
# or use @nestjs/throttler's built-in Redis storage adapter
npm install @nestjs/throttler-storage-redis
```

### Step 2: Configure ThrottlerModule with Redis store

```typescript
// app.module.ts
import { ThrottlerStorageRedisService } from '@nestjs/throttler-storage-redis';

ThrottlerModule.forRoot({
  throttlers: [{ ttl: 60000, limit: 500 }],
  storage: new ThrottlerStorageRedisService(process.env.REDIS_URL),
}),
```

### Step 3: Migrate UserRateLimitInterceptor

Replace the in-memory `Map` in `user-rate-limit.interceptor.ts` with Redis INCR + EXPIRE:

```typescript
// Pseudocode for Redis-backed rate limiting
const key = `ratelimit:${userId || ip}`;
const count = await redis.incr(key);
if (count === 1) await redis.expire(key, 60); // 60s TTL
if (count > limit) throw new HttpException('...', 429);
```

### Step 4: Add REDIS_URL to Railway environment

```
REDIS_URL=redis://default:xxx@redis-host:6379
```

### Prerequisites

- Redis instance (Railway has a Redis add-on, or use Upstash for serverless Redis)
- `REDIS_URL` environment variable in all environments
- No code changes needed for `@Throttle` decorators — they work with any storage backend

---

## 5. Other In-Memory State to Migrate

Beyond rate limiting, these in-memory structures would also need Redis if scaling horizontally:

| Component | File | Data |
|-----------|------|------|
| SSE tickets | `src/sse/sse.controller.ts` | Single-use auth tickets (Map) |
| SSE client connections | `src/sse/sse.service.ts` | Active SSE client registry |
| WhatsApp router lock | `src/whatsapp/whatsapp-router.service.ts` | Distributed lock for message routing |

---

*Generated 2026-03-13*
