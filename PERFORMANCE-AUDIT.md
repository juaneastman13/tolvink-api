# Performance Audit — Tolvink

**Date:** 2026-03-14
**Repos:** Frontend (`/workspaces/Tolvink`), Backend (`/workspaces/tolvink-api`)

## Overall: GOOD — No critical performance issues

---

## 1. Database Queries

| Check | Status | Details |
|-------|--------|---------|
| N+1 queries | OK | No loop-with-await patterns in critical paths |
| Freight pagination | OK | `Math.min(query.limit \|\| 20, 100)` with proper cursor pagination |
| Unbounded findMany | LOW RISK | 12 calls without `take` in admin/plant-access/conversations — all company-scoped, naturally bounded |

### Unbounded findMany detail:
- `plant-access.controller.ts` — 7 calls (company-scoped facility lookups)
- `admin.controller.ts` — 4 calls (branches, fields, lots, trucks per company)
- `conversations.controller.ts` — 3 calls (participant lookups, batch enrichment by IDs)

**Assessment:** These are admin/internal endpoints where data is naturally bounded by company scope. Adding arbitrary limits would silently drop data. Monitor if any company exceeds ~500 records in these tables.

## 2. Database Indexes

| Index | Status |
|-------|--------|
| `Freight[status, originCompanyId]` | Present |
| `FreightAssignment[freightId]` | Present |
| `FreightAssignment[freightId, tripStatus]` | Present |
| `FreightAssignment[transportCompanyId, status]` | Present |
| `FreightAssignment[truckId]` | Present |
| `FreightAssignment[driverId, status]` | Present |
| `FreightTracking[freightId, createdAt]` | Present |
| `Notification[userId, read, createdAt]` | Present |
| `ConversationParticipant[companyId]` | Present |
| `ConversationParticipant[conversationId, userId]` | Present |
| `Message[senderId]` | Present |
| `Message[conversationId, createdAt]` | Present |
| `WhatsAppSession[userId]` | Present |
| `WhatsAppSession[phone, expiresAt]` | Present |

**All critical indexes are present.** No missing indexes found.

## 3. Frontend

| Check | Status | Details |
|-------|--------|---------|
| Lazy loading | OK | All 20+ screens use `React.lazy()` + `Suspense` |
| Code splitting | OK | Vite produces individual chunks per screen |
| useEffect cleanup | OK | All major screens have cancellation flags and clearInterval |
| Google Maps cleanup | OK | `clearInstanceListeners()` on unmount |
| IntersectionObserver | OK | Proper `obs.disconnect()` cleanup |

### Bundle sizes (notable chunks):
| Chunk | Size | Gzipped |
|-------|------|---------|
| pdf-lib | 440 KB | 142 KB |
| html2canvas | 199 KB | 46 KB |
| vendor | 173 KB | 56 KB |
| LocationsScreen | 68 KB | 16 KB |
| LandingScreen | 61 KB | 14 KB |
| AdminScreen | 62 KB | 12 KB |

**Assessment:** PDF generation chunks are large but lazy-loaded on demand. No action needed.

## 4. Polling & SSE

| Check | Status | Details |
|-------|--------|---------|
| SSE reconnection | OK | Exponential backoff (5s → 30s max), tab visibility detection |
| Polling cleanup | OK | All `setInterval` calls have `clearInterval` in cleanup |
| SSE ticket TTL | OK | 30s single-use tickets with periodic cleanup |
| Concurrent request guard | OK | `fetchingRef` prevents duplicate fetches in useFreights |

### Polling intervals:
- DetailScreen: 15s (disabled when SSE connected)
- TrackFreightScreen: 10s
- LiveFreightScreen: 15s
- AppLayout: configurable interval

## 5. Backend

| Check | Status | Details |
|-------|--------|---------|
| Gzip compression | OK | `compression()` middleware enabled |
| Raw SQL | OK | Only 1 parameterized query (health check) |
| Large service files | NOTE | ai.service.ts (5404 lines), freights.service.ts (3078 lines) — functional but large |

## 6. Console Logging

| Check | Status | Details |
|-------|--------|---------|
| Frontend | OK | 15 statements, all intentional (error/warn for failure recovery) |
| Backend | OK | Uses NestJS Logger throughout |

---

## Recommendations (Low Priority)

1. Consider AbortController for in-flight poll requests to prevent concurrent races
2. Monitor html2canvas duplication in Vite bundle output
3. Consider splitting ai.service.ts into focused modules for maintainability
