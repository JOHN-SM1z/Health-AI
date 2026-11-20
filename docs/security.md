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
  - `anon` — no table grants at all (patients never appear as anon SQL users). A Supabase
    project's own default privileges give anon every new public table; `20260930000004` revokes
    them (and the defaults for later tables), so an anonymous `/rest/v1/<table>` is refused (401)
    rather than answered with an empty RLS result.
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
- Double-booking is prevented in Postgres, not in app code: the exclusion constraint
  `no_overlapping_active_appointments` on (clinic, doctor, [start, end)) over active statuses holds
  whatever writes the row, and composite foreign keys keep an appointment's doctor, patient and
  service in its own clinic (see architecture.md › Booking engine). Booking and rescheduling are
  service-role-only functions; the client's clinic, price, duration, status and availability are
  never trusted.
- `appointments`, `patients` and `payments` are **written by the server only**
  (`20260930000002_server_only_booking_writes.sql`): signed-in and anonymous tokens have no
  INSERT/UPDATE/DELETE on them, whatever the role. Bookings and walk-ins go through
  `book_appointment()`, rescheduling through `reschedule_appointment()`, consultation starts
  through `start_consultation()`, status changes and cancellations through the admin API
  (notification, audit), payments through `transitionPaymentStatus()`. Before this, a manager's
  token could insert a payment already marked `paid` over `/rest/v1/payments`, and operational
  staff could move appointments or forge `created_by`/`cancelled_by` outside the booking engine.
  Reads with the user's token are unchanged (RLS).
- **Patient communication is written by the server only** too (`20260930000006`):
  `conversations`, `messages`, `voice_messages` and `notification_jobs` have no INSERT/UPDATE/
  DELETE for signed-in roles. Takeover is the server's compare-and-set, an operator reply is
  recorded after Telegram accepted it, reminders are enqueued and claimed by the server. Staff
  cannot upload into the private voice bucket.
- **Every reference stays inside its clinic.** Every foreign key between two clinic-owned tables
  is composite — `(x_id, clinic_id) → parent(id, clinic_id)` — so no row of one clinic can
  point at another clinic's doctor, patient, conversation, appointment, voice message,
  specialty or record, whoever writes it (a structural test fails on any new key that leaves
  `clinic_id` out).
- **SECURITY DEFINER functions** all run with `search_path = public, pg_temp`; none is
  executable by `anon`; trigger functions by nobody; RLS helpers only by signed-in users and the
  server (a catalog test checks all three).

## Secrets

- All secrets live in environment variables; locally in `.env` (gitignored), in production in
  Secret Manager, referenced from Cloud Run with `--set-secrets`.
- `.env.example` / `.env.test.example` are the only committed env files, with placeholders.
- `SUPABASE_SERVICE_ROLE_KEY`, `TELEGRAM_BOT_TOKEN`, `AI_API_KEY`,
  `TELEGRAM_WEBHOOK_SECRET`, `CRON_SECRET` must never be committed or
  exposed to the browser.
- Service role key is only available server-side; browser builds receive only the anon key.
- Production refuses to start when `CRON_SECRET` or `TELEGRAM_WEBHOOK_SECRET` is missing, shorter
  than 32 characters, a placeholder from the docs (`change-me-in-production`,
  `your-random-secret`, …) or one character repeated (`src/instrumentation.ts`).
- Staff accounts created by the owner get a one-time random password (24 characters), shown to
  the owner once and never stored or logged; the member replaces it under *Parolim*, which
  re-checks the current password first.

## API hardening

- `src/proxy.ts` protects `/admin` and `/doctor` routes.
- All routes: input validation with zod (`parseBody` in `src/lib/api/validate`), centralized
  error handling (`handleApiError`) — no stack traces leaked.
- Rate limiting: `src/lib/rate-limit-shared.ts` (counted in Postgres, shared by every instance)
  for the public writes — booking, patient cancellation, Telegram sign-in — and for limits that
  guard clinical data; `src/lib/rate-limit.ts` (in-memory fixed window, per instance, keyed by
  IP) for read-heavy public endpoints (catalog, availability) and as the fallback when the
  database cannot be asked; tests cover both.
- Security headers on every response (HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`), with `frame-ancestors` allowing only Telegram for
  the Mini App routes.
- Voice notes are uploaded to Supabase Storage with clinic-scoped paths and short-lived access.

## Clinical access (doctors)

Working in the same clinic gives a doctor no access to a patient. One decision,
`public.doctor_patient_access(doctor_id, patient_id)`
(`20260927000003_referral_clinical_access.sql`), defines what a doctor may see of one patient:

| Relationship | Condition | Patient record | Appointments |
| --- | --- | --- | --- |
| A — own | an appointment with the patient | yes | the doctor's own |
| B — referred, pending | referral to the doctor, `pending`, `expires_at > now()` | yes | the consultation the referral came from |
| B — referred, accepted | referral to the doctor, `accepted`, `expires_at > now()` | yes | + the patient's visits with the referring doctor |
| C — none | anything else: no relationship, another clinic, declined / revoked / completed / expired referral | no | no |

- Only **active** doctor records backed by the doctor role count — at the database exactly as at the
  API. A referring doctor also sees the follow-up appointment booked for their referral.
- Expiry is compared with `now()` inside the decision, so access ends on time even before the lazy
  sweep marks the referral `expired`. Revoking, declining or completing a referral ends it at once.
- Payments stay limited to the doctor's own appointments; conversations, messages and voice notes
  are never visible to doctors; the referral's reason/note follow the referral's own RLS.
- **Database layer:** the `patients` and `appointments` SELECT policies are split into
  "for operational staff" (owner/admin/manager/receptionist, unchanged) and "for authorized
  doctors", which call `doctor_can_read_patient()` / `doctor_can_read_appointment()`. Those
  resolve the caller with `current_doctor_id(clinic)` (auth.uid() + doctor role) and ask
  `doctor_patient_access()`. The decision function itself is executable by `service_role` only, so
  a doctor cannot probe other doctors' access. Direct REST/SQL access with a doctor's own token
  therefore gets exactly this scope.
- **Server layer:** `canDoctorAccessPatientClinicalData(doctorId, patientId)`
  (`src/lib/clinical-access/access.ts`) calls the same function; `getPatientWorkspace()` and
  `GET /api/doctor/patients/[id]` read only what the decision covers (query filters come from the
  decision, never from the request), answer 404 for everything else, audit every view in strict
  mode (`patient_clinical_record_viewed`) and every refusal (`patient_clinical_access_denied`).
  The referral detail shows the patient's contact details and visit history only while the
  decision allows them. The doctor is always resolved from the session (`requireLinkedDoctor`).
- The server shows exactly what RLS allows: the referral detail's consultation/follow-up and the
  patient record's appointments go through `canSeeAppointment()`, the same rule as
  `doctor_can_read_appointment()` (a parity test compares both layers per doctor).
- Doctors have **no direct write access** to appointments: status changes go through
  `/api/doctor/appointments/[id]` only (forward-only, own appointments), so the REST API can't be
  used to cancel or reopen visits. Referrals are read-only for every signed-in role, and there are
  no server actions — every mutation is a guarded route handler.
- Voice recordings in Storage (`voice-messages` bucket) are readable by operational roles only,
  like the `voice_messages` rows — never by doctors.
- `GET /api/doctor/patients/[id]` is rate limited per doctor (60/min) against id guessing and bulk
  reading — counted in Postgres (`consume_rate_limit()`), so the limit holds across every server
  instance (falls back to the instance's in-memory limit if the database cannot answer).
- **Patient list.** `GET /api/doctor/patients` (`listDoctorPatients()`) lists the doctor's own
  patients (any appointment with them) and those with a pending or accepted, unexpired referral to
  them — the decision's own rule, so every listed patient opens and nobody else of the clinic is
  listed. The `?q=` search filters that list in the server (name or phone digits); it never reaches
  a database query.
- Staff who also hold an operational role keep that role's clinic-wide operational access.

## Clinical records

`clinical_records` (`20260927000005_clinical_records.sql`, types extended in
`20260928000001_clinical_handoff_types.sql`) holds doctor-authored clinical notes, assessments,
diagnoses, prescriptions, laboratory orders and results, medical history and follow-up plans.

- **Provenance can't be forged.** A record belongs to one consultation, and the composite foreign key
  `(appointment_id, clinic_id, patient_id, author_doctor_id) → appointments (id, clinic_id,
  patient_id, doctor_id)` makes that the author's own appointment with this patient in this clinic.
  The consultation must be in progress or completed; `created_by` must be the author's own active
  doctor account; `created_at` is the database clock.
- **Immutable.** No signed-in role may write; the server may only insert (no UPDATE/DELETE grant,
  and a trigger refuses updates even by the table owner). Corrections are new records by the same
  author, in the same consultation and type, one per record (`corrects_record_id`). Records are
  erased only with the patient.
- **Read access = the consultation's access.** RLS uses `doctor_can_read_appointment()`: the author;
  the doctor a patient is referred to, for the referring doctor's records while the referral is
  accepted and unexpired (and the originating consultation's records while it is active); the
  referring doctor, for the records of the follow-up their referral led to. No operational role
  (owner/admin/manager/receptionist) can read records; patient-facing and AI code never touches
  them (guarded by `src/lib/ai/clinical-isolation.test.ts`).
- **Audit without text.** Every insert writes `clinical_record_created` / `clinical_record_corrected`
  with ids and type only; workspace views are logged in strict mode (`patient_clinical_record_viewed`).
- **Server.** `POST /api/doctor/patients/[id]/records` re-checks access and that the consultation is
  the caller's own with the patient in the URL; author, clinic and time are never taken from the
  request; writes are idempotent per key. `POST /api/doctor/patients/[id]/consultations` starts the
  doctor's booked visit for today or books a walk-in through `book_appointment` (own patient, or an
  accepted referral — pending referrals must be accepted first).
- **Nothing silently dropped.** A visible record always arrives with its consultation, even one
  older than the workspace's 100-visit window (fetched by id and re-checked with
  `canSeeAppointment()`).
- **Handoff never rewrites history.** A receiving doctor's assessment or new diagnosis is a new
  record in their own consultation; the referring doctor's diagnosis stays as written, attributed
  to its author and shown as a historical diagnosis. Only a record's own author can correct it
  (the DB refuses anyone else, 409 `correction_not_allowed`).
- **States.** A doctor whose referral for the patient lapsed gets 410 with the reason
  (`referral_revoked`, `referral_expired`, `referral_declined`, `referral_completed`) and no data;
  anyone else gets 404.

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
  access once a referral is declined, revoked or expired, and a completed one at its
  `expires_at` (see [Referral lifecycle and access termination](#referral-lifecycle-and-access-termination)).
- The receiving doctor sees the patient's appointment history with the referring doctor
  (date, service, status — no clinical text) as soon as the referral exists — pending
  included, no accept step to read (owner decision 2026-10-07, `20261007000002`). Starting a
  consultation from a referral still requires accepting it; a walk-in visit registered with
  that doctor needs no acceptance.
- Lifecycle (`20260928000002_clinical_handoff.sql`): `pending → accepted → in_progress →
  completed`, `pending → declined`, `revoked`/`expired` while open. `in_progress` is set by the
  database only — when the receiving doctor's own consultation linked as the follow-up has
  started (linking an already started one, or the linked visit starting from any path), with
  `started_by` = the receiving doctor's account; a trigger failure there never blocks the visit.
  `completed` only from `in_progress` (the API answers 409 `consultation_not_started` before).
  An in-progress referral shares the same history as an accepted one, until completed, revoked
  or expired, and counts as open for the one-open-referral-per-pair rule.
- Audit: `referral_accepted`, `referral_declined`, `referral_in_progress`, `referral_completed`
  (DB trigger, actor = the account on the transition) and `consultation_started` (actor =
  whoever started it: doctor workspace, doctor queue or front desk; with the referral id) —
  ids and statuses only, never the reason, note or record text. The start itself, the link to
  the waiting referral and the `consultation_started` row are one database transaction
  (`start_consultation()` / `start_walk_in_consultation()`, service-role only, compare-and-swap
  on the appointment status): no start without its audit row, no audit row without a start,
  and two concurrent starts start — and audit — once.
- Every detail view is written to `audit_events` (`referral_viewed`, role + whether history was
  shown) in **strict** mode: if the access log cannot be written the view fails (503) instead
  of being served unlogged.
- Status changes use compare-and-swap on the current status (409 on a lost race); the DB trigger
  still enforces the state machine and who may make each transition. Before writing, the server
  checks the action is one the referral's current state offers the caller: a lapsed referral
  answers 410 with the reason, a repeated or out-of-order action 409 — never a silent no-op.
- Reception and management (`/api/admin/patients`) see referral metadata only (doctors, status,
  priority, dates, follow-up appointment) — never the reason or handoff note. Only
  owner/admin/manager can revoke (`/api/admin/referrals/[id]`).
- A follow-up appointment is booked through the transactional booking engine and then linked;
  the DB only accepts it for an accepted, unexpired referral, with the receiving doctor, for the
  referred patient, one active follow-up at a time (a consultation that took place may replace a
  booked follow-up that has not started). If the link loses a race the new appointment
  is cancelled and the request fails (409).

## Referral lifecycle and access termination

`20260929000001_referral_lifecycle_hardening.sql`. One decision, `doctor_patient_access()`,
answers every read (RLS and server); nothing is stored as a grant, so there is nothing to "clean
up" — each read compares the referral's status and `expires_at` with the database clock.

| Referral state | Receiving doctor (B), referral-based | Referring doctor (A), referral-based |
| --- | --- | --- |
| pending, before `expires_at` | patient record; the originating consultation and its records; the referral | — (A's own patient) |
| accepted / in progress, before `expires_at` | + all of A's consultations with the patient and their records | + B's follow-up consultation and its records |
| completed, before `expires_at` | the referral text only — nothing of A's | the outcome: B's follow-up consultation and its records |
| completed, after `expires_at` | nothing | nothing |
| declined / revoked / expired | nothing, from that moment (410 with the reason) | the follow-up ends |

- **Expiry.** Access ends at `expires_at` even before the status says so. `expire_due_referrals()`
  records it (`status = expired`, audit `referral_expired`, actor: system): hourly via
  `POST /api/referrals/expire` (`Authorization: Bearer $CRON_SECRET`, fails closed) and lazily
  whenever referrals are read. Validity is at most 180 days (DB check), 90 by default, and can
  never be extended (the row is immutable outside its transitions).
- **Revocation** (referring doctor, or owner/admin/manager) ends B's referral-based access on the
  next request; there is no cache.
- **Completion** is not a conversion into permanent access: B keeps only what the *own
  relationship* gives any doctor — a live (not cancelled) appointment with the patient, or a
  record they wrote: the patient record, their own appointments and their own records. A
  cancelled booking alone grants nothing.
- **Clinical text is server-only.** Signed-in roles have no SELECT on `referrals` or
  `clinical_records`: every read goes through the API, which authorizes it and writes the access
  log first. The RLS policies remain as a backstop and are tested with a rolled-back grant.

### Referral audit trail

Every event names **actor** (`actor_id`, or `actor_type = system` for expiry), **clinic**,
**patient** (`patient_id`), **referral** (`referral_id`), **action** and **time** (`created_at`,
stamped by the database):

| Action | Written by | When |
| --- | --- | --- |
| `referral_created` / `_accepted` / `_declined` / `_in_progress` / `_completed` / `_revoked` / `_expired` / `_follow_up_booked` | DB trigger | every transition |
| `referral_viewed` (`metadata.via` = `detail` / `list`) | server, strict | the referral's text is returned — one row per referral shown |
| `patient_clinical_record_viewed` | server, strict | a workspace is returned — with the referral it rests on and `shared_record_ids` (records of other doctors released) |
| `patient_clinical_access_denied` | server | a refused patient read — with the lapsed referral, if any |
| `consultation_started` | DB function (`start_consultation`), same transaction as the start | a consultation starts — with the referral it belongs to |
| `clinical_record_created` / `_corrected` | DB trigger | with the referral when written in its consultation |

- **Tenant isolation of the log itself:** read only by the clinic's owner/admin/manager (RLS); a
  row's patient and referral must belong to its clinic (and to each other) or the insert fails;
  append-only — no INSERT/UPDATE/DELETE for signed-in roles, no UPDATE/DELETE for the service
  role. Ids and statuses only, never clinical text.
- Direct reads with a doctor's own token are limited to `patients`/`appointments` (operational
  data, no clinical text) and are not logged per row; clinical text never takes that path.

## Red-team audit of referral-based clinical access (2026-09-27)

Attacks executed, not reviewed: `src/app/api/security/referral-redteam.test.ts` (real routes,
services, decision, triggers and RLS; real signed-in sessions for direct REST/RPC attacks) plus an
HTTP pass against the built app with real logins — `e2e/redteam-http.mjs`, run by CI on every push
(anonymous, forged cookie, default cron secret, receiver, receptionist, manager, referring doctor;
and each account's own token against the database API: clinical text, direct writes, server-only
functions). Covered: another patient's,
doctor's or clinic's id; expired, revoked, completed and declined referrals; forged body fields
(`clinicId`, `patientId`, `authorDoctorId`, `referringDoctorId`, `createdBy`, `created_at`,
`status`); malformed ids and PostgREST filter syntax in URLs; client-state bypasses; server-action
requests; server-rendered pages; unauthenticated, receptionist, manager and other-doctor sessions;
direct REST/RPC with each role's own token; referral laundering (an onward referral passes on the
forwarding doctor's history only).

Found and fixed (each with a regression test that fails if the fix is reverted):

| # | Finding | Fix |
| --- | --- | --- |
| F1 | `/api/doctor/appointments` (queue status, time blocks) used `requireStaff("doctor")`, which ranks owner/admin/manager above doctor: a management account linked to a doctor record could change appointment statuses and time blocks without the doctor role | the doctor role itself is required (same rule as `requireLinkedDoctor`) |
| F2 | Referral actions were not checked against the referral's state before writing: a repeated accept/complete returned 200 as a silent no-op (also on a completed referral past its validity the receiver can no longer see); a repeated revoke/decline surfaced as HTTP 500 | `actOnReferral` / management revoke check the effective status, visibility and allowed actions first: 410 with the reason for a lapsed referral, 409 for a repeated or out-of-order action; DB refusals never map to 500 |
| F3 | Another doctor's appointment id answered 403 `not_yours` on the queue route — confirming it exists | 404, identical to a missing id |
| F4 | Reception's patient search interpolated `q` into a PostgREST `.or()` filter: `,` `(` `)` `.` let a caller inject filter conditions or crash the query (500) | the search text is a quoted literal (`src/lib/api/postgrest.ts`); quote, backslash and `%`/`*` wildcards dropped |
| F5 | (pre-existing, found in the follow-up pass) A manager's own token could `POST /rest/v1/payments` with `status: 'paid'` — the direct-write guard only covered UPDATE | appointments, patients and payments are server-written only: no INSERT/UPDATE/DELETE for signed-in or anonymous roles (`20260930000002`) |
| F6 | (pre-existing) Operational staff tokens could insert or move appointments and edit patients over `/rest/v1` — outside the booking engine, without notifications, with forged `created_by`/`cancelled_by` | same migration; the admin API (service role, after authorization) is the only write path |
| F7 | A consultation's start, its referral link and its `consultation_started` audit row were three requests: a failure in between left a started consultation unaudited, and two concurrent starts audited twice | one transaction with a compare-and-swap on the status (`start_consultation()`, `20260930000001`) |
| F8 | (pre-existing, found when CI first ran the suites on the real Supabase CLI stack) the anon role kept Supabase's default privileges on public tables: an anonymous `GET /rest/v1/patients` returned 200 with an empty RLS result instead of being refused, contrary to 20260813000013's intent | `20260930000004` revokes anon's table and sequence privileges and the default privileges for later tables |

## Audit of every phase (2026-09-27)

A review of phases 0–15 against the code and the live schema. Each finding is fixed with a
regression test (unit, route, database or E2E):

| # | Finding | Fix |
|---|---|---|
| F9 | The `messages` / `voice_messages` insert policies compared `c.clinic_id = c.clinic_id` (always true): staff of one clinic could attach a message to another clinic's conversation | policies removed — patient communication is server-written only; composite foreign keys |
| F10 | Fourteen foreign keys between clinic-owned tables checked only the id: a manager could give another clinic's doctor working hours or time blocks (changing that clinic's availability), point a conversation at another clinic's patient, or a reminder at another clinic's appointment | every such key is `(x_id, clinic_id)`; the migration refuses to run over existing crossing rows |
| F11 | Staff tokens could insert "operator replies" never sent to Telegram, take conversations over outside the compare-and-set, and point a reminder at any Telegram user (`notification_jobs` update policy) | `20260930000006`: no signed-in writes on conversations, messages, voice messages, notification jobs; HTTP red team checks with real sessions |
| F12 | A website booking matched the patient by phone alone and overwrote the name: anyone who knew a number could rename that patient and attach visits — later clinical notes — to their record; a Telegram patient's chat received a stranger's reminders | an unverified booking reuses a record only without a Telegram identity and with the same phone **and** name, never edits one, and otherwise creates its own |
| F13 | Urgent wording was escalated only to the optional platform bot's chats (usually nobody); the conversation was not flagged for the clinic's staff, the AI kept answering, and a held conversation got no urgent-care message | see [Medical safety](#medical-safety-non-security-but-critical) |
| F14 | Voice-button callbacks acted on any voice message of the clinic named in the callback data (which a modified client controls): one patient could consent to transcribing another's recording | the recording must belong to the pressing Telegram user |
| F15 | The privacy page promises voice messages are deleted after the retention period; nothing deleted them | the scheduled job removes audio, transcripts and the Telegram file reference after `expires_at` (`voice_messages.purged_at`) |
| F16 | A patient could cancel a visit already checked in or in progress, or in the past; staff and doctor status changes and payment transitions had no compare-and-set (a webhook and a staff action could both apply); a doctor could move a cancelled visit to "completed" | status-guarded, clinic-scoped compare-and-set everywhere; a payment race test fails without it |
| F17 | Reactivating a cancelled appointment skipped the working-hours and time-block checks | validated like a booking in the slot trigger |
| F18 | Production accepted a one-character `CRON_SECRET` / `TELEGRAM_WEBHOOK_SECRET` | ≥ 32 characters, no placeholders |
| F19 | SECURITY DEFINER functions without `pg_temp` pinned last; `anon` could execute them | search_path and grants normalised (catalog test) |
| F20 | Deleting a clinic failed (audit rows written for the clinic being erased) | the erasure is marked for the transaction; its audit trail goes with it |
| F21 | A second click on reception's walk-in booking could fail with 500 (~1 in 40): the upsert on `id` raced the `(id, clinic_id)` key | plain insert; a duplicate means the attempt's patient already exists |

## Following a visit's queue in Telegram (2026-10-08)

The kassa shows a QR code: a one-time link `t.me/<clinic bot>?start=v_<token>`. It lets a walk-in patient
follow the queue without linking their Telegram to their card (owner decision).
- **The token.**
  - It is 192 random bits.
  - Only its SHA-256 is stored (`visit_follow_tokens`).
  - It is valid 24 hours, claimed once by one Telegram user, and refused once the visit is finished.
  - A new link replaces an unused one.
  - Only reception, the kassa and management can issue one, for their own clinic's visits.
- **A claim** (`claim_visit_follow_token`) is resolved only for the bot the webhook already authenticated. It
  is race-safe: of 8 concurrent claims, exactly 1 wins.
  - Every failure gives the same neutral answer.
  - It creates no patient row and links or merges no identity.
- **What a follower gets** (`visit_followers`): status messages for that one visit — the number, the doctor
  name or "Laboratoriya", how many are ahead, and "you are called".
  - No patient name, record, result or other visit is reachable through it.
  - The worker re-checks that each recipient is still the linked patient or a follower before sending.
- **Access and audit.**
  - Both tables have RLS on, no policies, and no grants to `anon` or `authenticated`.
  - The functions are service-role only and re-check the caller's role.
  - Audit rows carry token and follower ids, never the token, its hash or the Telegram id.

## Retention: the database keeps clinical history (2026-10-08)

Owner decision 2026-10-07 §1: clinical and lab records are kept indefinitely, terminating a clinic keeps its
data, and there is no patient-deletion workflow. `20261008000004_retention_guard` makes the database enforce
it.
- **What is refused:** `DELETE` and `TRUNCATE` on `clinics`, `patients`, `clinical_records` and `referrals`,
  with errcode `42501` and hint `retention`.
  - This applies to every role, including `service_role`.
  - Deleting a clinic or patient was the only way to cascade into appointments, payments and conversations,
    so those are covered too.
- **Already protected:** lab results, values and documents (deletable only during a whole-clinic erase,
  which is now impossible outside tests), visits (`RESTRICT`), the kassa ledger and charges (append-only),
  and the audit trail (no update or delete for the service role).
- **The test-database marker.** A row in `internal.retention_override` lifts the guard so test suites can
  erase what they create. Only `supabase/seed.sql` (local and CI) inserts it.
  - No API role can use the `internal` schema.
  - A test asserts that no migration and not the production setup file insert it.
  - Staging and production must have **0 rows** (runbook pre-flight and monitoring).
- **Limit:** the database owner can disable triggers. The guard stops the application, a leaked service key
  and accidental SQL; it is not a defence against the database owner.

## Medical safety (non-security but critical)

`src/lib/safety/policy.ts`:

- urgency keywords (Uzbek/Russian/English) are checked before any AI: the approved urgent-care
  message goes out — also while an operator holds the conversation — the conversation is flagged
  `urgent_at` with automatic replies stopped, and the clinic's staff see it first in the
  conversation center and on the dashboard until someone takes it over. The patient is told the
  staff were alerted only once that flag is recorded; a confirmed voice transcription is treated
  the same way,
- disallowed claims (diagnosis, prescription, "you don't need a doctor") blocked with
  patterns, e.g. `sizga <dori> kerak`,
- the AI prompt states it is not a doctor and is grounded only in clinic data.

## Audit & monitoring

- `audit_events` records staff mutations, payment transitions, the referral lifecycle and clinical
  access (who/what/when; append-only; see [Referral audit trail](#referral-audit-trail)).
- Structured JSON logs (Cloud Logging in production), `LOG_LEVEL` configurable.
- `GET /api/health` for the load balancer.

## Incident response

1. Roll back the revision (see [rollback.md](rollback.md)).
2. Revoke secrets in Secret Manager if compromise is suspected.
3. Check `audit_events` + Cloud Logging for the incident window.
4. Investigate, patch, deploy. File an issue in this repo.