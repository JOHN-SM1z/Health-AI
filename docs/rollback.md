# Rollback runbook

## Cloud Run revision rollback (fast path, <2 min)

```bash
gcloud run revisions list --service=health-ai --region=us-central1
# pick the last known-good revision (e.g. health-ai-0004-xyz)

gcloud run services update-traffic health-ai --region=us-central1 \
  --to-revisions=health-ai-0004-xyz=100
```

Traffic switches immediately; old revisions stay alive and cost nothing while idle.

## Database rollback

The schema is forward-only by design (13 ordered migrations). Rolling back a migration is
NOT automatic — do it deliberately:

1. Identify the migration to revert and write the reverse DDL manually, or
2. restore the production database from the last backup (Supabase: project → Database →
   Backups; or `pg_dump` taken before the change).

Prefer fixing forward over rolling back the DB; the app and DB versions must match.

## Secret rotation

```bash
gcloud secrets versions add SUPABASE_SERVICE_ROLE_KEY --data-file=-
# then redeploy (or wait for next deploy) — Cloud Run picks up the new version
# (use --secret-version-lock on the service if pinning, e.g. with `--update-secrets`)
```

## Decision guide

| Symptom | Action |
| --- | --- |
| Broken deploy (build/boot) | roll back revision |
| Wrong behavior, DB intact | roll back revision, fix forward |
| Data corruption / wrong schema | restore backup, then roll back revision |
| Secret leak | rotate secret + service role key, audit `audit_events` |
| Payment/booking incident | stop scheduler (reminders) + set `min-instances=0`, investigate, roll back revision |

## After any rollback

- Re-run the manual QA checklist before re-promoting traffic.
- File the incident + root cause in this repo before the next deploy.