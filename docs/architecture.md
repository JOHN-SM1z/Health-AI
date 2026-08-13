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
- **Cron** — `/api/notifications/process` requires `Authorization: Bearer <CRON_SECRET>`.
- **Webhook** — `/api/telegram/webhook` requires `X-Telegram-Bot-Api-Secret-Token` matching
  `TELEGRAM_WEBHOOK_SECRET`.

## Deployment

Docker standalone image → Artifact Registry → Cloud Run; secrets via Secret Manager;
external HTTPS load balancer for TLS + DNS; Cloud Scheduler for the cron. See
[deploy-cloud-run.md](deploy-cloud-run.md).