# Security

## Authentication

| Actor | Method | Where enforced |
| --- | --- | --- |
| Patient (Mini App) | Telegram initData — HMAC-SHA256 over sorted `key=value` pairs, secret derived from bot token (`WebAppData` prefix); must be fresh (<24h) and re-verified server-side on every request | `/api/telegram/auth`, booking APIs |
| Patient (bot chat) | Telegram webhook with `X-Telegram-Bot-Api-Secret-Token`; message senders validated; updates deduplicated by `processed_webhooks` | `/api/telegram/webhook` |
| Staff (admin/doctor panels) | Supabase Auth (email/password); pages redirect to `/admin/login` when session missing | `admin/layout.tsx`, `doctor/layout.tsx` |
| Staff (API mutations) | `requireStaff("owner" \| "admin" \| "doctor")` — checks the JWT user id against `staff_roles` server-side on every request; doctors additionally get ownership checks (can only touch their own appointments) | `src/lib/auth/guards.ts` |
| Cron | `Authorization: Bearer <CRON_SECRET>` | `/api/notifications/process` |

## Database (RLS)

- All business tables have row-level security policies scoped to `clinic_id` and the
  caller's role:
  - `authenticated` (staff) — read: same clinic as the profile; write: owner/admin rules
    per table; doctors manage only their own working hours/blocks/appointments.
  - `anon` — no table grants at all (patients never appear as anon SQL users).
  - `service_role` — server-side only (Next.js API routes), bypasses RLS by design.
- Grants are applied in `20260813000013_grants.sql`; new tables inherit via
  `ALTER DEFAULT PRIVILEGES`.
- `referrals` opts out of those blanket grants: `authenticated` may only SELECT, and RLS limits
  that to the referring doctor and — while the referral is open and unexpired, or once they
  completed it — the receiving doctor. Only `service_role` writes (no DELETE for any role; a
  referral is withdrawn by revoking it). Its reason and handoff note are clinical text: never
  logged, never copied into `audit_events`.
- `doctors.profile_id` (which staff account a doctor record belongs to) is set only server-side:
  a trigger rejects authenticated sessions that set or change it, and `(clinic_id, profile_id)`
  is unique, so a staff account maps to at most one doctor record per clinic.
- Double-booking is prevented in Postgres (exclusion constraint + RPC), not in app code.

## Secrets

- All secrets live in environment variables; locally in `.env` (gitignored), in production in
  Secret Manager, referenced from Cloud Run with `--set-secrets`.
- `.env.example` / `.env.test.example` are the only committed env files, with placeholders.
- `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `AI_API_KEY`,
  `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` must never be committed or
  exposed to the browser.
- Service role key is only available server-side; browser builds receive only the anon key.

## API hardening

- `src/proxy.ts` protects `/admin` and `/doctor` routes.
- All routes: input validation with zod (`parseBody` in `src/lib/api/validate`), centralized
  error handling (`handleApiError`) — no stack traces leaked.
- Rate limiting: `src/lib/ratelimit` (in-memory token bucket + IP fallback) on booking and
  auth-heavy endpoints; test suite covers it.
- Security headers on every response (HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`), with `frame-ancestors` allowing only Telegram for
  the Mini App routes.
- Voice notes are uploaded to Supabase Storage with clinic-scoped paths and short-lived access.

## Referrals

- Doctor endpoints (`/api/doctor/referrals/...`) use `requireLinkedDoctor()`: the caller must
  hold the exact `doctor` role *and* be linked to an active doctor record in the same clinic.
  Owner/admin/manager accounts linked to a doctor record are refused (403) — management never
  reads referral clinical text through the doctor portal.
- A doctor may only refer from their own consultation (`in_progress` / `completed`
  appointment); the patient and clinic come from that appointment, never from the browser
  (unknown request fields are stripped by the zod schema).
- The receiving doctor is checked server-side before anything is written: a doctor record in the
  caller's clinic (otherwise 404, the same answer as for an id that exists nowhere), active,
  linked to an account holding the doctor role, not the caller. The DB trigger and composite FK
  enforce the same rule again on insert.
- Creation is idempotent: every request carries `idempotencyKey` (a UUID generated when the
  doctor opens the review step), stored as `referrals.creation_key`, unique per referring doctor
  and immutable. A repeat — sequential or concurrent — returns the referral already created
  (200, `replayed: true`) without writing anything, so `referral_created` is audited once; the
  same key with different content is refused (409 `idempotency_key_reused`). The key is never
  copied into `audit_events`.
- Non-parties get 404 (not 403), so referral ids cannot be probed. The receiving doctor loses
  access once a referral is declined, revoked or expired.
- The receiving doctor sees the patient's appointment history with the referring doctor
  (date, service, status — no clinical text) only after accepting.
- Every detail view is written to `audit_events` (`referral_viewed`, role + whether history was
  shown) in **strict** mode: if the access log cannot be written the view fails (503) instead
  of being served unlogged.
- Status changes use compare-and-swap on the current status (409 on a lost race); the DB trigger
  still enforces the state machine and who may make each transition.
- Reception and management (`/api/admin/patients`) see referral metadata only (doctors, status,
  priority, dates, follow-up appointment) — never the reason or handoff note. Only
  owner/admin/manager can revoke (`/api/admin/referrals/[id]`).
- A follow-up appointment is booked through the transactional booking engine and then linked;
  the DB only accepts it for an accepted, unexpired referral, with the receiving doctor, for the
  referred patient, one active follow-up at a time. If the link loses a race the new appointment
  is cancelled and the request fails (409).

## Medical safety (non-security but critical)

`src/lib/safety/policy.ts`:

- urgency keywords (Uzbek/Russian/English) → mandatory escalation message + human handoff,
- disallowed claims (diagnosis, prescription, "you don't need a doctor") blocked with
  patterns, e.g. `sizga <dori> kerak`,
- the AI prompt states it is not a doctor and is grounded only in clinic data.

## Audit & monitoring

- `audit_events` records staff mutations and payment transitions (who/what/when, immutable).
- Structured JSON logs (Cloud Logging in production), `LOG_LEVEL` configurable.
- `GET /api/health` for the load balancer.

## Incident response

1. Roll back the revision (see [rollback.md](rollback.md)).
2. Revoke secrets in Secret Manager if compromise is suspected.
3. Check `audit_events` + Cloud Logging for the incident window.
4. Investigate, patch, deploy. File an issue in this repo.