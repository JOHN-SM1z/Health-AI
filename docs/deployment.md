# Production Deployment Guide

This guide covers deploying the Health AI application to production. You can deploy it to **Vercel** (recommended for rapid zero-cost launch) or any standard **Node.js production environment**.

---

## 1. Prerequisites & Required Services

1. **Supabase Cloud Project**
   - Free or Pro tier at [supabase.com](https://supabase.com).
   - Provides PostgreSQL Database, Auth, Storage, and Row-Level Security (RLS).
2. **Telegram Bot**
   - Created via [@BotFather](https://t.me/BotFather) on Telegram.
3. **Hosting Platform**
   - **Option A (Recommended):** [Vercel](https://vercel.com) (Fast, serverless, automated HTTPS & CI/CD).
   - **Option B:** Standalone Node.js server (VPS / VM / Cloud Run / Railway / Render).

---

## 2. Supabase Database Setup

1. In your Supabase project dashboard, navigate to **SQL Editor** (left sidebar).
2. Copy and run the full initialization script from:
   [`supabase/migrations/20260415000000_init.sql`](../supabase/migrations/20260415000000_init.sql)
3. Copy your project keys from **Project Settings → API**:
   - **Project URL:** `https://<PROJECT_REF>.supabase.co`
   - **`anon` `public` API key:** `eyJhbG...`
   - **`service_role` `secret` key:** `eyJhbG...`

---

## 3. Environment Variables Reference

Configure these environment variables in your hosting provider's dashboard:

| Variable | Required | Description | Example |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | Optional | Public URL used for booking links in Telegram notifications (omit if unused) | `https://health-ai.vercel.app` |
| `NEXT_PUBLIC_SUPABASE_URL` | **Yes** | Supabase project endpoint | `https://xyzcompany.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Yes** | Supabase public anon key | `eyJhbGciOi...` |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Supabase privileged service-role key (server-only) | `eyJhbGciOi...` |
| `TELEGRAM_BOT_TOKEN` | **Yes** | Bot token from @BotFather | `123456789:ABCdefGHIjkl...` |
| `TELEGRAM_WEBHOOK_SECRET` | **Yes** | Random 32+ character string for webhook verification | `health_ai_sec_9876543210abcdef123` |
| `CRON_SECRET` | **Yes** | Random 32+ character string for background notification scheduler | `health_ai_cron_1234567890abcdef12` |
| `PAYMENT_PROVIDER` | **Yes** | Payment mode (`manual` for pilot) | `manual` |
| `ENABLE_AI` | Optional | Enable OpenAI-compatible bot intelligence | `false` |
| `NODE_ENV` | Automatic | Environment mode | `production` |

---

## 4. Deploying to Vercel (Recommended)

1. Push your code to GitHub.
2. Log into [vercel.com](https://vercel.com) and click **Add New → Project**.
3. Import your `Health-AI` repository.
4. Expand **Environment Variables** and paste the variables listed above.
5. Click **Deploy**. Vercel will automatically build and launch the Next.js application.

---

## 5. Post-Deployment Steps

### A. Register Telegram Webhook
Run this command in your terminal using your live production domain:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<YOUR_PRODUCTION_DOMAIN>/api/telegram/webhook",
    "secret_token": "<YOUR_TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Expected response:
```json
{"ok": true, "result": true, "description": "Webhook was set"}
```

### B. Configure Telegram Mini App URL (Optional)
In Telegram via [@BotFather](https://t.me/BotFather):
1. Send `/mybots` → Select your bot → **Bot Settings** → **Menu Button** (or **Configure Mini App**).
2. Set URL to: `https://<YOUR_PRODUCTION_DOMAIN>/book`.

### C. Create First Clinic Owner
Run the bootstrap script locally with your production Supabase keys:

```bash
SUPABASE_URL="https://<PROJECT_REF>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="<YOUR_SERVICE_ROLE_KEY>" \
OWNER_EMAIL="admin@yourclinic.com" \
OWNER_PASSWORD="YourSecurePassword123!" \
CLINIC_NAME="Mening Klinikam" \
CLINIC_SLUG="my-clinic" \
npm run create-owner
```

You can now log in at `https://<YOUR_PRODUCTION_DOMAIN>/admin/login`.

### D. Setup Notification Cron Job (Every 15 Minutes)
To automatically process reminders (24h and 2h before appointments), configure a periodic HTTP trigger (using [cron-job.org](https://cron-job.org) or Vercel Cron):

- **Target URL:** `https://<YOUR_PRODUCTION_DOMAIN>/api/notifications/process`
- **Method:** `POST`
- **Header:** `Authorization: Bearer <YOUR_CRON_SECRET>`
- **Interval:** Every 15 minutes (`*/15 * * * *`)

---

## 6. Verification Checklist

- [ ] `/api/health` returns `{"ok": true, "timestamp": ...}`
- [ ] Admin panel loads at `/admin/login` and accepts owner credentials
- [ ] Doctor panel loads at `/doctor`
- [ ] Telegram bot replies to `/start` in Telegram
- [ ] Mini App booking completes and schedules appointment
- [ ] Webhook returns 401 Unauthorized for invalid secret tokens
