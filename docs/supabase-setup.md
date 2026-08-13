# Supabase setup

## Local development stack

```bash
npx supabase start
```

- Starts Postgres + Auth + Storage + Studio in Docker (project ref `local`).
- On first start (or when migrations change): `npx supabase db push --local`
  applies `supabase/migrations/*.sql`; `npx supabase db seed --local` applies
  `supabase/seed.sql` if you want the demo clinic.
- Get local keys: `npx supabase status` → copy `API URL` (http://127.0.0.1:54321),
  `anon key`, `service_role key` into `.env`.

## Migrations

13 migrations in `supabase/migrations/` (ordered, repeatable on any environment):

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

**Additional staff:** create the auth user in Supabase Studio → insert `profiles` +
`staff_roles` rows (or use the admin panel once an owner exists).

## Postgres functions (used by the app)

- `book_appointment(p_clinic_id, p_patient_id, p_doctor_id, p_service_id, p_start_at, p_status, p_source, p_notes, p_created_by)`
  → `{ appointment_id, error_code, error_message }`
- `reschedule_appointment(p_appointment_id, p_new_start_at, p_updated_by)`
  → `{ appointment_id, error_code, error_message }`

Both return `error_code` in `{slot_taken, outside_working_hours, conflict, not_found, invalid_state}`.
Statuses in `appointment_status` enum: `pending, confirmed, checked_in, in_progress, completed, cancelled, no_show`.

## Production database

Provision a Supabase project; apply migrations with:

```bash
npx supabase db push --db-url "$PROD_DB_URL"
```

or via the Supabase dashboard (SQL editor). Then follow
[deploy-cloud-run.md](deploy-cloud-run.md) for secrets.