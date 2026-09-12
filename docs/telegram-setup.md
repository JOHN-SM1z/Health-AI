# Telegram setup

Two independent things are called "the bot" in this codebase — keep them separate:

- **Per-clinic patient bot** (the actual product feature): every clinic has its own
  bot, activated by that clinic's admin from their dashboard. This is what patients
  message to book appointments. Most clinics need this.
- **Platform admin-notification bot** (optional, singular): one bot, configured once
  via `TELEGRAM_BOT_TOKEN`, used only to relay booking alerts / emergency escalations
  to `TELEGRAM_ADMIN_CHAT_IDS`. It never talks to patients and has nothing to do with
  any clinic's own bot.

If "the Telegram bot isn't working" for a clinic, the cause is almost always in the
per-clinic setup below — setting `TELEGRAM_BOT_TOKEN` does not make any clinic's bot
answer patients.

## 1. Per-clinic bot (patient-facing) — do this for every clinic

1. In Telegram, message `@BotFather` → `/newbot` → choose a name and username. Copy
   the token BotFather gives you.
2. As that clinic's admin, open the dashboard's Telegram bot panel and paste the
   token, then activate it.
3. The server validates the token with Telegram's `getMe`, stores it in
   `clinic_telegram_integrations` (never exposed to any browser client — zero RLS
   policies on that table, service-role only), and **registers the webhook
   automatically** (`registerBotWebhook()` in `src/lib/telegram/bots.ts`, via the
   `grammy` SDK's `setWebhook`). There is no manual `curl`/`setWebhook` step for
   clinic bots — doing it by hand sends the wrong secret (see below) and every
   update gets rejected.
4. The panel reports immediately whether the webhook registered, and shows the
   persisted status on every later page load. A clinic bot that "isn't working"
   usually shows the reason right there — check it before assuming the token is
   wrong.
5. This requires two platform-level values to already be set (next sections):
   `NEXT_PUBLIC_APP_URL` (the webhook URL is built from it) and
   `TELEGRAM_WEBHOOK_SECRET`. Neither is something a clinic admin provides.

## 2. Webhook secret (platform-wide, set once by the operator)

`TELEGRAM_WEBHOOK_SECRET` is a platform-wide seed (`openssl rand -hex 32`) that is
**never sent to Telegram directly**. For each bot, the server derives a *bot-specific*
secret — `HMAC-SHA256(TELEGRAM_WEBHOOK_SECRET, <that bot's token>)`
(`botWebhookSecret()` in `src/lib/telegram/bots.ts`) — and only that derived value is
registered with Telegram and checked against the `X-Telegram-Bot-Api-Secret-Token`
header on every incoming update (`timingSafeCheck()` in the same file).

Do not manually call Telegram's `setWebhook` with the raw `TELEGRAM_WEBHOOK_SECRET`
value. Telegram would then echo back the raw value, which never matches the per-bot
HMAC the webhook route expects — every update would be rejected as unauthorized
(401) even with a correct bot token. Registration is automatic (§1) specifically to
avoid this mistake.

Production fails closed at startup if this is unset (`src/instrumentation.ts`). It
must be set before go-live even if no clinic has activated a bot yet, because any
clinic admin can activate one at any time afterward.

## 3. Platform admin-notification bot (optional)

1. `@BotFather` → `/newbot` for a separate bot dedicated to platform alerts (do not
   reuse a clinic's bot for this).
2. Set `TELEGRAM_BOT_TOKEN` to its token. Set `TELEGRAM_ADMIN_CHAT_IDS` —
   comma-separated chat ids that receive new-booking alerts and emergency
   escalations (e.g. `111111111,222222222`). Get a chat id by messaging
   `@userinfobot`.
3. If left unset, admin notifications are simply skipped. This never affects any
   clinic's patient-facing bot.

## 4. Mini App

1. `@BotFather` → `/newapp` (or Bot Settings → Menu Button) → set the Mini App URL
   to `https://<your-domain>/book` (after deploying — see deploy-cloud-run.md). This
   applies per clinic bot, not the platform admin bot.
2. Optional: Bot Settings → Menu Button → set the bot menu button to open the Mini App.
3. The Mini App reads `window.Telegram.WebApp.initData` and authenticates against
   `/api/telegram/auth` on every booking request (server-side HMAC verification).

## 5. Diagnosing a webhook manually

Useful for reading state only — never to register a webhook (see §2):

```bash
curl "https://api.telegram.org/bot<CLINIC_BOT_TOKEN>/getWebhookInfo"
curl -X POST "https://api.telegram.org/bot<CLINIC_BOT_TOKEN>/deleteWebhook"
```

After `deleteWebhook`, deactivate and reactivate the clinic's bot from the dashboard
to have the app re-register it correctly — do not call `setWebhook` by hand.

Webhook updates are claimed atomically per bot/update id before any handler runs, so
Telegram's retried deliveries are deduplicated and never dispatched twice
(`src/lib/telegram/idempotency.ts`). Updates without the correct
`X-Telegram-Bot-Api-Secret-Token` are rejected before parsing.

Local development: set `ENABLE_TELEGRAM_DEV_MODE=true` so the bot accepts the
synthetic identity `DEV_TELEGRAM_USER_ID` without real Telegram auth. This is refused
outright whenever `NODE_ENV=production`, regardless of this flag — never usable in
production.

## 6. Voice messages

Patients can send voice notes; processing requires the transcription provider (see
ai-provider-setup.md) and `ENABLE_TRANSCRIPTION=true`. Without it, the bot politely
declines voice messages.

## 7. Callback queries

The bot menu is callback-driven (services, time slots, confirm/cancel, doctor help).
`pre_checkout_query` is handled for future paid bookings but is inert while
`PAYMENT_PROVIDER=manual`.
