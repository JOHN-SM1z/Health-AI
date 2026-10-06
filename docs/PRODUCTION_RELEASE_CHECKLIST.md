# Production Release Checklist

This operational checklist governs the deployment, verification, and rollback procedures for launching the **Health AI** platform into production.

---

## 1. PRE-DEPLOYMENT

### A. Environment Variables & Production Secrets
- [ ] Generate a cryptographically random string (32+ bytes) for `CRON_SECRET` (`openssl rand -hex 32`).
- [ ] Generate a cryptographically random string (32+ bytes) for `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`). Required unconditionally — production fails closed at startup without it, and any clinic admin can activate a patient-facing bot at any time (see telegram-setup.md §2).
- [ ] (Optional) Obtain a Telegram Bot token from @BotFather for the platform admin-notification bot (`TELEGRAM_BOT_TOKEN`) — this is unrelated to any clinic's patient-facing bot. Each clinic's own bot token is activated from that clinic's admin dashboard, not set as an env var (see telegram-setup.md §1).
- [ ] Obtain production Supabase Project URL (`NEXT_PUBLIC_SUPABASE_URL`), Anon Key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), and Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`).
- [ ] Configure `PAYMENT_PROVIDER=manual` (Pilot release requirement).
- [ ] Ensure `ENABLE_TELEGRAM_DEV_MODE` is explicitly set to `"false"`.
- [ ] Confirm no secrets, tokens, or private keys are committed in git (`git grep -E "sk-|service_role"`).
- [ ] Provision all server secrets in cloud Secret Manager (or hosting platform secret store).

### B. Database & Schema Verification
- [ ] Apply every database migration in `supabase/migrations/` (in filename order) to the production Supabase PostgreSQL database — `npx supabase db push`, or `supabase/full-db-setup.sql` once in the SQL editor on an empty project.
- [ ] Verify Row Level Security (RLS) is enabled on 100% of tables in the production database schema.
- [ ] Verify `is_clinic_staff` security definer function exists with `search_path = public`.
- [ ] Verify partial exclusion constraint `no_overlapping_active_appointments` is active on `public.appointments`.
- [ ] Confirm `anon` SQL role permissions are revoked on core business tables.
- [ ] Laboratory module (migrations `20261005000001`–`…021` on an existing database): back up first, apply to staging or a production copy before production, and work through the conditions in [`docs/labs/PRODUCTION_READINESS.md`](labs/PRODUCTION_READINESS.md) §3. Rollback options are in §4 there; the migrations are forward-only.

### C. Initial Data & Staff Bootstrapping
- [ ] Run owner creation bootstrap script (`npm run create-owner`) with production credentials to create the primary clinic and owner profile.
- [ ] Log into `/admin/login` using owner credentials and configure clinic settings, services, doctors, working hours, and FAQs.
- [ ] Add staff under *Xodimlar* (one-time password per new account, replaced by the member under *Parolim*); link doctor accounts under *Shifokorlar*.

### D. Automated Quality & Build Gates
- [ ] Run static type check (`npm run typecheck`) and confirm **0 errors**.
- [ ] Run linter (`npm run lint`) and confirm **0 errors**.
- [ ] Run test suite (`npm test`) and verify all active tests pass cleanly.
- [ ] Run production standalone build (`npm run build`) and confirm clean compilation.
- [ ] CI (`.github/workflows/ci.yml`) is green on the release commit — including the database suites and the end-to-end workflow + HTTP red team (`npm run test:e2e`) against a Supabase stack built from every migration.
- [ ] `supabase/full-db-setup.sql` is current (`node scripts/build-full-db-setup.mjs --check`) if the schema is applied through the SQL editor.

---

## 2. DEPLOYMENT

### A. Hosting Infrastructure Provisioning
- [ ] Deploy Next.js standalone application container to Cloud Run (or Vercel).
- [ ] Verify container startup completes without fail-closed initialization exceptions.
- [ ] On Vercel: Deployment Protection (Vercel Authentication) must not cover the production domain. With the default "All Deployments except Custom Domains" and no custom domain, every production URL — including `/api/telegram/webhook` and the cron endpoints — answers with the Vercel login page, so patients, Telegram and the scheduler never reach the app. Add a custom domain or set protection to "Only Preview Deployments".
- [ ] Configure custom domain DNS records (`A` / `AAAA` / `CNAME`) pointing to hosting endpoint.
- [ ] Confirm HTTPS / TLS certificate provisioned and enforced.

### B. Webhook & Third-Party Integration Setup
- [ ] Register Telegram Bot Webhook pointing to `https://<PRODUCTION_DOMAIN>/api/telegram/webhook` with header `secret_token` set to `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Verify Telegram webhook registration response returns `{"ok": true, "result": true}`.
- [ ] Configure Telegram Mini App URL in @BotFather setting `https://<PRODUCTION_DOMAIN>/book`.

### C. Background Jobs & Scheduler
Two jobs, both `POST` with header `Authorization: Bearer <CRON_SECRET>`:
`https://<PRODUCTION_DOMAIN>/api/notifications/process` every 15 minutes (`*/15 * * * *`) — the same run deletes voice messages past their retention (privacy page §2); the response reports `voicePurged` / `voicePurgeFailed` — and `https://<PRODUCTION_DOMAIN>/api/referrals/expire` hourly (`7 * * * *`).

The production project runs them from Supabase itself (pg_cron + pg_net), with [`supabase/ops/scheduled-jobs.sql`](../supabase/ops/scheduled-jobs.sql):
- [ ] Store the app's `CRON_SECRET` in Supabase Vault under the name `health_ai_cron_secret` (Dashboard → Project Settings → Vault, or `select vault.create_secret('<CRON_SECRET>', 'health_ai_cron_secret');` in the SQL editor). Same value as the app's `CRON_SECRET`; rotate both together.
- [ ] Set `v_app_url` in the script to the production URL and run it in the SQL editor (re-running replaces the jobs).
- [ ] After the next quarter hour, check `select status_code, left(content, 200) from net._http_response order by id desc limit 5;` — `200` with `{"ok":true,…}`. A `401` means the Vault secret differs from `CRON_SECRET`; a `200` with an HTML body means Vercel Deployment Protection is intercepting the request (§A).
- Cloud Scheduler (or any cron service) calling the same two URLs with the same header works equally well — use one scheduler, not both.

---

## 3. POST-DEPLOYMENT

### A. Operational Smoke Tests
- [ ] Invoke `GET https://<PRODUCTION_DOMAIN>/api/health` and verify HTTP 200 response (`{"ok": true}`).
- [ ] Verify invalid webhook request without secret token returns HTTP 401 Unauthorized.
- [ ] Verify cron endpoint request without bearer token returns HTTP 401 Unauthorized.
- [ ] Open Telegram Bot and send `/start` command — verify interactive menu renders.
- [ ] Open Telegram Mini App (`/book`), select service/doctor/slot, and complete test booking.
- [ ] Log into Staff Admin Panel (`/admin`) — verify new appointment appears in today's view.
- [ ] Log into Doctor Portal (`/doctor`) — verify appointment queue displays correctly.
- [ ] Test urgent keyword message in bot chat (e.g., "tez yordam") — verify emergency message responds and admin alert triggers.

### B. Telemetry & Monitoring Verification
- [ ] Verify structured JSON log entries arrive in Cloud Logging.
- [ ] Verify database table `public.audit_events` records staff actions and status changes.
- [ ] Confirm no 5xx errors appear in hosting error logs during initial traffic window.

---

## 4. ROLLBACK RUNBOOK

### A. Immediate Traffic Rollback (< 2 minutes)
If critical application defects or boot failures occur immediately following deployment:

1. List available service revisions:
   ```bash
   gcloud run revisions list --service=health-ai --region=us-central1
   ```
2. Instantly redirect 100% of traffic to the previous known-good revision:
   ```bash
   gcloud run services update-traffic health-ai --region=us-central1 --to-revisions=<PREVIOUS_REVISION_NAME>=100
   ```
3. Verify `/api/health` returns 200 OK on the rolled-back revision.

### B. Database Emergency Recovery
If database corruption or destructive schema changes occur:

1. Stop Cloud Scheduler cron job to prevent reminder processing against invalid state.
2. Restore database from Supabase Point-In-Time Recovery (PITR) snapshot prior to the incident timestamp.
3. Re-apply verified schema migrations fix-forward.
4. Restart Cloud Scheduler cron job once database state is verified.

### C. Compromised Secret Rotation
If a secret key (`CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`) is compromised:

1. Update Secret Manager version with new credential payload.
2. Update environment configuration on Cloud Run / hosting provider.
3. If Telegram Bot token was rotated, re-register webhook with @BotFather.
4. Redeploy service revision to force all worker instances to reload environment.
