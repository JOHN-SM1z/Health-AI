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
- `referrals` opts out of those blanket grants: signed-in roles have no SELECT on it at all
  (`20260929000001`; every read goes through the server). The RLS policies stay as a backstop and
  limit a SELECT to the referring doctor and — while the referral is open and unexpired, or once
  they completed it — the receiving doctor; a department referral nobody has taken yet (pending,
  unexpired) is also covered for the doctors of that department, except the doctor who raised it
  (`20261002000001`). Only `service_role` writes (no DELETE for any role; a
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

A patient's clinical history belongs to the patient's record in the clinic, not to one doctor. A
doctor with a legitimate clinical relationship to the patient sees the whole of it — every
doctor's appointments and every clinical record — without asking anyone; a same-clinic doctor
without one sees nothing, and nothing crosses clinics. One decision,
`public.doctor_patient_access(doctor_id, patient_id)`
(`20261002000001_longitudinal_history.sql`, which replaced the per-appointment decision of
`20260927000003`–`20260929000001`), answers it for RLS and for the server. It is `SECURITY DEFINER`,
executable by `service_role` only, and returns one row — `clinic_id`, `own_patient`,
`active_referral_ids`, `full_history` — for an **active doctor-role doctor of the patient's
clinic**, and no row otherwise (another clinic, an inactive doctor, an account without the doctor
role, unknown ids).

| Relationship | Condition | Sees | Ends |
| --- | --- | --- | --- |
| A — treating (`own_patient`) | an appointment of this doctor with the patient whose status is not `cancelled` (past, today or booked) — except a website booking (`source = 'web'`) that is still `pending`, made without any proof of who the visitor is (it counts once staff confirm it; the doctor queue refuses to advance it with 409 `awaiting_confirmation`, so a doctor cannot make it count themselves) — or a clinical record this doctor wrote | the patient's whole history in the clinic | not by time: kept for continuity of care. It lapses only if every such appointment is cancelled and the doctor has written no record (records are never deleted) |
| B — open referral (`active_referral_ids`) | a referral of the patient that is `pending`, `accepted` or `in_progress` with `expires_at > now()`, addressed to this doctor — or, while nobody has taken it (`pending`, no receiving doctor yet), to this doctor's department, unless this doctor raised it | the patient's whole history, from the moment the referral exists | the referral is declined, revoked or completed, or at the latest at `expires_at` (≤ 180 days) — unless A applies |
| C — none | anything else: no relationship, another clinic, an inactive doctor | nothing | — |

- `full_history` = A or B. There is no narrower scope: no per-appointment or per-doctor filtering
  (`history_doctor_ids`, `referral_appointment_ids`, `canSeeAppointment()` and
  `ClinicalAccess.scope` no longer exist) and nothing waits for an acceptance. A referral is a
  clinical handoff, never a permission request: the receiving doctor sees the history while the
  referral is still `pending`, and neither the patient, the referring doctor nor anyone else
  approves it. Accepting is a care step, not a gate.
- **When access ends.** Access that rests only on a referral ends when the referral is declined,
  revoked or completed and, at the latest, at its `expires_at` (≤ 180 days). `expires_at` is
  compared with `now()` inside the decision on every read, so it ends on time even before the lazy
  sweep or the hourly job records the referral as `expired`; nothing is stored as a grant, so there
  is nothing to clean up. A receiving doctor who also holds relationship A keeps the whole history
  when the referral ends — typically because they held their own consultation with the patient
  (which a completed referral rests on) or wrote a record; a doctor whose only link was the
  referral loses everything.
- **The treating relationship is permanent** in the sense above: it has no expiry, and the
  application has no function that withdraws it for one patient (deactivating the doctor's record
  ends all of that doctor's access). That, and the department-wide visibility below, are product
  decisions still open to legal/compliance review (see
  [Open decisions](#open-decisions-longitudinal-access) and `TASKS.md`).
- **Untaken department referrals.** While a department referral is `pending` with no receiving
  doctor, every active doctor of the department sees the patient's whole history — and the
  referral's reason and handoff note, which are part of that history — from the moment it is
  created. The doctor who raised it is never its receiver, also when they belong to the department
  themselves: it is excluded from the decision, the incoming list, the pending-count badge, the
  receiving-doctor RLS policy and the automatic acceptance when a consultation starts. The first
  acceptance names the receiving doctor and the referral leaves the other doctors' lists (see
  [Department referrals](#department-referrals)).
- Only **active** doctor records backed by the doctor role count — at the database exactly as at
  the API.
- Seeing is not owning: every record stays its author's and only the author corrects it (see
  [Clinical records](#clinical-records)).
- **Payments.** Doctors do not read payment rows: the policy "payments read for own doctor" was
  dropped (`20261002000001`), so a doctor's own token gets nothing from `payments`. The server
  shows a doctor only the payment status of the visit in front of them — their own visit in
  progress, or booked for today — never an amount, another visit's status or the patient's payment
  history (`paymentStatusOf()` in `src/lib/clinical-access/workspace.ts` reads `status` only, for
  those two visits). Conversations, messages and voice notes are never visible to doctors; the
  referral's reason and handoff note follow the rules under [Referrals](#referrals).
- **Database layer:** the `patients` and `appointments` SELECT policies are split into
  "for operational staff" (owner/admin/manager/receptionist, unchanged) and "for authorized
  doctors", which call `doctor_can_read_patient()` / `doctor_can_read_appointment()`. Both resolve
  the caller with `current_doctor_id(clinic)` (auth.uid() + doctor role) and ask
  `doctor_patient_access()`: `doctor_can_read_patient()` returns the caller's `full_history`, and
  `doctor_can_read_appointment()` now equals it (its signature is kept so that the policies that
  call it — including the backstop policy on `clinical_records` — did not have to be re-created).
  The decision function itself is executable by `service_role` only, so a doctor cannot probe other
  doctors' access. Direct REST/SQL access with a doctor's own token therefore gets exactly this
  scope — and never clinical text, which signed-in roles cannot SELECT at all.
- **Server layer:** `canDoctorAccessPatientClinicalData(doctorId, patientId)`
  (`src/lib/clinical-access/access.ts`) calls the same function and returns
  `{ relationship: "own" | "referred" | "none", allowed, fullHistory, activeReferralIds }`
  (`"own"` wins when both apply; if the check cannot run the caller gets a 503, never data). The
  two layers mirror each other because there is one decision: `access.test.ts` checks the mapping
  for every combination of the database's verdict, and the database suites run the decision and the
  policies with real signed-in sessions.
- **Patient workspace.** `GET /api/doctor/patients/[id]` (`getPatientWorkspace()`,
  `src/lib/clinical-access/workspace.ts`) returns, after the decision: every doctor's
  appointments (newest first, up to 200, plus any older one a returned record belongs to), the
  current version of every record by every author — each attributed, with a `mine` flag — all of the
  patient's referrals with server-computed `allowedActions` (the doctor's role on each is
  `referrer`, `receiver` or `observer`; an observer reads but can act on nothing), and
  `consultation { current, booked, canStartWalkIn, services }` with the `paymentStatus` of the
  doctor's own visit only. Everything else answers 404 — or 410 with the reason
  (`referral_revoked`, `referral_expired`, `referral_declined`, `referral_completed`) when the
  doctor's own referral for this patient lapsed and nothing else gives them access. Every view is
  audited in strict mode (`clinical_record_viewed`) and every refusal too
  (`unauthorized_clinical_access_attempt`); see [Audit event names](#audit-event-names). The doctor
  is always resolved from the session (`requireLinkedDoctor`), never from the request.
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
  patients (any appointment with them that is not cancelled, or a record they wrote) and those with
  an open, unexpired referral to them (`pending`, `accepted` or `in_progress`, including an untaken
  referral to their department other than one they raised) — the decision's own rule, so every
  listed patient opens and nobody else of the clinic is listed. The `?q=` search filters that list
  in the server (name or phone digits); it never reaches a database query.
- Staff who also hold an operational role keep that role's clinic-wide operational access.

### Open decisions (longitudinal access)

Not settled by this document or by the code, and not to be read as a statement that any of it
satisfies a legal or regulatory requirement — they are for the clinic's legal/compliance review
before production use (tracked in `TASKS.md`):

- who may see a patient's whole history, and for how long — in particular that a treating
  relationship, once it exists, lasts;
- that every active doctor of a department sees the history of a patient referred to the
  department while nobody has taken the referral;
- the patient-facing wording of `/privacy` §3 and §5, which describes this model.

## Clinical records

`clinical_records` (`20260927000005_clinical_records.sql`, types extended in
`20260928000001_clinical_handoff_types.sql`) holds doctor-authored clinical notes, assessments,
diagnoses, prescriptions, laboratory orders and results, medical history and follow-up plans. They
belong to the patient's longitudinal record in the clinic: a doctor the
[clinical access decision](#clinical-access-doctors) gives the patient's history reads every doctor's
records, and only the author changes their own.

- **Provenance can't be forged.** A record belongs to one consultation, and the composite foreign key
  `(appointment_id, clinic_id, patient_id, author_doctor_id) → appointments (id, clinic_id,
  patient_id, doctor_id)` makes that the author's own appointment with this patient in this clinic.
  The consultation must be in progress or completed; `created_by` must be the author's own active
  doctor account; `created_at` is the database clock.
- **Append-only, versioned, author-only** (`20261001000001_clinical_record_governance.sql`). No
  signed-in role may write; the server may only insert (no UPDATE/DELETE grant, and a trigger
  refuses updates even by the table owner). A correction is the record's next version: a new row
  in the same consultation and type pointing at the version it replaces (`corrects_record_id`),
  with `version` and the lineage (`root_record_id`) set by the database. Only the author may
  correct — the same doctor record AND the same login (`created_by`), so re-linking a doctor
  record to another account hands nothing over (SQLSTATE `CRNOT`) — and a doctor record holding records
  another login wrote can't be re-linked at all (`CRLNK`; the admin route answers 409
  `doctor_has_clinical_records`: a new doctor gets a new doctor record). Only the current version can be
  corrected (`CRVER`; two concurrent corrections can't both land — unique indexes on
  `corrects_record_id` and `(root_record_id, version)`). Earlier versions stay, superseded, in
  `clinical_record_versions` (status `current` / `superseded`; service role only).
- **Never erased with the patient.** The foreign keys from `clinical_records`, `referrals`,
  `appointments` and `payments` to `patients` are NO ACTION: a patient who still has any of them
  cannot be deleted, while deleting a whole clinic (which removes them in the same statement) still
  works. (A payment still belongs to its appointment: deleting an appointment — which the application
  never does — removes its payment; conversations still follow the patient.) There is no
  anonymisation path for patient identity yet. Retention per data category is recorded in `retention_policies` (service role only),
  which is empty — no period is assumed and nothing is deleted or anonymised on its basis yet.
- **Read access = the patient's history access.** Signed-in roles have no SELECT on
  `clinical_records` (`20260929000001`): every read goes through the server, which authorizes it with
  the clinical access decision and audits it. The backstop RLS policy uses
  `doctor_can_read_appointment()`, which now equals `doctor_can_read_patient()`: a doctor with a
  treating relationship or an open referral (to them, or untaken to their department) reads every
  doctor's records — from the moment a referral exists, with no acceptance and no per-consultation
  scope; a doctor without one reads none. No operational role (owner/admin/manager/receptionist)
  can read records; patient-facing and AI code never touches them (guarded by
  `src/lib/ai/clinical-isolation.test.ts`).
- **Audit without text.** Every insert writes `clinical_record_created` /
  `clinical_record_version_created` (a correction) with ids, type and version only — a correction's
  `old_values` name the version it replaced and its author. Workspace views and version-history
  reads are logged in strict mode as `clinical_record_viewed` (the relationship the access rests on,
  the referral ids and, for the workspace, which records of other authors were shown — ids only), a
  refused patient or history read as `unauthorized_clinical_access_attempt`, and a refused
  correction or write as `unauthorized_clinical_mutation_attempt` (reason `not_owned` / `not_found`
  / `not_own_consultation`). `clinical_record_updated` is never written: records are never updated.
  See [Audit event names](#audit-event-names) for the earlier names.
- **Server.** `POST /api/doctor/patients/[id]/records` re-checks access and that the consultation is
  the caller's own with the patient in the URL; author, clinic and time are never taken from the
  request; writes are idempotent per key. `POST …/records/[recordId]/corrections` (or `correctsRecordId`
  on the records route) checks, before the database does, that the record is visible (else 404
  `record_not_found`), the caller's own (else 403 `CLINICAL_RECORD_NOT_OWNED`) and still the version
  the doctor saw (`expectedVersion`; else 409 `VERSION_CONFLICT` with the current version) — no
  reason is asked for. `GET …/records/[recordId]/history` returns every version, read-only. The
  workspace lists only each record's current version. `POST /api/doctor/patients/[id]/consultations` starts the
  doctor's booked visit for today or books a walk-in through `book_appointment` for any doctor the
  decision gives access (own patient, or an open referral). A pending referral to the doctor — or an
  untaken one to their department — is accepted automatically first (a department referral is thereby
  taken by this doctor), and the started consultation becomes the referral's follow-up with the
  referral moving to `in_progress`; nothing has to be accepted by hand before starting. The doctor's
  own start — from the patient's page or from the doctor queue — is one database transaction
  (`start_consultation` / `start_walk_in_consultation`): it takes a lock on the doctor's open referrals
  and **re-checks `doctor_patient_access()` inside the transaction** (`access_lost` answers 404/410 like
  any refused patient read, and writes nothing), and it does the accept there too — the doctor's own
  named referral before an untaken department one, one the database refuses skipped — so a start that
  fails (a taken slot, a refused booking) accepts nothing, and a revoke or claim racing the start is
  either seen or waits for it.
- **Nothing silently dropped.** A record always arrives with its consultation, even one older than
  the workspace's 200-visit window (fetched by id).
- **Handoff never rewrites history.** A receiving doctor's assessment or new diagnosis is a new
  record in their own consultation; the referring doctor's diagnosis stays as written, attributed
  to its author and shown as a historical diagnosis. Only a record's own author can correct it
  (403 `CLINICAL_RECORD_NOT_OWNED`; the DB refuses anyone else too).
- **States.** A doctor whose own referral for the patient lapsed and who has no other relationship
  gets 410 with the reason (`referral_revoked`, `referral_expired`, `referral_declined`,
  `referral_completed`) and no data; anyone else gets 404. A lapsed referral changes nothing for a
  doctor who still has a treating relationship.

## Referrals

- Doctor endpoints (`/api/doctor/referrals/...`) use `requireLinkedDoctor()`: the caller must
  hold the exact `doctor` role *and* be linked to an active doctor record in the same clinic.
  Owner/admin/manager accounts linked to a doctor record are refused (403) — management never
  reads referral clinical text through the doctor portal.
- A doctor may only refer from their own consultation (`in_progress` / `completed`
  appointment); the patient and clinic come from that appointment, never from the browser
  (unknown request fields are stripped by the zod schema).
- A referral goes to a doctor, to a department (a specialty) or to both — at least one
  (`referrals_recipient_check`; the API answers 400 otherwise), and a named doctor must belong to a
  named department (400 `doctor_not_in_department`). The recipient is checked server-side before
  anything is written: a doctor record in the caller's clinic (otherwise 404, the same answer as for
  an id that exists nowhere), active, linked to an account holding the doctor role, not the caller;
  a department of the caller's clinic that has at least one such doctor other than the caller
  (otherwise 404 `department_not_found`). The DB trigger and the composite foreign keys (including
  `(referred_to_specialty_id, clinic_id)`) enforce the same rules again on insert.
- Creation is idempotent: every request carries `idempotencyKey` (a UUID generated when the
  doctor opens the review step), stored as `referrals.creation_key`, unique per referring doctor
  and immutable. A repeat — sequential or concurrent — returns the referral already created
  (200, `replayed: true`) without writing anything, so `referral_created` is audited once; the
  same key with different content is refused (409 `idempotency_key_reused`). The key is never
  copied into `audit_events`.
- Non-parties get 404 (not 403) on a referral's own endpoints, so referral ids cannot be probed. The
  receiving doctor loses the referral once it is declined, revoked or expired, and a completed one
  at its `expires_at` (see
  [Referral lifecycle and access termination](#referral-lifecycle-and-access-termination)).
- The referral hands the patient's history over from the moment it exists — no acceptance is
  needed. Its detail (`GET /api/doctor/referrals/[id]`) shows the patient's contact details and
  their 20 most recent visits (every doctor's; date, service, status — no clinical text) while the
  clinical access decision allows them, and nothing of the patient beyond the name once it does not.
  A doctor who reads the patient's history without being on a referral is an `observer` in the
  workspace: they read the patient's referrals — reason and handoff note included, as part of the
  history — but cannot open a referral's own page or act on it.
- Lifecycle (`20260928000002_clinical_handoff.sql`): `pending → accepted → in_progress →
  completed`, `pending → declined`, `revoked`/`expired` while open. `in_progress` is set by the
  database only — when the receiving doctor's own consultation linked as the follow-up has
  started (linking an already started one, or the linked visit starting from any path), with
  `started_by` = the receiving doctor's account; a trigger failure there never blocks the visit.
  `completed` only from `in_progress` (the API answers 409 `consultation_not_started` before).
  An in-progress referral counts as open for the one-open-referral-per-pair (named doctor) and
  one-open-referral-per-department (untaken) rules.
- Audit: `referral_accepted`, `referral_declined`, `referral_in_progress`, `referral_completed`
  (DB trigger, actor = the account on the transition) and `consultation_started` (actor =
  whoever started it: doctor workspace, doctor queue or front desk; with the referral id) —
  ids and statuses only, never the reason, note or record text. The start itself, the link to
  the waiting referral and the `consultation_started` row are one database transaction
  (`start_consultation()` / `start_walk_in_consultation()`, service-role only, compare-and-swap
  on the appointment status): no start without its audit row, no audit row without a start,
  and two concurrent starts start — and audit — once.
- Every detail view is written to `audit_events` as `referral_opened` (role, status, the
  relationship the access rests on and whether history was shown) in **strict** mode: if the access
  log cannot be written the view fails (503) instead of being served unlogged. Lists write one
  `referral_viewed` row per referral shown, also strict.
- Status changes use compare-and-swap on the current status (409 on a lost race); the DB trigger
  still enforces the state machine and who may make each transition. Before writing, the server
  checks the action is one the referral's current state offers the caller: a lapsed referral
  answers 410 with the reason, a repeated or out-of-order action 409 — never a silent no-op.
- Reception and management (`/api/admin/patients`) see referral metadata only (doctors, department,
  status, priority, dates, follow-up appointment) — never the reason or handoff note. Only
  owner/admin/manager can revoke (`/api/admin/referrals/[id]`).
- A follow-up appointment is booked through the transactional booking engine and then linked;
  the DB only accepts it for an accepted, unexpired referral, with the receiving doctor, for the
  referred patient, one active follow-up at a time (a consultation that took place may replace a
  booked follow-up that has not started). If the link loses a race the new appointment
  is cancelled and the request fails (409).

### Department referrals

`20261002000001_longitudinal_history.sql`. `referrals.referred_to_doctor_id` is nullable and
`referrals.referred_to_specialty_id` names the department; `referrals_recipient_check` requires at
least one of them. A referral to a department alone is *untaken* until one of its doctors accepts it.

- **Who receives it.** While it is `pending` and untaken, every active doctor-role doctor of the
  department — except the doctor who raised it — has it in their incoming list and pending-count
  badge (role `receiver`, allowed action `accept` only) and has the patient's whole history. The
  same rule is applied in the decision, the server queries and the receiving-doctor RLS policy.
  A doctor referring to their own department is not its receiver: the other department doctors
  are. Doctors of other departments, of no department, and of other clinics — also a department of
  the same name — see nothing.
- **Nobody can decline it for the others.** The database refuses declining, starting or completing
  an untaken department referral; only accepting, and revoking, exist.
- **The first acceptance takes it.** Accepting — by hand (`PATCH /api/doctor/referrals/[id]`) or
  automatically when the doctor starts a consultation with the patient — sets
  `referred_to_doctor_id` to the accepting doctor's record in the same compare-and-swap update.
  The trigger allows a receiving doctor to be named only by that `pending → accepted` transition and
  only for a doctor of the department who is not the referring doctor or the referring account. A
  concurrent second acceptance loses the compare-and-swap (409 `referral_changed`). The referral
  then leaves the other doctors' lists and badges; their access that rested on it ends, unless they
  hold a treating relationship. The acceptance is audited as the accepting doctor
  (`referral_accepted`, `old_values.referred_to_doctor_id` null), with the department in `new_values`.
- **Revocation and expiry** work as for a named doctor: the referring doctor or owner/admin/manager
  revoke it, and every department doctor loses it at once; `expires_at` (≤ 180 days) bounds it.
- **One open referral** per patient, referring doctor and department while untaken
  (`referrals_one_open_per_department`); `referrals_one_open_per_pair` covers named doctors.
- **No doctor to take it.** Creating a department referral is refused (404) for a department
  without another active doctor; nothing re-checks it afterwards. If the department later has no
  active doctor, the referral simply stays `pending`, seen by nobody, until it is revoked or
  expires.

## Referral lifecycle and access termination

`20260929000001_referral_lifecycle_hardening.sql`, with the access decision replaced by
`20261002000001_longitudinal_history.sql`. One decision, `doctor_patient_access()`, answers every
read (RLS and server); nothing is stored as a grant, so there is nothing to "clean up" — each read
compares the referral's status and `expires_at` with the database clock.

| Referral state | Receiving doctor (B) — referral-based access | Other doctors of the department, while untaken | Referring doctor (A) |
| --- | --- | --- | --- |
| `pending`, before `expires_at` | the patient's whole history, and the referral | the same, and the referral | own relationship, unchanged |
| `accepted` / `in_progress`, before `expires_at` | the patient's whole history, and the referral | — it is taken: no longer theirs | own relationship, unchanged |
| `completed`, before `expires_at` | the referral text only; the history only through B's own relationship (the consultation B held) | — | own relationship; the referral stays readable |
| `completed`, after `expires_at` | nothing of the referral; the history only through B's own relationship | — | own relationship |
| `declined` / `revoked` / `expired` | nothing from that moment through the referral (410 with the reason); the history only through B's own relationship | lose it at once (revoked / expired) | own relationship; the referral stays readable |

"Own relationship" is relationship A of the [decision](#clinical-access-doctors): a non-cancelled
appointment with the patient or a record the doctor wrote. A referral is raised from the
referring doctor's own consultation, so the referring doctor normally holds relationship A
throughout.

- **Expiry.** Access ends at `expires_at` even before the status says so. `expire_due_referrals()`
  records it (`status = expired`, audit `referral_expired`, actor: system): hourly via
  `POST /api/referrals/expire` (`Authorization: Bearer $CRON_SECRET`, fails closed) and lazily
  whenever referrals are read. Validity is at most 180 days (DB check), 90 by default, and can
  never be extended (the row is immutable outside its transitions).
- **Revocation** (referring doctor, or owner/admin/manager) ends the referral-based access of B —
  and of every department doctor for an untaken referral — on the next request; there is no cache.
- **Completion** is not a conversion into a referral-based access: what B keeps afterwards is what
  the *own relationship* gives any doctor. A referral is completed only after B's consultation
  started, so B normally has one — the whole history stays with B through it. A receiving doctor
  whose referral was declined or revoked, or expired, before they saw the patient has no
  relationship and loses everything. A cancelled booking alone grants nothing.
- **Clinical text is server-only.** Signed-in roles have no SELECT on `referrals` or
  `clinical_records`: every read goes through the API, which authorizes it and writes the access
  log first. The RLS policies remain as a backstop and are tested with a rolled-back grant.

### Referral audit trail

Every event names **actor** (`actor_id`, or `actor_type = system` for expiry), **clinic**,
**patient** (`patient_id`), **referral** (`referral_id`), **action** and **time** (`created_at`,
stamped by the database):

| Action | Written by | When |
| --- | --- | --- |
| `referral_created` / `_accepted` / `_declined` / `_in_progress` / `_completed` / `_revoked` / `_expired` / `_follow_up_booked` | DB trigger | every transition; the department is in `new_values`, and accepting an untaken department referral is audited as the accepting doctor with the previous (empty) receiving doctor in `old_values` |
| `referral_opened` (`metadata.via` = `detail`; role, status, relationship, `history_shared`) | server, strict | one referral's detail is returned |
| `referral_viewed` (`metadata.via` = `list`; box, role, status) | server, strict | a list returns referral text — one row per referral shown |
| `clinical_record_viewed` (`metadata.via` = `workspace` or `history`) | server, strict | a workspace is returned — with the relationship the access rests on, the open referral ids, the ids of the records shown and of those written by other doctors (`referral_id` when exactly one referral) — or a record's version history is returned |
| `unauthorized_clinical_access_attempt` | server, strict | a refused patient read — with the lapsed referral, if any — or a refused version-history read |
| `unauthorized_clinical_mutation_attempt` | server, strict | a refused correction or write (`reason` = `not_owned` / `not_found` / `not_own_consultation`) |
| `consultation_started` | DB function (`start_consultation`), same transaction as the start | a consultation starts — with the referral it belongs to |
| `clinical_record_created` / `clinical_record_version_created` | DB trigger | with the referral when written in its consultation; a correction (the new version) names the version it replaced |

`clinical_record_updated` is never written: a record is never updated, a correction is a new version.

- **Tenant isolation of the log itself:** read only by the clinic's owner/admin/manager (RLS); a
  row's patient and referral must belong to its clinic (and to each other) or the insert fails;
  append-only — no INSERT/UPDATE/DELETE for signed-in roles, no UPDATE/DELETE for the service
  role. Ids and statuses only, never clinical text.
- Direct reads with a doctor's own token are limited to `patients`/`appointments` (operational
  data, no clinical text) and are not logged per row; clinical text never takes that path.

### Audit event names

The clinical audit actions were renamed with `20261002000001_longitudinal_history.sql`. Rows written
before that migration keep their old names, so an audit query or report that spans it must match
**both** names:

| Old name | New name | Notes |
| --- | --- | --- |
| `patient_clinical_record_viewed` | `clinical_record_viewed` | workspace view (`metadata.via` = `workspace`) |
| `clinical_record_history_viewed` | `clinical_record_viewed` | version-history read (`metadata.via` = `history`) |
| `clinical_record_accessed_via_referral` | — (no longer written) | folded into `clinical_record_viewed`: the workspace/history view records the relationship, the referral ids and the ids of other authors' records |
| `patient_clinical_access_denied` | `unauthorized_clinical_access_attempt` | a refused patient read; also a refused version-history read |
| `clinical_record_access_denied` | `unauthorized_clinical_mutation_attempt` | a refused correction or write (`reason` = `not_owned` / `not_found` / `not_own_consultation`; `not_visible` no longer exists). A refused history read is now `unauthorized_clinical_access_attempt` |
| `clinical_record_corrected` | `clinical_record_version_created` | written by the DB trigger for a correction |
| `referral_viewed` (`metadata.via` = `detail`) | `referral_opened` | the detail view; list views keep `referral_viewed` |

Unchanged: `clinical_record_created`, `referral_created` / `_accepted` / `_declined` / `_in_progress`
/ `_completed` / `_revoked` / `_expired` / `_follow_up_booked`, `consultation_started`.

## Patient identity and registration

One patient, one record: registration looks a returning patient up before it creates one, and never
overwrites an existing patient's identity from input nobody verified — the record may already hold a
clinical history.

- **`patients.phone_normalized`** (`20261002000001`) is a *generated* column
  (`public.normalize_phone(phone)`: digits only; a national number — 9 digits, or 10 with a leading 8 or 0 — gets the `998` prefix, a leading `00` before `998` is dropped; no digits
  gives NULL), indexed per clinic and **not unique** — two people can share a phone. It cannot be
  written directly, not even by the service role. `src/lib/patients/phone.ts` implements the same
  rule for the server's lookups, and a test compares the two on every input. The rule assumes Uzbek
  numbers (see `TASKS.md`).
- **Reception** (`POST /api/admin/appointments`, owner/admin/manager/receptionist only): with no
  `patientId` and no `confirmNewPatient`, a patient of the same clinic with the same normalized
  phone answers 409 `possible_duplicate` with `details.candidates` (`id`, `fullName`, `phone`), before
  the doctor, service or slot is validated and before anything is created (a registration without a
  phone has nothing to match). An idempotent retry of the
  same attempt does not match the patient it created itself. `confirmNewPatient: true` registers a
  new patient anyway (the "different person" path); `patientId` books the existing patient and their
  record keeps its own name and phone whatever the form still holds. Patients of other clinics are
  never candidates. A patient a request registered is deleted again if its booking fails (nothing
  references it; any other row would make the delete refuse, never cascade).
- **Reception search** (`GET /api/admin/patients?q=`) also matches `phone_normalized` when the query
  has at least 5 digits, so a number typed any way finds the patient; the search text is a quoted
  literal, never filter syntax.
- **Website booking** (`getOrCreateWebPatient`) finds the patient by `phone_normalized`, and reuses
  the record only if it has no Telegram identity and the name matches; otherwise it creates its own
  record and never edits an existing one (F12).
- **Mini App booking** (`POST /api/bookings`) resolves the patient from the verified Telegram identity
  and fills name and phone only while they are empty — it never overwrites an existing record's.
- **Known limits.** Patient creation is not audited. A Telegram patient is keyed by their verified
  Telegram identity, not by phone, so one who shares a phone with a record reception registered is
  a separate record until someone merges them — there is no merge tool yet. Nothing in this
  section changes deletion: a patient with clinical, referral, booking or payment rows is still not
  deleted (see [Clinical records](#clinical-records)).

## Red-team audit of referral-based clinical access (2026-09-27)

A point-in-time record: the findings below were made against the earlier per-appointment access
model. The suite (`src/app/api/security/referral-redteam.test.ts`) was rewritten for the current
model — a whole-history decision, department referrals — and runs the attacks against it, including
another department's doctor, another clinic's department of the same name, an observer, and forging
the claiming doctor of a department referral (attacks 21–24); the HTTP pass was adjusted to it.

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
| F12 | A website booking matched the patient by phone alone and overwrote the name: anyone who knew a number could rename that patient and attach visits — later clinical notes — to their record; a Telegram patient's chat received a stranger's reminders | an unverified booking reuses a record only without a Telegram identity and with the same phone (compared normalized) **and** name, never edits one, and otherwise creates its own; and an unconfirmed website booking never gives the booked doctor a treating relationship, so it cannot open the patient's history (`doctor_patient_access()` ignores `source = 'web'` while `pending`) |
| F13 | Urgent wording was escalated only to the optional platform bot's chats (usually nobody); the conversation was not flagged for the clinic's staff, the AI kept answering, and a held conversation got no urgent-care message | see [Medical safety](#medical-safety-non-security-but-critical) |
| F14 | Voice-button callbacks acted on any voice message of the clinic named in the callback data (which a modified client controls): one patient could consent to transcribing another's recording | the recording must belong to the pressing Telegram user |
| F15 | The privacy page promises voice messages are deleted after the retention period; nothing deleted them | the scheduled job removes audio, transcripts and the Telegram file reference after `expires_at` (`voice_messages.purged_at`) |
| F16 | A patient could cancel a visit already checked in or in progress, or in the past; staff and doctor status changes and payment transitions had no compare-and-set (a webhook and a staff action could both apply); a doctor could move a cancelled visit to "completed" | status-guarded, clinic-scoped compare-and-set everywhere; a payment race test fails without it |
| F17 | Reactivating a cancelled appointment skipped the working-hours and time-block checks | validated like a booking in the slot trigger |
| F18 | Production accepted a one-character `CRON_SECRET` / `TELEGRAM_WEBHOOK_SECRET` | ≥ 32 characters, no placeholders |
| F19 | SECURITY DEFINER functions without `pg_temp` pinned last; `anon` could execute them | search_path and grants normalised (catalog test) |
| F20 | Deleting a clinic failed (audit rows written for the clinic being erased) | the erasure is marked for the transaction; its audit trail goes with it |
| F21 | A second click on reception's walk-in booking could fail with 500 (~1 in 40): the upsert on `id` raced the `(id, clinic_id)` key | plain insert; a duplicate means the attempt's patient already exists |

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
  access (who/what/when; append-only; see [Referral audit trail](#referral-audit-trail)). The
  clinical action names changed with `20261002000001`; rows written before it keep the old names
  (see [Audit event names](#audit-event-names)).
- Structured JSON logs (Cloud Logging in production), `LOG_LEVEL` configurable.
- `GET /api/health` for the load balancer.

## Incident response

1. Roll back the revision (see [rollback.md](rollback.md)).
2. Revoke secrets in Secret Manager if compromise is suspected.
3. Check `audit_events` + Cloud Logging for the incident window.
4. Investigate, patch, deploy. File an issue in this repo.