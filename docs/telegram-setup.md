# Telegram setup

## 1. Create the bot

1. In Telegram, message `@BotFather` → `/newbot` → choose a name and username.
2. Save the token: `TELEGRAM_BOT_TOKEN`.

## 2. Mini App

1. `@BotFather` → `/newapp` (or Bot Settings → Menu Button) → set the Mini App URL
   to `https://<your-domain>/book` (after deploying — see deploy-cloud-run.md).
2. Optional: Bot Settings → Menu Button → set the bot menu button to open the Mini App.
3. The Mini App reads `window.Telegram.WebApp.initData` and authenticates against
   `/api/telegram/auth` on every booking request (server-side HMAC verification).

## 3. Webhook

Production (HTTPS required by Telegram):

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-domain>/api/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message","callback_query","pre_checkout_query"]
  }'
```

- `TELEGRAM_WEBHOOK_URL` in `.env` is used by the app to *register* the webhook at
  startup in non-production; in production register it once manually as above.
- Verify with `getWebhookInfo`; remove with `deleteWebhook`.
- Webhook updates are deduplicated (`processed_webhooks`) and rejected without the
  matching `X-Telegram-Bot-Api-Secret-Token`.

Local development: set `ENABLE_TELEGRAM_DEV_MODE=true` (NEVER in production) so the
bot accepts the synthetic identity `DEV_TELEGRAM_USER_ID` without real Telegram auth.

## 4. Admin notifications

`TELEGRAM_ADMIN_CHAT_IDS` — comma-separated chat ids that receive new-booking alerts
and emergency escalations (e.g. `111111111,222222222`). Get a chat id by messaging
`@userinfobot`.

## 5. Voice messages

Patients can send voice notes; processing requires the transcription provider
(see ai-provider-setup.md) and `ENABLE_TRANSCRIPTION=true`. Without it, the bot
politely declines voice messages.

## 6. Callback queries

The bot menu is callback-driven (services, time slots, confirm/cancel, doctor help).
`pre_checkout_query` is handled for future paid bookings but is inert while
`PAYMENT_PROVIDER=manual`.