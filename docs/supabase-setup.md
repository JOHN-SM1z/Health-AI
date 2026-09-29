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

49 migrations in `supabase/migrations/` (ordered, repeatable on any environment; `supabase/full-db-setup.sql` is all of them as one script). The first 21:

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
search_path and grants, reactivation checks, clinic deletion, `urgent_at`, `purged_at`), and
clinical record governance (`20261001000001`: versioned author-only corrections, doctor
records that keep their authors, patient deletion that never cascades into clinical,
referral, booking or payment records, and an empty `retention_policies`), and
longitudinal history (`20261002000001`, below).

### `20261002000001_longitudinal_history.sql`

Longitudinal patient history, department referrals and registration dedupe. Applying it changes:

- **Department referrals.** `referrals.referred_to_specialty_id` (composite foreign key to
  `specialties (id, clinic_id)`) is added and `referred_to_doctor_id` becomes nullable;
  `referrals_recipient_check` requires a doctor or a department. New indexes:
  `referrals_one_open_per_department` (unique — one open untaken referral per patient, referring
  doctor and department) and `referrals_unclaimed_department_idx`. `referrals_validate()` lets a
  department referral be taken only by its `pending → accepted` acceptance (the accepting doctor must
  belong to the department and not be the referring doctor or account); nobody can decline, start or
  complete it while untaken. `referrals_audit()` carries the department. The receiving-doctor policy
  also covers the department doctors of an untaken referral (never the one who raised it).
- **The access decision.** `doctor_patient_access(p_doctor_id, p_patient_id)` is dropped and
  re-created (service role only) with new return columns `clinic_id, own_patient,
  active_referral_ids, full_history` — replacing `history_doctor_ids` and
  `referral_appointment_ids`. `doctor_can_read_patient()` returns the caller's `full_history`;
  `doctor_can_read_appointment()` (signature kept) equals it, so no policy is re-created. A doctor
  with a treating relationship or an open referral (to them, or untaken to their department) now
  reads the patient's whole history from the moment a referral exists.
- **Payments.** The policy "payments read for own doctor" is dropped: a doctor's own token reads no
  payment rows; the server shows only the payment status of the doctor's own visit.
- **Patient identity.** `public.normalize_phone(text)` and the generated column
  `patients.phone_normalized` (stored, so it is computed for existing rows when the migration runs),
  with the partial index `patients_clinic_phone_normalized_idx` on `(clinic_id, phone_normalized)`.
  Not unique. It cannot be written directly.
- **Audit naming.** `clinical_records_audit()` writes `clinical_record_version_created` for a
  correction; rows written earlier keep `clinical_record_corrected`. The server-written clinical
  audit names changed with the same release (see
  [security.md › Audit event names](security.md#audit-event-names)): reports spanning the migration
  match both.

Reversal (from the migration's header): restore `doctor_patient_access()` /
`doctor_can_read_appointment()` / `referrals_audit()` and the receiving-doctor policy from
`20260929000001`, `doctor_can_read_patient()` from `20260927000003`, `referrals_validate()` from
`20260928000002` and `clinical_records_audit()` from `20261001000001`; re-create "payments read for
own doctor" (`20260927000004`); drop `referrals.referred_to_specialty_id` (after assigning or
revoking department referrals), its constraints and indexes, and set `referred_to_doctor_id` not
null again; drop `patients.phone_normalized`, its index and `normalize_phone()`. The application
code of this release no longer matches a reversed schema.

After adding or changing a migration, `supabase/full-db-setup.sql` is regenerated with
`npm run db:full-setup` (it now includes this migration; `src/lib/supabase/full-db-setup.test.ts` and
CI fail while it is stale), and the TypeScript types below are regenerated.

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
- `doctor_patient_access(p_doctor_id, p_patient_id)` → `(clinic_id, own_patient,
  active_referral_ids, full_history)` — the clinical access decision (service role only; one row for
  an active doctor-role doctor of the patient's clinic, none otherwise); RLS reaches it through
  `doctor_can_read_patient()` / `doctor_can_read_appointment()`. See
  [architecture.md › Clinical access](architecture.md#clinical-access-and-the-patients-profile).
- `normalize_phone(p_phone)` → digits only, a 9-digit number prefixed with `998`, NULL without
  digits — the expression behind `patients.phone_normalized`.

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