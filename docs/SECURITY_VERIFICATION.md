# Security Verification Document

This document records the exact security architecture, database-level row policies, authentication mechanisms, secrets management, input sanitization, and compliance controls verified within the **Health AI** repository.

---

## 1. Security Architecture Summary

```
                      Client Layer (Browser / Telegram)
                                     │
             ┌───────────────────────┴───────────────────────┐
             │                                               │
    Patient (Mini App / Bot)                      Clinic Staff (Admin / Doctor)
   Telegram HMAC initData                         Supabase Auth (JWT Email/Pass)
             │                                               │
             └───────────────────────┬───────────────────────┘
                                     │
                                     ▼
                    Edge Proxy & Middleware (src/proxy.ts)
                    - Security HTTP Headers (HSTS, CSP)
                    - Rate Limiting (src/lib/rate-limit.ts)
                                     │
                                     ▼
                      Next.js API Layer (src/app/api/...)
                      - Fail-Closed Env Guards (src/instrumentation.ts)
                      - Zod Input Parsing (src/lib/api/validate.ts)
                      - Server RBAC Guards (src/lib/auth/guards.ts)
                      - Central Error Handler (src/lib/api/errors.ts)
                                     │
                                     ▼
                  Supabase PostgreSQL Managed Database
                  - RLS Enabled on 100% of Business Tables
                  - Tenant Security Definer Helper (is_clinic_staff)
                  - GiST Advisory Locking & Exclusion Constraints
                  - Immutable Audit Triggers (audit_track_changes)
```

---

## 2. Verified Security Controls Matrix

| Control Category | Security Mechanism | Implementation File / Evidence Location | Verification Method |
| --- | --- | --- | --- |
| **Patient Authentication** | HMAC-SHA256 signature verification of Telegram WebApp `initData`, 24h freshness window, clinic-bound token check | [src/lib/telegram/init-data.ts](file:///Users/jahonshoh/Health%20AI/src/lib/telegram/init-data.ts#L30-L101), [src/app/api/telegram/auth/route.ts](file:///Users/jahonshoh/Health%20AI/src/app/api/telegram/auth/route.ts) | Unit tests in [init-data.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/telegram/init-data.test.ts) |
| **Staff Authentication** | Supabase Auth email/password sessions; redirect to `/login` when unauthenticated | [src/app/admin/layout.tsx](file:///Users/jahonshoh/Health%20AI/src/app/admin/layout.tsx), [src/app/doctor/layout.tsx](file:///Users/jahonshoh/Health%20AI/src/app/doctor/layout.tsx), [src/lib/auth/staff.ts](file:///Users/jahonshoh/Health%20AI/src/lib/auth/staff.ts) | Middleware & layout route guard inspection |
| **Cron Authentication** | Header `Authorization: Bearer <CRON_SECRET>` checked on notification cron endpoint | [src/app/api/notifications/process/route.ts](file:///Users/jahonshoh/Health%20AI/src/app/api/notifications/process/route.ts) | Route handler testing & env validation |
| **Webhook Authentication** | Header `X-Telegram-Bot-Api-Secret-Token` matched against `TELEGRAM_WEBHOOK_SECRET` | [src/app/api/telegram/webhook/route.ts](file:///Users/jahonshoh/Health%20AI/src/app/api/telegram/webhook/route.ts#L25-L35) | Webhook unit tests in `webhook/route.test.ts` |
| **Role-Based Authorization** | Server guards `requireStaff(role)`, `requireRoles(...)`, and `requirePlatformAdmin()` | [src/lib/auth/guards.ts](file:///Users/jahonshoh/Health%20AI/src/lib/auth/guards.ts) | RBAC tests in [role-authorization.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/supabase/role-authorization.test.ts) |
| **Multi-Tenant Isolation** | Foreign key `clinic_id` on all business tables; Database RLS scoped via `is_clinic_staff` | [supabase/migrations/20260813000010_rls.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000010_rls.sql), [20260818000024_role_based_rls.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260818000024_role_based_rls.sql) | Tenant isolation tests in [tenant-isolation.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/supabase/tenant-isolation.test.ts) |
| **Database Row-Level Security** | 100% tables RLS enabled; direct table access revoked for `anon` role | [supabase/migrations/20260813000013_grants.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000013_grants.sql) | SQL schema DDL audit |
| **Double-Booking Prevention** | `book_appointment` RPC advisory locking + Postgres GiST exclusion constraint `no_overlapping_active_appointments` | [supabase/migrations/20260813000005_appointments_payments.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000005_appointments_payments.sql#L25-L28), [20260813000009_functions_triggers.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000009_functions_triggers.sql#L168-L305) | Concurrency race tests in [concurrency.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/booking/concurrency.test.ts) |
| **Secrets Handling & Fail-Closed** | Zod env parsing (`src/lib/env.ts`) + startup hook (`src/instrumentation.ts`) blocking boot on insecure defaults | [src/lib/env.ts](file:///Users/jahonshoh/Health%20AI/src/lib/env.ts), [src/instrumentation.ts](file:///Users/jahonshoh/Health%20AI/src/instrumentation.ts) | Environment tests in [env.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/env.test.ts) |
| **AI Medical Safety** | Regex and keyword analysis enforcing non-diagnostic policy, emergency escalation, prompt leak prevention | [src/lib/safety/policy.ts](file:///Users/jahonshoh/Health%20AI/src/lib/safety/policy.ts), [src/lib/ai/receptionist.ts](file:///Users/jahonshoh/Health%20AI/src/lib/ai/receptionist.ts) | Safety policy tests in [policy.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/safety/policy.test.ts) |
| **Voice Data Privacy** | Explicit patient consent check (`voice_consent_given`) + private Supabase Storage bucket (`voice-messages`) | [src/lib/telegram/handlers.ts](file:///Users/jahonshoh/Health%20AI/src/lib/telegram/handlers.ts#L180-L240), [supabase/migrations/20260813000017_voice_storage_upload.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000017_voice_storage_upload.sql) | Bot handler unit tests & storage policy audit |
| **Human Takeover Concurrency** | Compare-And-Swap (CAS) version checks on `conversations` table during admin takeover | [src/app/api/admin/conversations/[id]/route.ts](file:///Users/jahonshoh/Health%20AI/src/app/api/admin/conversations/[id]/route.ts) | Handoff tests in `conversations/[id]/route.test.ts` |
| **Webhook & Cron Idempotency** | Atomic claim of updates in `processed_webhooks` table; atomic status transitions in `notification_jobs` | [src/lib/telegram/bot.ts](file:///Users/jahonshoh/Health%20AI/src/lib/telegram/bot.ts#L36-L55), [src/lib/notifications/processor.ts](file:///Users/jahonshoh/Health%20AI/src/lib/notifications/processor.ts) | Idempotency tests in [lifecycle.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/notifications/lifecycle.test.ts) |
| **API Input Validation** | Request body validation via Zod schemas; strict type coercions | [src/lib/api/validate.ts](file:///Users/jahonshoh/Health%20AI/src/lib/api/validate.ts) | Input parsing tests in [api/errors.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/api/errors.test.ts) |
| **Error Leakage Prevention** | Centralized error handler masking unhandled exceptions and hiding stack traces from API outputs | [src/lib/api/errors.ts](file:///Users/jahonshoh/Health%20AI/src/lib/api/errors.ts) | Error masking unit tests in [api/errors.test.ts](file:///Users/jahonshoh/Health%20AI/src/lib/api/errors.test.ts) |
| **Rate Limiting** | In-memory token bucket rate limiter with IP fallback on sensitive routes | [src/lib/rate-limit.ts](file:///Users/jahonshoh/Health%20AI/src/lib/rate-limit.ts) | Rate limiter code audit |
| **Security HTTP Headers** | Headers attached in `src/proxy.ts`: HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors` | [src/proxy.ts](file:///Users/jahonshoh/Health%20AI/src/proxy.ts) | Proxy header audit |
| **Immutable Audit Logging** | Database triggers (`audit_track_changes`) logging INSERT/UPDATE/DELETE operations to `public.audit_events` | [supabase/migrations/20260813000009_functions_triggers.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000009_functions_triggers.sql#L100-L161) | DB analytics integrity tests |

---

## 3. Database Security Policy Verification Details

### A. RLS Helper Function (`public.is_clinic_staff`)
Defined in [supabase/migrations/20260813000009_functions_triggers.sql](file:///Users/jahonshoh/Health%20AI/supabase/migrations/20260813000009_functions_triggers.sql#L81-L95):

```sql
create or replace function public.is_clinic_staff(p_clinic_id uuid, p_roles public.staff_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = auth.uid()
      and sr.clinic_id = p_clinic_id
      and (p_roles is null or sr.role = any (p_roles))
  );
$$;
```

**Security Analysis:**
- Function executes as `SECURITY DEFINER` to read `staff_roles` safely.
- Explicitly overrides `search_path = public` to neutralize schema search path vulnerabilities.
- Validates both `auth.uid()` identity match and clinic membership.

### B. Role Matrix Policy Enforcements (`20260818000024_role_based_rls.sql`)
1. **Catalog Management (`services`, `specialties`, `doctors`, `faq_entries`):**  
   Restricted to `['owner', 'admin', 'manager']`.
2. **Operations (`appointments`, `patients`, `conversations`, `messages`):**  
   Accessible to `['owner', 'admin', 'manager', 'receptionist']`. Doctors receive scoped read access to appointments where `doctor_id` matches their own doctor record.
3. **Analytics & Audit (`analytics_events`, `audit_events`):**  
   Restricted strictly to management roles `['owner', 'admin', 'manager']`.
4. **Storage Scoping (`voice-messages` bucket):**  
   Upload policy validates that the storage object path prefix matches the authenticated user's clinic ID: `sr.clinic_id::text = (storage.foldername(name))[1]`.

---

## 4. Production Security Hardening Checklist

- [x] All database business tables have Row Level Security enabled.
- [x] Direct SQL table access for unauthenticated (`anon`) users is completely revoked.
- [x] All database RPC functions explicitly define `set search_path = public`.
- [x] Double-booking prevention enforced via GiST exclusion constraint and advisory transaction locking.
- [x] Production startup hook (`src/instrumentation.ts`) fails closed on insecure secrets or development flags.
- [x] Telegram WebApp `initData` cryptographically verified with HMAC-SHA256 and freshness checks.
- [x] Telegram webhook calls verified via `X-Telegram-Bot-Api-Secret-Token`.
- [x] Cron notification trigger protected by `Authorization: Bearer <CRON_SECRET>`.
- [x] AI receptionist output sanitized by prompt leak and medical claim detection filters.
- [x] Patient voice audio requires explicit consent and is stored in private, clinic-scoped storage.
- [x] Server-side API error handling masks internal stack traces from clients.
- [x] Security HTTP headers (HSTS, CSP frame-ancestors, X-Frame-Options) enforced via edge proxy.
