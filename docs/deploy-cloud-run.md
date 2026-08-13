# Deploy to Cloud Run

## Overview

```
Git push → Cloud Build → Artifact Registry image → Cloud Run (health-ai)
                                                          │
                                                          ├─ Secret Manager (env secrets)
                                                          ├─ Cloud Scheduler → /api/notifications/process
                                                          └─ External HTTPS LB → your domain (TLS)
```

## Prerequisites

- Google Cloud project with billing, `gcloud` CLI authenticated.
- Supabase production project (see supabase-setup.md).
- Domain (e.g. `health.example.com`) with DNS access.

## 1. Build infrastructure

```bash
gcloud services enable run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  scheduler.googleapis.com

# Image repo
gcloud artifacts repositories create health-ai \
  --repository-format=docker --location=us-central1

# Secrets (real values from your providers)
SECRETS=(SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
         NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY \
         TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET \
         AI_BASE_URL AI_API_KEY AI_MODEL \
         WEBHOOK_SECRET CRON_SECRET)
for s in "${SECRETS[@]}"; do
  printf '%s' "${!s}" | gcloud secrets create "$s" --data-file=- --replication-policy=automatic
done
```

Notes:

- `WEBHOOK_SECRET` and `CRON_SECRET` must be long random strings
  (`openssl rand -hex 32`).
- If you have an existing secrets file you can create them with
  `gcloud secrets versions add <name> --data-file=-`.

## 2. Deploy (first time)

```bash
gcloud builds submit --config=cloudbuild.yaml --substitutions=_REGION=us-central1,_PUBLIC_URL=https://health.example.com
```

This builds the Docker image, pushes it, and deploys `health-ai` with the secrets wired
as env vars. Verify:

```bash
gcloud run services describe health-ai --region=us-central1 \
  --format="value(status.url)"
curl -s https://<url>/api/health
```

## 3. HTTPS + domain

```bash
# Static IP + LB (or use Cloud Run domain mapping for the managed <run.app> domain)
gcloud run domain-mappings create --service health-ai --region=us-central1 \
  --domain health.example.com   # follow the printed DNS verification

# If using a load balancer: create forwarding rules with a Google-managed cert;
# the app serves the health check on /api/health.
```

Set `NEXT_PUBLIC_APP_URL=https://health.example.com` (a substitution
`_PUBLIC_URL`) and redeploy.

## 4. Register the Telegram webhook

After DNS works and HTTPS is live (see telegram-setup.md §3).

## 5. Cloud Scheduler (reminders)

```bash
gcloud scheduler jobs create http health-ai-notifications \
  --schedule="*/5 * * * *" \
  --uri="https://health.example.com/api/notifications/process" \
  --http-method=POST \
  --oidc-service-account-email=YOUR_SCHEDULER_SA@PROJECT.iam.gserviceaccount.com \
  --headers="Authorization=Bearer $(gcloud secrets versions access CRON_SECRET --latest --secret=CRON_SECRET)"
```

Job is idempotent (per-job row lock via notification_jobs) and cheap to run every 5 min.

## 6. CI/CD trigger (optional)

See `cloudbuild-trigger.yaml`:

```bash
gcloud beta builds triggers create github \
  --repo-owner=ORG --repo-name=REPO \
  --branch-pattern="^main$" --build-config=cloudbuild.yaml \
  --substitutions=_REGION=us-central1,_PUBLIC_URL=https://health.example.com
```

## Scaling & settings

- Defaults in `cloudbuild.yaml`: 1 vCPU / 1 GiB, min 0, max 10, timeout 60s.
- `--no-cpu-throttling` keeps CPU during requests (webhook processing).
- Cold start: the standalone server boots in ~100ms; if alert latency matters,
  set `--min-instances=1`.

## Rollback

```bash
gcloud run services update-traffic health-ai --region=us-central1 \
  --to-revisions=health-ai-<revision>=100
# or
gcloud run revisions list --service=health-ai --region=us-central1
```

See rollback.md for the runbook.