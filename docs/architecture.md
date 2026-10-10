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
  with the same phone and name, and never edits one
- **specialties / services / doctors / doctor_services / doctor_working_hours / doctor_time_blocks** — clinic catalog
- **appointments** — status machine (`pending → confirmed → checked_in → in_progress → completed`, `cancelled`, `no_show`), **exclusion constraint** `no_overlapping_active_appointments` prevents double-booking at DB level
- **payments** — linked to appointment, status machine with audit trail
- **referrals** — doctor-to-doctor referral within one clinic, raised from the consultation (the
  appointment in which the referring doctor saw the patient); composite foreign keys keep the
  patient, both doctors and that appointment inside the referral's clinic; status machine
  `pending → accepted → in_progress → completed` (or `declined` / `revoked` / `expired`)
  enforced by trigger for every writer; audited without its clinical text (reason, handoff note);
  linked to the receiving doctor's consultation for it (`follow_up_appointment_id`, booked by
  reception or started by the doctor) — the referral is in progress once that consultation starts
- **clinical_records** — doctor-authored clinical notes, assessments, diagnoses, prescriptions,
  lab orders and results, medical history and follow-up plans; each tied to the author's own consultation (composite FK), immutable
  (corrections are new records), readable only where the consultation is (see
  [security.md](security.md#clinical-records))
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

Doctor A refers a patient to Doctor B in the same clinic:

1. **Refer** — in `/doctor` (today's queue) Doctor A opens *Yo‘llanma* on an `in_progress` or
   `completed` consultation — the only patient context a doctor has — and picks a colleague,
   priority, reason, optional handoff note and validity (30–180 days), reviews it, and sends it →
   `POST /api/doctor/referrals`. Each reviewed referral carries a client-generated idempotency key,
   so a double click or retry resolves to the referral already created.
2. **Review and respond** — Doctor B sees it on the `/doctor` dashboard (*Sizga kelgan
   yo‘llanmalar*), under `/doctor/referrals` and on the patient's workspace, reviews the
   consultation it came from, and accepts or declines (`PATCH /api/doctor/referrals/[id]`, also
   from the workspace). From the moment the referral exists (pending included — no accept step
   to read, owner decision 2026-10-07), Doctor B sees Doctor A's history of the patient —
   visits and clinical records, each attributed to Doctor A. Starting a consultation from the
   referral still needs it accepted.
3. **Book** (optional) — reception opens the patient in `/admin/patients`, sees the referral
   (metadata only) and books the follow-up with Doctor B (`POST /api/admin/appointments` with
   `referralId`), which goes through `book_appointment` and is then linked to the referral.
4. **Consult** — Doctor B starts their own consultation: the booked follow-up (workspace, queue
   or front desk) or a walk-in from the workspace. It becomes the referral's follow-up and the
   database moves the referral to **in progress** (`referral_in_progress`); the start is audited
   as `consultation_started` — start, link and audit row in one transaction (`start_consultation()`). Doctor B documents it in `clinical_records` — current assessment,
   new diagnosis, clinical note, prescription, laboratory order, follow-up/onward referral — all
   authored by Doctor B; Doctor A's records are shown as history (*Oldingi tashxis* …), never
   changed. Categories come from `src/lib/clinical-records/categories.ts` (record type + whether
   it belongs to the doctor's consultation under way).
5. **Close** — Doctor B completes it (only once in progress); Doctor A (or owner/admin/manager
   via `PATCH /api/admin/referrals/[id]`) can revoke it while it is open. Open referrals
   (pending, accepted, in progress) lose all referral-based access at `expires_at` (≤ 180 days);
   the hourly `POST /api/referrals/expire` job — and any read — records them as expired.
   Every step is audited with actor, clinic, patient and referral; see
   [security.md](security.md#referral-lifecycle-and-access-termination). Afterwards Doctor B keeps their own consultation, and Doctor A sees it and its
   records as the referral's follow-up.

Server logic lives in `src/lib/referrals/service.ts`; the database (trigger + RLS + composite
foreign keys) enforces the same rules independently of the API.

What a doctor may see of a patient — their own patient, or one actively referred to them — is one
decision, `public.doctor_patient_access()`, used by the `patients`/`appointments` RLS policies and by
the server (`src/lib/clinical-access/access.ts`, `GET /api/doctor/patients/[id]`, shown on the
doctor's patient workspace `/doctor/patients/[id]`, reached from the queue, the referral, the
referred-patients list and *Bemorlarim* (`/doctor/patients`, the doctor's own and referred patients,
searchable). The workspace separates the doctor's own consultation ("Mening qabulim": start it,
document and correct it, finish it) from previous records, each shown with its author, time and
type; a *Klinik xulosa* groups the records in force (historical and new diagnoses, history,
prescriptions, lab orders and results) with their authors, and the receiving doctor can accept,
decline or complete the referral in place, following its lifecycle stepper. See
[security.md](security.md#clinical-access-doctors).

## Notifications

- Telegram messages are sent immediately for confirmations and admin alerts.
- Reminders (1 hour before appointment) are enqueued as `notification_jobs` and sent by the
  `/api/notifications/process` endpoint, called by Cloud Scheduler (cron) — no in-process timers,
  so zero instances still receive reminders.
- The same scheduled run enforces voice retention: past `expires_at` a voice message's audio
  is deleted from private storage and its transcripts and Telegram file reference are removed
  (`src/lib/voice/retention.ts`); a failed deletion is retried on the next run.
- Doctors see the referrals awaiting their answer as a count on *Yo‘llanmalar*
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