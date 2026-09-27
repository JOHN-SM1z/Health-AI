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

- **clinics** — tenant root; most tables carry `clinic_id` (RLS isolation)
- **profiles + staff_roles** — staff accounts (Supabase Auth user ↔ profile; role: owner/admin/doctor)
- **patients** — Telegram-identified (telegram_user_id) with consent flag
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
- **conversations / messages / voice_messages** — chat history, admin takeover support
- **faq_entries / app_settings** — clinic content and settings
- **notification_jobs** — reminders/confirmations queue, sent by cron
- **processed_webhooks** — Telegram webhook idempotency
- **audit_events / analytics_events** — audit log and usage analytics

## Booking engine (double-booking protection)

All bookings go through the `book_appointment` Postgres function which:

1. takes an advisory transaction lock per doctor,
2. validates the slot against working hours and time blocks,
3. checks for overlapping active appointments (status in pending/confirmed/checked_in/in_progress),
4. inserts and returns `appointment_id` or a typed `error_code` (`slot_taken`, `outside_working_hours`, …).

`reschedule_appointment` does the same for reschedules. Direct inserts are still blocked by the
partial exclusion constraint. This makes the engine safe even under concurrent requests.

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
   from the workspace). After accepting, Doctor B sees Doctor A's history of the patient —
   visits and clinical records, each attributed to Doctor A.
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

## AI pipeline

- Chat is grounded: the bot fetches clinic catalog + booking context and builds a system prompt;
  the AI never sees training-data-only answers.
- Every assistant reply passes through `src/lib/safety/policy.ts`: urgency keywords escalate to a
  human ("Bu holat shoshilinch yordam talab qilishi mumkin…"), disallowed claims (diagnosis,
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
  the JWT against `staff_roles` on every request.
- **Cron** — `/api/notifications/process` and `/api/referrals/expire` require
  `Authorization: Bearer <CRON_SECRET>` (constant-time check, `src/lib/cron-auth.ts`).
- **Webhook** — `/api/telegram/webhook` requires `X-Telegram-Bot-Api-Secret-Token` matching
  `TELEGRAM_WEBHOOK_SECRET`.

## Deployment

Docker standalone image → Artifact Registry → Cloud Run; secrets via Secret Manager;
external HTTPS load balancer for TLS + DNS; Cloud Scheduler for the cron. See
[deploy-cloud-run.md](deploy-cloud-run.md).