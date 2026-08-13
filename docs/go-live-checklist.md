# Go-live checklist

Everything that must exist before real patients use the service.

## 1. Credentials to obtain

| Credential | From | Notes |
| --- | --- | --- |
| Telegram bot token | @BotFather | `TELEGRAM_BOT_TOKEN` |
| Telegram webhook secret | you | `openssl rand -hex 32` → `TELEGRAM_WEBHOOK_SECRET` |
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
| `NEXT_PUBLIC_APP_URL` | yes | http://localhost:3000 | public base URL |
| `NEXT_PUBLIC_SUPABASE_URL` | yes | – | browser client |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | – | browser client (public) |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | – | server only |
| `TELEGRAM_BOT_TOKEN` | yes* | – | *required for bot to answer |
| `TELEGRAM_WEBHOOK_SECRET` | yes* | – | *required for webhook |
| `TELEGRAM_WEBHOOK_URL` | no | – | used by app to register webhook (dev) |
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
2. Create secrets in Secret Manager (deploy-cloud-run.md §1).
3. Deploy Cloud Run (§2); verify `/api/health`.
4. HTTPS + DNS (§3); register Telegram webhook (§4); Cloud Scheduler (§5).
5. `npm run create-owner` with `OWNER_EMAIL`/`OWNER_PASSWORD` in `.env` (production-safe;
   it runs against whatever `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` point to).
6. Create staff accounts for admins/doctors; assign roles via SQL/panel.
7. Add clinic content in the admin panel: services, doctors, hours, FAQs, settings.
8. Run the full manual QA checklist.

## 4. Go / no-go

Go when: QA checklist all green, owner + staff accounts exist, webhook registered,
scheduler running, rollback rehearsed, and at least one real end-to-end booking
(book → confirm → remind → attend → complete → pay) has been performed by the team.

## 5. Post-launch (first week)

- Watch Cloud Logging error rates daily.
- Verify notifications arrive on time (check a reminder with a test booking).
- Confirm no double-bookings occur under real concurrency.
- Keep `PAYMENT_PROVIDER=manual` until the Click/PayMe adapter is validated.