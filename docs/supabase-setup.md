# Supabase setup

## Local development stack

```bash
npx supabase start
```

- Starts Postgres + Auth + Storage + Studio in Docker (project ref `local`).
- Clean-state setup (applies ALL migrations + seed in one command):

```bash
npm run db:reset-local    # npx supabase db reset --local
```

  Use this after pulling new migrations; it recreates the database from
  scratch, applies `supabase/migrations/*.sql` in order, then runs
  `supabase/seed.sql` (demo clinic).
- To apply just new migrations without wiping data:
  `npx supabase db push --local`.
- Get local keys: `npx supabase status` → copy `API URL` (http://127.0.0.1:54321),
  `anon key`, `service_role key` into `.env`.

## Integration tests

`npm test` runs unit tests always; the DB integration suites
(`src/lib/supabase/integration.test.ts`, `src/lib/notifications/processor.test.ts`)
probe the local stack at startup (service-role lookup of the seed clinic):

- stack up + migrations + seed applied → suites run,
- stack down or partially configured → suites SKIP with a clear warning
  (`local Supabase unavailable — integration suites skipped`), never a
  misleading failed run.

Prerequisite for a full local run: `npm run db:reset-local` (above) and a
`.env` with the real local keys.

## Migrations

47 migrations in `supabase/migrations/` (ordered, repeatable on any environment; `supabase/full-db-setup.sql` is all of them as one script). The first 21:

1. `0001`–`0008` — schema: clinics, profiles, staff_roles, patients, specialties,
   services, doctors, doctor_services, working hours, time blocks, appointments,
   payments, conversations, messages, voice_messages, faq_entries, app_settings,
   notification_jobs, processed_webhooks, audit_events, analytics_events.
2. `0009` — functions & triggers: `book_appointment`, `reschedule_appointment`,
   updated_at triggers, notification job creation, webhook dedup, analytics.
3. `0010`–`0012` — RLS policies + `no_overlapping_active_appointments` exclusion
   constraint + storage buckets (voice notes).
4. `0013` — grants for `service_role` and `authenticated` (required — without it
   every API call fails with `permission denied`).
5. `0014` — release-blocker hardening: booking RPCs are `service_role`-only,
   `notification_jobs.in_progress` + atomic claim RPC, atomic webhook claim RPC.
6. `0015`–`0021` — follow-up fixes: reschedule duration overrides, doctor
   status-only edits, staff reply/upload RLS, walk-in patients, optional voice
   file ids, booking availability validation on all writes, and integrity gaps
   (payment inserts, conversation timestamps, Telegram-identity protection,
   notification indexes).

Later migrations add the referral and clinical-records model and lifecycle, the unified
booking engine (`20260930000005`) and tenant integrity (`20260930000006`: composite
same-clinic foreign keys everywhere, patient communication written by the server only —
which supersedes the staff reply/upload policies of `0015`–`0021` — SECURITY DEFINER
search_path and grants, reactivation checks, clinic deletion, `urgent_at`, `purged_at`).

Regenerate TypeScript types after schema changes:

```bash
npx supabase gen types typescript --local > src/lib/supabase/database.types.ts
```

## Seed data (demo clinic)

`supabase/seed.sql` creates:

- clinic `11111111-1111-4111-8111-111111111111` ("Health AI demo klinikasi"),
- 4 specialties, 5 services (Terapevt 20min / 150000 so'm, Kardiolog 30min / 250000, …),
- 3 doctors with Mon–Fri 09:00–18:00, Sat 09:00–14:00 (Asia/Tashkent),
- demo patient (Telegram id 777000, consented),
- FAQ entries.

The integration tests (`src/lib/supabase/integration.test.ts`) target these fixtures and
wipe test-created appointments before running, so the seed can be re-applied safely.

## Staff accounts

Users are created through Supabase Auth; the role lives in `staff_roles`.

**First owner (recommended):**

```bash
npm run create-owner
```

Reads `OWNER_EMAIL` / `OWNER_PASSWORD` (and `CLINIC_SLUG`/`CLINIC_NAME` for a new clinic)
from `.env`, creates the auth user, the clinic if missing, and the `owner` staff role.
Idempotent — safe to re-run.

**Additional staff:** the owner adds them in the admin panel under *Xodimlar* (email, name,
role — admin, manager, receptionist or doctor). A new account gets a one-time password shown
to the owner once; the member replaces it under *Parolim*. The owner changes roles and removes
members there too (audited); the owner role itself is only assigned by `create-owner`.

## Postgres functions (used by the app)

- `book_appointment(p_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_start_at, p_status, p_source, p_notes, p_created_by, p_idempotency_key)`
  → `{ appointment_id, amount, error_code, error_message, replayed }` — the one booking operation
  (service role only; called through `src/lib/booking/engine.ts`). `error_code` ∈ `invalid_status,
  clinic_not_found, doctor_not_found, service_not_found, patient_not_found, service_not_offered,
  past_slot, outside_working_hours, time_blocked, slot_taken, idempotency_key_reused`.
- `reschedule_appointment(p_clinic_id, p_appointment_id, p_new_start_at, p_actor)`
  → `{ error_code, error_message }` — `appointment_not_found, not_reschedulable, past_slot,
  outside_working_hours, time_blocked, slot_taken`.

See [architecture.md › Booking engine](architecture.md#booking-engine-double-booking-protection)
for the invariant and the constraint that enforces it.
Statuses in `appointment_status` enum: `pending, confirmed, checked_in, in_progress, completed, cancelled, no_show`.

## Production database

Provision a Supabase project; apply migrations with:

```bash
npx supabase db push --db-url "$PROD_DB_URL"
```

or, on an empty project, by running `supabase/full-db-setup.sql` once in the dashboard's SQL
editor — every migration in order, regenerated with `npm run db:full-setup` whenever a migration
is added (a test and CI fail while it is stale; it commits after enum additions so it runs as one
query). Then follow [deploy-cloud-run.md](deploy-cloud-run.md) for secrets.