# Architecture

## System diagram

```
Patient (Telegram)                      Clinic staff (browser)
┌──────────────────────┐               ┌──────────────────────┐
│ Telegram bot (chat)  │               │ /admin  admin panel   │
│ Mini App (WebApp)    │               │ /doctor doctor panel  │
└──────────┬───────────┘               └──────────┬───────────┘
           │                                      │
           │ Telegram Bot API                     │ Supabase Auth (email/password)
           ▼                                      ▼
┌────────────────────────────────────────────────────────────────────┐
│                    Next.js on Cloud Run (Docker)                    │
│                                                                     │
│  /api/telegram/webhook   webhook → handlers (messages, callback,   │
│                           voice, pre-checkout, mini-app messages)   │
│  /api/telegram/auth      Mini App initData verification             │
│  /api/availability       free slots                                  │
│  /api/bookings           create / my-bookings / cancel              │
│  /api/catalog            public clinic catalog                      │
│  /api/admin/...          staff mutations (role-checked)             │
│  /api/doctor/...         doctor self-service                        │
│  /api/notifications/process  Cloud Scheduler cron → send due jobs   │
│  /api/referrals/expire   Cloud Scheduler cron → record expiries     │
│                                                                     │
│  lib/telegram · lib/ai · lib/booking · lib/payments · lib/safety   │
└──────┬───────────────────────────┬─────────────────────────┬────────┘
       │ service role (server)     │ authenticated (staff)   │
       ▼                           ▼                         ▼
┌─────────────────────┐   ┌──────────────────┐   ┌───────────────────┐
│ Supabase Postgres   │   │ Supabase Storage │   │ AI provider       │
│ RLS + functions +   │   │ voice notes      │   │ chat-completions  │
│ triggers            │   └──────────────────┘   │ transcription     │
└─────────────────────┘                          └───────────────────┘
```

## Data model (public schema)

- **clinics** — tenant root; most tables carry `clinic_id` (RLS isolation). Every foreign key
  between two clinic-owned tables includes `clinic_id` (composite), so a row can only point
  inside its own clinic
- **profiles + staff_roles** — staff accounts (Supabase Auth user ↔ profile; one role per person
  per clinic: owner/admin/manager/receptionist/doctor), managed by the owner under *Xodimlar*
- **patients** — Telegram-identified (telegram_user_id, verified initData) with consent flag; a
  website booking (no verified identity) reuses a record only without a Telegram identity and
  with the same phone and name, and never edits one. `phone_normalized` (generated from `phone`,
  indexed per clinic, not unique) is how a returning patient is found before a new record is
  created (see [Registration and patient identity](#registration-and-patient-identity))
- **specialties / services / doctors / doctor_services / doctor_working_hours / doctor_time_blocks** — clinic catalog
- **appointments** — status machine (`pending → confirmed → checked_in → in_progress → completed`, `cancelled`, `no_show`), **exclusion constraint** `no_overlapping_active_appointments` prevents double-booking at DB level
- **payments** — linked to appointment, status machine with audit trail
- **referrals** — referral within one clinic to a doctor, to a department (a specialty) or to both,
  raised from the consultation (the appointment in which the referring doctor saw the patient);
  `referred_to_doctor_id` is nullable while a department referral is untaken and
  `referrals_recipient_check` needs a doctor or a department; composite foreign keys keep the
  patient, the doctors, the department and that appointment inside the referral's clinic; status machine
  `pending → accepted → in_progress → completed` (or `declined` / `revoked` / `expired`)
  enforced by trigger for every writer; audited without its clinical text (reason, handoff note);
  linked to the receiving doctor's consultation for it (`follow_up_appointment_id`, booked by
  reception or started by the doctor) — the referral is in progress once that consultation starts
- **clinical_records** — doctor-authored clinical notes, assessments, diagnoses, prescriptions,
  lab orders and results, medical history and follow-up plans; each tied to the author's own consultation (composite FK),
  append-only and versioned (only the author corrects, as the next version; earlier versions kept in
  `clinical_record_versions`), never erased with the patient, part of the patient's longitudinal record:
  read by doctors the access decision gives the patient's history, only through the server (see
  [security.md](security.md#clinical-records))
- **retention_policies** — per clinic and data category, the retention rule a confirmed policy sets; empty — nothing
  is deleted or anonymised on its basis yet
- **conversations / messages / voice_messages** — chat history, admin takeover support,
  `conversations.urgent_at` (urgent wording nobody has taken over yet), `voice_messages.purged_at`
  (audio and transcripts removed after retention); written by the server only
- **faq_entries / app_settings** — clinic content and settings
- **notification_jobs** — reminders/confirmations queue, sent by cron
- **processed_webhooks** — Telegram webhook idempotency
- **audit_events / analytics_events** — audit log and usage analytics

## Booking engine (double-booking protection)

**Invariant:** for any clinic, doctor and conflicting time interval, the database holds at most
ONE active appointment — whichever channel created it.

```
Mini App / bot deep link ─┐                                        ┌─ SUCCESS (201; 200 on an
Website (/book) ──────────┤→ POST /api/bookings ─────────┐          │   idempotent replay)
Reception / admin ────────┤→ POST /api/admin/appointments ┤→ createAppointment() (src/lib/booking/engine.ts)
Doctor's walk-in ─────────┘→ start_walk_in_consultation ──┘      → book_appointment()  ──┤
                                                                   → exclusion constraint └─ SLOT_UNAVAILABLE (409) …
```

- **The guarantee is a constraint.** `no_overlapping_active_appointments`:
  `EXCLUDE USING gist (clinic_id WITH =, doctor_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&)
  WHERE status NOT IN ('cancelled', 'no_show')`. Postgres checks it on every INSERT and UPDATE by
  every role; of two concurrent writers the second waits for the first and is refused (23P01).
  Durations vary (service duration or the doctor's override), so conflicts are interval overlaps:
  14:00–14:30 and 14:15–14:45 conflict; 14:00–14:30 and 14:30–15:00 do not.
- **Active** = every status except `cancelled` and `no_show` (they release the time); `completed`
  keeps it.
- **One operation.** `book_appointment()` validates clinic, doctor, service (and the doctor's
  service list), patient — all of the clinic — then the time (future, inside one working-hour
  window of its own local day in the clinic's timezone, no time block), takes an advisory lock per
  clinic+doctor, re-checks, and inserts appointment + payment in one transaction. End time and
  price come from the database, never the caller. A conflict found by the constraint (any race the
  lock does not cover) returns `slot_taken`, not an error.
- **Idempotency.** Each booking attempt carries a client-generated `idempotencyKey` (unique per
  clinic): a retry — double click, network retry, reconnect — returns the first attempt's
  appointment (`replayed`) instead of a second one; the same key for another booking is refused.
  Reception walk-in patients get an id derived from the key, so a retry creates no second patient.
- **Availability is a hint.** `GET /api/availability` reserves nothing; the booking decides. The Mini
  App answers `SLOT_UNAVAILABLE` by reloading availability; reception sees it in the open modal.
- **Rescheduling** — `reschedule_appointment(p_clinic_id, …)`: clinic-scoped, same lock, row lock,
  same checks; the appointment never conflicts with itself. **Cancelling** sets `cancelled`, which
  releases the time; reactivating it over a newer booking is refused (`SLOT_UNAVAILABLE`).
- **Tenancy is structural.** Composite foreign keys tie an appointment's doctor, patient and service
  to the appointment's own clinic; the same time in another clinic is never a conflict.
- **Error contract** (booking endpoints): `SLOT_UNAVAILABLE` 409, `INVALID_TIME` / `INVALID_DOCTOR` /
  `INVALID_PATIENT` / `INVALID_SERVICE` / `INVALID_CLINIC` 422, `IDEMPOTENCY_KEY_REUSED` 409,
  `APPOINTMENT_NOT_FOUND` 404, `NOT_RESCHEDULABLE` 409, `SERVER_ERROR` 500 — `{ error, code,
  details: { reason } }`; authentication stays 401/403. Database errors are never returned.
- **Timezone.** Instants are `timestamptz`; the API takes ISO 8601 with an offset. Reception picks
  the clinic's wall-clock time (`startLocal`), converted on the server in `clinics.timezone` —
  never the browser's. Working hours are applied in Postgres with the clinic's IANA zone (DST
  included where a zone has it; Asia/Tashkent has none).

## Referral workflow

A referral is a clinical handoff between doctors of one clinic — to a colleague, to a department, or
to both — raised from the referring doctor's own consultation. It is never a permission request: the
receiving doctor sees the patient's history from the moment it exists.

1. **Refer** — Doctor A opens *Yo‘llanma* on their own `in_progress` or `completed` consultation
   (`/doctor` today's queue, or the patient's page) — the only patient context a doctor has to raise
   one from — and picks a department, a colleague (of that department, if one is chosen), or both,
   plus priority, reason, optional handoff note and validity (30–180 days), reviews it, and sends it →
   `POST /api/doctor/referrals`. Each reviewed referral carries a client-generated idempotency key,
   so a double click or retry resolves to the referral already created.
2. **Receive** — the receiving doctor — the named colleague, or, for a department referral nobody has
   taken, every active doctor of the department except the doctor who raised it — sees it on the
   `/doctor` dashboard (*Sizga kelgan yo‘llanmalar*), under `/doctor/referrals`, in the pending badge and
   on the patient's page. From this moment they see the patient's whole history — every doctor's
   visits and clinical records, each attributed to its author — with nothing to accept first and
   nobody to ask.
3. **Accept or decline** — the receiving doctor accepts (`PATCH /api/doctor/referrals/[id]`) or, when
   the referral was addressed to them, declines; starting a consultation with the patient accepts a
   pending referral automatically. A department referral can only be accepted — nobody can decline it
   for the others — and the first doctor to accept becomes its receiving doctor
   (`referred_to_doctor_id`); it then leaves the other department doctors' lists and badges.
4. **Book** (optional) — reception opens the patient in `/admin/patients`, sees the referral
   (metadata only) and, once it is accepted, books the follow-up with the receiving doctor
   (`POST /api/admin/appointments` with `referralId`), which goes through `book_appointment` and is
   then linked to the referral.
5. **Consult** — Doctor B starts their own consultation: the booked follow-up (patient page, queue or
   front desk) or a walk-in from the patient's page. It becomes the referral's follow-up and the
   database moves the referral to **in progress** (`referral_in_progress`); the start is audited
   as `consultation_started` — start, link and audit row in one transaction (`start_consultation()`).
   Doctor B documents it in `clinical_records` — current assessment, new diagnosis, clinical note,
   prescription, laboratory order, follow-up/onward referral — all authored by Doctor B; Doctor A's
   records are shown as history (*Oldingi tashxis* …), never changed, and Doctor B cannot correct
   them (only their author can). Categories come from `src/lib/clinical-records/categories.ts`
   (record type + whether it belongs to the doctor's consultation under way).
6. **Close** — Doctor B completes it (only once in progress); Doctor A (or owner/admin/manager
   via `PATCH /api/admin/referrals/[id]`) can revoke it while it is open, also while a department
   referral is untaken. Open referrals (pending, accepted, in progress) give no referral-based access
   after `expires_at` (≤ 180 days); the hourly `POST /api/referrals/expire` job — and any read —
   records them as expired. Every step is audited with actor, clinic, patient and referral; see
   [security.md](security.md#referral-lifecycle-and-access-termination). Afterwards Doctor B keeps the
   history through their own consultation, and Doctor A sees that consultation and its records.

Server logic lives in `src/lib/referrals/service.ts`; the database (trigger + RLS + composite
foreign keys) enforces the same rules independently of the API.

## Clinical access and the patient's profile

**The access decision.** A patient's clinical history belongs to the patient's record in the clinic.
What a doctor may see of it is one decision, `public.doctor_patient_access(doctor_id, patient_id)`,
which returns `(clinic_id, own_patient, active_referral_ids, full_history)` for an active doctor-role
doctor of the patient's clinic, and no row otherwise:

- `own_patient` — a treating relationship: any appointment of the doctor with the patient that is not
  cancelled (past, today or booked), or a record the doctor wrote. It is permanent (continuity of care).
- `active_referral_ids` — open (pending, accepted, in progress), unexpired referrals of the patient to
  the doctor, plus untaken (pending, no receiving doctor) department referrals to the doctor's
  department that the doctor did not raise.
- `full_history` = either. With it the doctor sees the patient's whole history in the clinic — every
  doctor's appointments and records — from the moment a referral exists; without it, nothing. There
  is no per-appointment scope and no acceptance gate. Referral-only access ends when the referral is
  declined, revoked or completed and at the latest at `expires_at`, checked against the database clock.

**How the server and RLS mirror each other.** RLS uses the decision through
`doctor_can_read_patient()` (the caller's `full_history`) and `doctor_can_read_appointment()` (equal
to it; its signature is kept for the policies). The server calls the same function with the service
role — `canDoctorAccessPatientClinicalData()` in `src/lib/clinical-access/access.ts`, returning
`{ relationship: "own" | "referred" | "none", allowed, fullHistory, activeReferralIds }` — so
direct database access and the API cannot disagree. Signed-in roles have no SELECT on
`clinical_records` or `referrals`: clinical text is read only through the server, which authorizes
and audits each read. Payments are not read by doctors at all; the server shows only the payment
status of the doctor's own visit. See [security.md](security.md#clinical-access-doctors).

**The patient's profile** (`/doctor/patients/[id]`, reached from the queue, the referral, *Bemorlarim*
(`/doctor/patients`, the doctor's own and referred patients, searchable) and the referral lists) is
`GET /api/doctor/patients/[id]` (`src/lib/clinical-access/workspace.ts`): every doctor's appointments,
the current version of every record by every author (attributed), all the patient's referrals — the
doctor's role on each is referrer, receiver or observer, with server-computed allowed actions — and
what the doctor can start. Its tabs:

| Tab | Shows |
| --- | --- |
| *Umumiy* | referrals waiting for the doctor's answer; *Mening qabulim* — the doctor's own consultation (start the booked visit or a walk-in, document it, correct their own records, refer, finish); scheduled visits |
| *Qabullar* | every visit of the patient in the clinic, whoever held it |
| *Klinik tarix* | the patient's journey, newest first: visits with the records written in them and the referrals, each record with its author |
| *Tashxislar* | diagnoses, clinical assessments and medical history (*Anamnez*) |
| *Laboratoriya* | laboratory orders and results |
| *Retseptlar* | prescriptions |
| *Yo‘llanmalar* | all of the patient's referrals; accept / decline / complete only where the doctor is the receiver |

Every record shows its author (*Siz yozgansiz* or *Muallif: …*) and time; only the author sees
*Tahrirlash*, a correction is saved as the record's next version (*Tarix* lists them), and another
doctor records their own view as a new record in their own consultation.

**Department referrals.** An untaken referral to a department is in the incoming list, the pending
badge and the patient history of every active doctor of the department except the doctor who raised it;
accepting is the only action, and the first acceptance makes that doctor the receiving doctor. See
[security.md](security.md#department-referrals).

## Registration and patient identity

One patient, one record. `patients.phone_normalized` is generated from `phone` (digits only; a 9-digit
number gets the `998` prefix), indexed per clinic and not unique. Reception's quick booking
(`src/components/admin/quick-booking-modal.tsx`) searches first — `GET /api/admin/patients?q=` also
matches the normalized phone from 5 digits — and picks a returning patient by `patientId`. When it
registers a new one, `POST /api/admin/appointments` answers 409 `possible_duplicate` with the clinic's
patients that have the same normalized phone, before it creates anything; the modal lists them
(*Shu bemor*), or the receptionist confirms *Yo‘q, bu boshqa odam* (`confirmNewPatient`), which
registers a different person who shares the phone. Editing the phone afterwards clears that
confirmation and the check runs again. A patient registered by a request whose booking then fails is
removed again. The website booking finds a returning visitor by the normalized phone (and name, without a
Telegram identity); the Mini App booking fills a verified patient's name and phone only while they are
empty. See [security.md](security.md#patient-identity-and-registration).

## Notifications

- Telegram messages are sent immediately for confirmations and admin alerts.
- Reminders (1 hour before appointment) are enqueued as `notification_jobs` and sent by the
  `/api/notifications/process` endpoint, called by Cloud Scheduler (cron) — no in-process timers,
  so zero instances still receive reminders.
- The same scheduled run enforces voice retention: past `expires_at` a voice message's audio
  is deleted from private storage and its transcripts and Telegram file reference are removed
  (`src/lib/voice/retention.ts`); a failed deletion is retried on the next run.
- Doctors see the referrals awaiting their answer — addressed to them, or to their department while
  untaken, never one they raised themselves — as a count on *Yo‘llanmalar*
  (`GET /api/doctor/referrals/pending-count`: a number only, no referral text, no audit rows).

## AI pipeline

- Chat is grounded: the bot fetches clinic catalog + booking context and builds a system prompt;
  the AI never sees training-data-only answers.
- Urgent wording is decided before any AI (`src/lib/safety/policy.ts`): the approved
  urgent-care message ("Bu holat shoshilinch yordam talab qilishi mumkin…") goes out — also in a
  conversation an operator holds — the conversation is flagged `urgent_at` and automatic replies
  stop; staff see it first in the conversation center and on the dashboard.
- Every assistant reply passes through the same policy: disallowed claims (diagnosis,
  prescriptions) are rejected; the AI is instructed it is not a doctor.
- Voice notes: Telegram `voice` messages → transcription endpoint (feature-flagged) → same chat flow.

## Payments

Status machine in `src/lib/payments/status.ts` (`canTransition`), mutations audited via
`transitionPaymentStatus`. Pilot runs `PAYMENT_PROVIDER=manual`; Click/PayMe adapters implement
the same interface (see [payment-provider.md](payment-provider.md)).

## Authentication model

- **Patients** — not Supabase Auth users. Every Mini App request carries Telegram initData,
  verified server-side with HMAC-SHA256 (bot token) and a freshness window.
- **Staff** — Supabase Auth email/password. Panels read via the browser client (RLS enforces
  role + clinic), mutations go through API routes guarded by `requireStaff(role)` which checks
  the JWT against `staff_roles` on every request — a member the owner removes loses the panel on
  their next request. The owner adds members (a new account gets a one-time password), changes
  roles and removes members (`/api/admin/staff/members`, owner only, audited); everyone changes
  their own password under *Parolim*.
- **Cron** — `/api/notifications/process` and `/api/referrals/expire` require
  `Authorization: Bearer <CRON_SECRET>` (constant-time check, `src/lib/cron-auth.ts`).
- **Webhook** — `/api/telegram/webhook` requires `X-Telegram-Bot-Api-Secret-Token` matching
  `TELEGRAM_WEBHOOK_SECRET`.

## Deployment

Docker standalone image → Artifact Registry → Cloud Run; secrets via Secret Manager;
external HTTPS load balancer for TLS + DNS; Cloud Scheduler for the cron. See
[deploy-cloud-run.md](deploy-cloud-run.md).