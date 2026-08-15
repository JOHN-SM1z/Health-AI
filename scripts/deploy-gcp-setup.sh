#!/usr/bin/env bash
# ==============================================================================
# Health AI — GCP Deployment Infrastructure Bootstrap Script
#
# This script provisions GCP resources required for Phase 1 deployment:
#  1. Enables necessary GCP APIs
#  2. Creates Artifact Registry repo (docker)
#  3. Prompts/creates Secret Manager secret stubs
#  4. Prints instructions for first deploy & Cloud Scheduler setup
# ==============================================================================

set -euo pipefail

REGION="${REGION:-us-central1}"
REPO="${REPO:-health-ai}"
SERVICE="${SERVICE:-health-ai}"

echo "=== 1. Checking GCP Project & Authentication ==="
PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
if [ -z "$PROJECT_ID" ]; then
  echo "Error: GCP project is not configured in gcloud CLI."
  echo "Run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi
echo "Target GCP Project: ${PROJECT_ID}"
echo "Target Region:      ${REGION}"

echo ""
echo "=== 2. Enabling GCP Service APIs ==="
APIS=(
  run.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  cloudbuild.googleapis.com
  scheduler.googleapis.com
)

for api in "${APIS[@]}"; do
  echo "Enabling API: ${api}..."
  if gcloud services enable "${api}" 2>/dev/null; then
    echo "  -> Enabled ${api}"
  else
    echo "  -> Warning: Could not enable ${api} (may require billing account link or org permissions)."
  fi
done

echo ""
echo "=== 3. Creating Artifact Registry Repository ==="
if gcloud artifacts repositories describe "${REPO}" --location="${REGION}" >/dev/null 2>&1; then
  echo "Artifact Registry repository '${REPO}' already exists."
else
  gcloud artifacts repositories create "${REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Docker repository for Health AI application"
  echo "Created Artifact Registry repository '${REPO}'."
fi

echo ""
echo "=== 4. Ensuring Secret Manager Secrets Exist ==="
SECRETS=(
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_BOT_TOKEN
  TELEGRAM_WEBHOOK_SECRET
  AI_BASE_URL
  AI_API_KEY
  AI_MODEL
  CRON_SECRET
)

for secret_name in "${SECRETS[@]}"; do
  if gcloud secrets describe "${secret_name}" >/dev/null 2>&1; then
    echo "Secret '${secret_name}' already exists."
  else
    echo "Creating secret '${secret_name}'..."
    # Generate placeholder for TELEGRAM_WEBHOOK_SECRET / CRON_SECRET if missing
    if [ "${secret_name}" = "TELEGRAM_WEBHOOK_SECRET" ] || [ "${secret_name}" = "CRON_SECRET" ]; then
      RAND_VAL="$(openssl rand -hex 32)"
      printf '%s' "${RAND_VAL}" | gcloud secrets create "${secret_name}" --data-file=- --replication-policy=automatic
    else
      printf '%s' "placeholder-set-in-secret-manager" | gcloud secrets create "${secret_name}" --data-file=- --replication-policy=automatic
    fi
    echo "Created secret '${secret_name}'."
  fi
done

echo ""
echo "=== Setup Completed Successfully! ==="
echo ""
echo "Next Steps:"
echo "1. Update Secret Manager secrets with your real production tokens:"
echo "   gcloud secrets versions add SUPABASE_URL --data-file=- <<< \"https://YOUR_PROJECT.supabase.co\""
echo "   gcloud secrets versions add SUPABASE_SERVICE_ROLE_KEY --data-file=- <<< \"YOUR_SERVICE_ROLE_KEY\""
echo "   gcloud secrets versions add TELEGRAM_BOT_TOKEN --data-file=- <<< \"YOUR_TELEGRAM_BOT_TOKEN\""
echo ""
echo "2. Deploy to Cloud Run using Cloud Build:"
echo "   gcloud builds submit --config=cloudbuild.yaml \\"
echo "     --substitutions=_REGION=${REGION},\\"
echo "  _PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co,\\"
echo "  _PUBLIC_SUPABASE_ANON_KEY=YOUR_ANON_KEY,\\"
echo "  _PUBLIC_URL=https://YOUR_DOMAIN"
echo ""
echo "3. Verify deployment health endpoint:"
echo "   curl https://YOUR_CLOUD_RUN_URL/api/health"
