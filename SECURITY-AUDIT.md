# Security Audit — Tolvink

**Date:** 2026-03-14
**Repos:** Frontend (`/workspaces/Tolvink`), Backend (`/workspaces/tolvink-api`)

## Overall: GOOD — No critical vulnerabilities found

---

## 1. Authentication & Cookies

| Check | Status | Details |
|-------|--------|---------|
| HttpOnly cookies | OK | `httpOnly: true, secure: true, sameSite: 'none', partitioned: true` |
| Access token TTL | OK | 30 minutes, path `/api` |
| Refresh token TTL | OK | 7 days, path `/api/auth` (narrow scope) |
| Login lockout | OK | 5 failed attempts → 15 min lockout |
| Password complexity | OK | Min 8 chars, requires uppercase + lowercase + digit |
| Reset code limits | OK | 3 attempts per code, 3 codes/hour, 10 min expiry |
| Timing attack prevention | OK | Constant-time bcrypt comparison with dummy hash |
| User enumeration prevention | OK | Generic error messages on register/reset conflicts |
| Replay prevention | OK | JTI nonce on reset tokens, atomically consumed |

## 2. Authorization

| Check | Status | Details |
|-------|--------|---------|
| Auth guards on endpoints | OK | All non-public endpoints use `JwtAuthGuard` or `FreightAccessGuard` |
| FreightAccessGuard | OK | Validates user's company participates (origin, dest, transporter, driver) |
| Role-based access | OK | `@Roles()` decorator on sensitive operations |
| Platform admin bypass | OK | Proper superuser pattern |

### Intentionally public endpoints (all justified):
- `GET /health` — Railway health checks (no sensitive data)
- `POST /auth/login`, `/register`, `/identify-for-reset`, `/request-code`, `/verify-code`, `/reset-password` — auth flow (throttled 3-5/min)
- `GET /auth/ping` — connectivity check
- `POST /analytics/track` — client analytics (allowlist of 12 events, 30/min limit)
- `POST /whatsapp/webhook` — HMAC-SHA256 validated before processing
- `GET /sse/stream` — short-lived ticket validation (not JWT in URL)

## 3. Input Validation

| Check | Status | Details |
|-------|--------|---------|
| DTOs with class-validator | OK | All critical endpoints use validated DTOs |
| SQL injection | OK | Only 1 raw query (health check, parameterized, no user input) |
| XSS (dangerouslySetInnerHTML) | OK | Only 1 usage for app-generated SVG (no user input) |
| File upload validation | OK | 10MB limit, extension whitelist, MIME validation, filename sanitization |
| JSON size limits | OK | Custom validator for freight items (50KB) |

## 4. Infrastructure

| Check | Status | Details |
|-------|--------|---------|
| CORS | OK | Explicit origin whitelist from env, credentials enabled |
| CSRF | OK | Origin/Referer validation on state-changing requests |
| Security headers | OK | Helmet + CSP + HSTS (1 year) |
| Compression | OK | gzip enabled |
| .gitignore | OK | `.env` excluded in both repos |
| Hardcoded secrets | OK | None found; VITE_ vars are public by design |

## 5. WhatsApp Webhook

| Check | Status | Details |
|-------|--------|---------|
| HMAC-SHA256 verification | OK | `crypto.timingSafeEqual()`, raw body verification |
| Deduplication | OK | 60s TTL dedup map prevents replay |
| Unknown message types | OK | Graceful fallback with user notification |

## 6. localStorage

| Check | Status | Details |
|-------|--------|---------|
| Token storage | OK | Tokens in HttpOnly cookies only, NOT localStorage |
| User data | OK | Non-sensitive fields only; `passwordHash`, `isSuperAdmin`, `refreshTokens` stripped |

---

## Recommendations (Low Priority)

1. Consider adding rate limiting to admin list endpoints (currently unlimited)
2. Monitor for Supabase RLS policy coverage on storage buckets
