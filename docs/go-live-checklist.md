# Go-live checklist

Everything that must exist before real patients use the service.

## 1. Credentials to obtain

| Credential | From | Notes |
| --- | --- | --- |
| Telegram webhook secret | you | `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET` (required before any clinic can activate a bot — see telegram-setup.md) |
| Telegram bot token (per clinic) | @BotFather, one per clinic | pasted into that clinic's dashboard bot panel, not an env var — see telegram-setup.md §1 |
| Telegram platform admin-bot token (optional) | @BotFather | `TELEGRAM_BOT_TOKEN` — only for admin alert notifications, not any clinic's patient-facing bot |
| Supabase project + keys | supabase.com | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` (anon key may be public; service role key is server-only) |
| AI provider key | provider of choice | `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`; optional `TRANSCRIPTION_*` for voice |
| Admin chat ids | each admin's @userinfobot | `TELEGRAM_ADMIN_CHAT_IDS` |
| Cron secret | you | `openssl rand -hex 32` → `CRON_SECRET` |
| Owner email/password | you | bootstrap via `npm run create-owner` |
| Domain + DNS | registrar | for HTTPS + webhook + Mini App |

## 2. Environment variables (complete list)

Server-side (`src/lib/env.ts` validates):

| Var | Required | Default | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_APP_URL` | no | – | booking links in notifications/bot; optional |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | – | browser client; build-time (substitution) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | – | browser client (public); build-time (substitution) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | – | server only |
| `TELEGRAM_BOT_TOKEN` | no | – | legacy platform admin-notification bot only; unrelated to any clinic's patient-facing bot |
| `TELEGRAM_WEBHOOK_SECRET` | yes | – | required to validate every clinic's webhook; fails closed at startup regardless of `TELEGRAM_BOT_TOKEN` |
| `TELEGRAM_WEBHOOK_URL` | no | – | declared but unused by current code — webhook URLs are derived from `NEXT_PUBLIC_APP_URL` instead; do not set expecting it to do anything |
| `TELEGRAM_ADMIN_CHAT_IDS` | no | – | comma-separated alert targets |
| `ENABLE_TELEGRAM_DEV_MODE` | no | false | **never in production** |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | no | gpt-4o-mini | `ENABLE_AI=true` to activate |
| `AI_TEMPERATURE` | no | 0.2 | 0–2 |
| `TRANSCRIPTION_BASE_URL` / `_API_KEY` / `_MODEL` | no | whisper-1 | `ENABLE_TRANSCRIPTION=true` to activate |
| `PAYMENT_PROVIDER` | no | manual | manual \| click \| payme |
| `CRON_SECRET` | yes | change-me-in-production | **must change** |
| `LOG_FORMAT` / `LOG_LEVEL` | no | pretty/info | json in production |
| `CLINIC_TIMEZONE` | no | Asia/Tashkent | slot math |

## 3. Bootstrap order

1. Apply migrations + seed to the production Supabase project (supabase-setup.md).
2. Create secrets in Secret Manager (deploy-cloud-run.md §1) and configure the
   public build-time substitutions (`_PUBLIC_SUPABASE_URL`, `_PUBLIC_SUPABASE_ANON_KEY`, `_PUBLIC_URL`).
3. Deploy Cloud Run (§2); verify `/api/health`.
4. HTTPS + DNS (§3); confirm `TELEGRAM_WEBHOOK_SECRET` is set (deploy-cloud-run.md §4
   — required for any clinic bot to work, see telegram-setup.md §2); Cloud Scheduler (§5).
5. `npm run create-owner` with `OWNER_EMAIL`/`OWNER_PASSWORD` in `.env` (production-safe;
   it runs against whatever `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` point to).
6. Create staff accounts for admins/doctors; assign roles via SQL/panel.
7. Add clinic content in the admin panel: services, doctors, hours, FAQs, settings.
   For each clinic, also activate its Telegram bot from the dashboard's bot panel
   (telegram-setup.md §1) — this is a per-clinic, self-service, repeatable step, not
   a one-time platform action; a new clinic onboarded after go-live still needs it.
8. Run the full manual QA checklist, including one real Telegram conversation
   (`/start` → a booking) against an activated clinic bot.

## 4. Go / no-go

Go when: QA checklist all green, owner + staff accounts exist, at least one clinic's
Telegram bot is activated with its webhook confirmed registered, scheduler running,
rollback rehearsed, and at least one real end-to-end booking (book → confirm →
remind → attend → complete → pay) has been performed by the team.

## 5. Post-launch (first week)

- Watch Cloud Logging error rates daily.
- Verify notifications arrive on time (check a reminder with a test booking).
- Confirm no double-bookings occur under real concurrency.
- Keep `PAYMENT_PROVIDER=manual` until the Click/PayMe adapter is validated —
  selecting `click`/`payme` now fails at startup by design (payment-provider.md).
- Watch for startup crashes caused by the fail-closed checks
  (`src/instrumentation.ts`): `CRON_SECRET` must be set and not the default, and
  `TELEGRAM_WEBHOOK_SECRET` must always be set — required unconditionally, not only
  when the legacy `TELEGRAM_BOT_TOKEN` is also set.
