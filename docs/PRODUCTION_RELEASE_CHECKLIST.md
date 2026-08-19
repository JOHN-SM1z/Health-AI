# Production Release Checklist

This operational checklist governs the deployment, verification, and rollback procedures for launching the **Health AI** platform into production.

---

## 1. PRE-DEPLOYMENT

### A. Environment Variables & Production Secrets
- [ ] Generate a cryptographically random string (32+ bytes) for `CRON_SECRET` (`openssl rand -hex 32`).
- [ ] Generate a cryptographically random string (32+ bytes) for `TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`).
- [ ] Obtain production Telegram Bot token from @BotFather (`TELEGRAM_BOT_TOKEN`).
- [ ] Obtain production Supabase Project URL (`NEXT_PUBLIC_SUPABASE_URL`), Anon Key (`NEXT_PUBLIC_SUPABASE_ANON_KEY`), and Service Role Key (`SUPABASE_SERVICE_ROLE_KEY`).
- [ ] Configure `PAYMENT_PROVIDER=manual` (Pilot release requirement).
- [ ] Ensure `ENABLE_TELEGRAM_DEV_MODE` is explicitly set to `"false"`.
- [ ] Confirm no secrets, tokens, or private keys are committed in git (`git grep -E "sk-|service_role"`).
- [ ] Provision all server secrets in cloud Secret Manager (or hosting platform secret store).

### B. Database & Schema Verification
- [ ] Apply all 25 database migrations (`supabase/migrations/20260813000001_*.sql` through `20260818000025_*.sql`) to the production Supabase PostgreSQL database.
- [ ] Verify Row Level Security (RLS) is enabled on 100% of tables in the production database schema.
- [ ] Verify `is_clinic_staff` security definer function exists with `search_path = public`.
- [ ] Verify partial exclusion constraint `no_overlapping_active_appointments` is active on `public.appointments`.
- [ ] Confirm `anon` SQL role permissions are revoked on core business tables.

### C. Initial Data & Staff Bootstrapping
- [ ] Run owner creation bootstrap script (`npm run create-owner`) with production credentials to create the primary clinic and owner profile.
- [ ] Log into `/admin/login` using owner credentials and configure clinic settings, services, doctors, working hours, and FAQs.

### D. Automated Quality & Build Gates
- [ ] Run static type check (`npm run typecheck`) and confirm **0 errors**.
- [ ] Run linter (`npm run lint`) and confirm **0 errors**.
- [ ] Run test suite (`npm test`) and verify all active tests pass cleanly.
- [ ] Run production standalone build (`npm run build`) and confirm clean compilation.

---

## 2. DEPLOYMENT

### A. Hosting Infrastructure Provisioning
- [ ] Deploy Next.js standalone application container to Cloud Run (or Vercel).
- [ ] Verify container startup completes without fail-closed initialization exceptions.
- [ ] Configure custom domain DNS records (`A` / `AAAA` / `CNAME`) pointing to hosting endpoint.
- [ ] Confirm HTTPS / TLS certificate provisioned and enforced.

### B. Webhook & Third-Party Integration Setup
- [ ] Register Telegram Bot Webhook pointing to `https://<PRODUCTION_DOMAIN>/api/telegram/webhook` with header `secret_token` set to `TELEGRAM_WEBHOOK_SECRET`.
- [ ] Verify Telegram webhook registration response returns `{"ok": true, "result": true}`.
- [ ] Configure Telegram Mini App URL in @BotFather setting `https://<PRODUCTION_DOMAIN>/book`.

### C. Background Jobs & Scheduler
- [ ] Configure Cloud Scheduler (or cron daemon) to trigger `POST https://<PRODUCTION_DOMAIN>/api/notifications/process` every 15 minutes (`*/15 * * * *`).
- [ ] Set Cloud Scheduler HTTP request header `Authorization: Bearer <CRON_SECRET>`.

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
