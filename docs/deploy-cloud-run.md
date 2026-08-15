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

# Secrets (real values from your providers). NEXT_PUBLIC_* are NOT here:
# they are public build-time values passed as substitutions (see §2).
SECRETS=(SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
         TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET \
         AI_BASE_URL AI_API_KEY AI_MODEL \
         CRON_SECRET)
for s in "${SECRETS[@]}"; do
  printf '%s' "${!s}" | gcloud secrets create "$s" --data-file=- --replication-policy=automatic
done
```

Notes:

- `TELEGRAM_WEBHOOK_SECRET` and `CRON_SECRET` must be long random strings
  (`openssl rand -hex 32`).
- There is no `WEBHOOK_SECRET` secret — the webhook secret is
  `TELEGRAM_WEBHOOK_SECRET` (the app validates it at startup and the webhook
  rejects requests without the matching `X-Telegram-Bot-Api-Secret-Token`).
- If you have an existing secrets file you can create them with
  `gcloud secrets versions add <name> --data-file=-`.

## 2. Deploy (first time)

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=_REGION=us-central1,\
_PUBLIC_SUPABASE_URL=https://YOURPROJECT.supabase.co,\
_PUBLIC_SUPABASE_ANON_KEY=your-anon-key,\
_PUBLIC_URL=https://health.example.com
```

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`NEXT_PUBLIC_APP_URL` are inlined into the client **and** server bundles at
**build time** (Next.js `NEXT_PUBLIC_*` semantics — runtime env vars do NOT
override them), so they are passed to the Docker build as `--build-arg` (see
`cloudbuild.yaml`). Changing one of them requires a rebuild + redeploy. The
Supabase anon key is public by design; the service-role key is never baked
into the image.

This builds the Docker image, pushes it, and deploys `health-ai` with the secrets wired
as env vars. Verify:

```bash
gcloud run services describe health-ai --region=us-central1 \
  --format="value(status.url)"
curl -s https://<url>/api/health
```

## 3. HTTPS + domain

Production uses the external HTTPS load balancer with a custom domain —
Cloud Run's preview `domain-mappings` (run.app subdomains) are NOT
recommended for this service because the Telegram webhook and Mini App need
a stable, branded HTTPS origin.

```bash
# External HTTPS LB (global): static IP, URL map, backend NEG, Google-managed cert.
gcloud compute addresses create health-ai-ip --global
# Create a backend service pointing at the Cloud Run NEG, then:
gcloud compute url-maps create health-ai-url-map --default-service=health-ai-backend
gcloud compute ssl-certificates create health-ai-cert --domains=health.example.com
gcloud compute target-https-proxies create health-ai-proxy --url-map=health-ai-url-map --ssl-certificates=health-ai-cert
gcloud compute forwarding-rules create health-ai-fr --global --target-https-proxy=health-ai-proxy --address=health-ai-ip --ports=443
```

Point an A record for `health.example.com` at the static IP. Until the
custom domain is live you can still pilot on the service's default
`https://<service>-<hash>-uc.a.run.app` URL (HTTPS included), but the
webhook and Mini App should be pointed at the LB URL before going live.

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
  --substitutions=_REGION=us-central1,\
_PUBLIC_SUPABASE_URL=https://YOURPROJECT.supabase.co,\
_PUBLIC_SUPABASE_ANON_KEY=your-anon-key,\
_PUBLIC_URL=https://health.example.com
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