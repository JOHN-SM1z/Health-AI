# Deployment runbook

The current branch is a release candidate, not an approved production upgrade.
Read [the hosted preflight](DEPLOYMENT_PREFLIGHT_2026-10-07.md) before deployment.
It records concrete incompatibilities with both hosted databases.

## Database gate

Use all versioned migrations for an empty, isolated database, with one transaction
per file. Never initialize an existing hosted database by replaying the baseline,
running `full-db-setup.sql`, resetting it, or marking conflicting versions applied.
The hosted production and laboratory staging schemas require a reviewed,
forward-only compatibility upgrade and preservation tests first.

Run `scripts/release-schema-preflight.sql` as a read-only prerequisite check.
Any returned row blocks this branch. An empty result is necessary but does not
prove that grants, RLS, triggers, function bodies, or data are correct.

## Release checks

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Run database integration tests against an isolated test database; all required
tests must run, rather than pass through skips. Test existing-record upgrades,
authorization, payment idempotency, and browser workflows. Confirm backup/restore
capability before changing the production schema. See
[PILOT_VALIDATION_2026-10-06.md](PILOT_VALIDATION_2026-10-06.md) for the previously
tested isolated branch and its limitations.

## Configuration and staged release

1. Confirm the existing Vercel project and production domain; both `health-ai`
   and `health-ai-w1vc` deploy the repository. Scope every command explicitly.
2. Set matching Supabase URL/public key/server-only service key through the
   hosting environment manager. Keep keys out of source, shell arguments, and logs.
   Check runtime required secrets against `src/lib/env.ts`; use securely generated
   values for `CRON_SECRET` and `TELEGRAM_WEBHOOK_SECRET`.
3. Keep `PAYMENT_PROVIDER=manual`, Telegram development mode disabled, and AI /
   transcription disabled unless separately configured and verified. Do not enable
   seed or demo users in production. Never copy local test settings into hosting.
4. Set the stable HTTPS app origin. For a linked and verified project, stage the
   production build with `vercel deploy --prod --skip-domain --scope <team>`.
   Confirm the exact commit and production environment before building.
5. Verify `/api/health` returns HTTP 200 with `status: "ok"`, login and role guards,
   authorized walk-in registration, cashier collection/refund, clinician history,
   referral reads, and the permitted lab workflow. A READY deployment is not a
   successful application health check.
6. Promote the same tested deployment with `vercel promote <deployment-url>
   --scope <team>`, then recheck the stable domain. Preserve the previous deployment
   and document which database changes allow or prevent application rollback.

## Clinic activation

Use verified clinic owner/staff accounts and the clinic's actual service catalogue,
prices, doctor availability, and operating mode. Default to walk-ins; do not invent
appointment slots or payroll policies. Existing patient history must remain visible
to authorized clinicians after upgrade.

Clinic-specific Telegram bots are activated through the clinic dashboard. Do not
manually replace their webhooks with a legacy global route. Verify the webhook
secret, actual successful delivery, consent, and notification jobs before claiming
messaging is operational. Inspect existing scheduler configuration before adding
jobs; avoid duplicate schedules.

Payroll, inpatient workflows, comprehensive finance, device adapters, and lab
release are not made complete by deployment. See
[PILOT_IMPLEMENTATION_CHECKLIST.md](PILOT_IMPLEMENTATION_CHECKLIST.md).
