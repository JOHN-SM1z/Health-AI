# Hosted release preflight — 7 October 2026

Release candidate: `9f99d8d4c57c2aa08452fded624379cef66667ee`, branch
`codex/clinic-operations-pilot`. **Not deployed; database compatibility failed.**
The local validation in `PILOT_VALIDATION_2026-10-06.md` does not establish
compatibility with an existing hosted database.

## Verified hosting state

Both Vercel projects belong to team `handly` and deploy `JOHN-SM1z/Health-AI`.
Their production branch is `main`. Latest production deployments reported READY
at commit `eab4f3650b9993024ff84e8f97c1c294b3c907dc`.

| Project | Production domain |
| --- | --- |
| health-ai | https://health-ai-neon-nine.vercel.app |
| health-ai-w1vc | https://health-ai-w1vc.vercel.app |

The repository has no local Vercel project link. The owner has been asked which
project is the intended live clinic target. Connector reads returned 403 for the
team, but explicitly scoped authenticated CLI reads succeeded.

Read-only HTTP checks found `/login` returned 200 on both stable domains, but
`/api/health` returned 500 on `health-ai` and 503 (`status: degraded`) on
`health-ai-w1vc`. Recent health-route logs identify an invalid/missing production
`TELEGRAM_WEBHOOK_SECRET` configuration on `health-ai`. The `health-ai-w1vc`
health failure still needs database connectivity/key diagnosis. Existing READY
deployments therefore must not be described as ready for clinic use.

## Verified database incompatibilities

Metadata-only reads inspected production `cpoiachyfozjnlguaykz` (Health AI) and
staging `qoupbbsspzfyjqfzykuk` (Health AI staging). No patient rows were retrieved.
`scripts/release-schema-preflight.sql` executed successfully against both and
returned 22 missing prerequisites per database: 16 columns and 6 RPC signatures.
Neither returned a public table with RLS disabled. This is a narrow prerequisite
check, not a complete security or data-integrity audit.

- Production stores clinician history in `clinical_records`; this branch reads
  `clinical_notes`. Deploying the UI alone would not show existing history.
- Hosted referrals use `reason`, `handoff_note`, `creation_key`, and
  `revoked_reason`; this branch expects `referral_reason`,
  `clinical_handoff_note`, `idempotency_key`, `revocation_reason`, and `updated_by`.
- Hosted databases lack this branch's `visits`, payment visit linkage,
  stable patient number column, and operations RPCs.
- Staging already contains another laboratory implementation from open PR #14,
  branch `claude/sharp-ptolemy-rl1rnc`. It uses `lab_orders`, `lab_samples`,
  and `lab_results`; this branch's incompatible `lab_orders` definition and
  draft workbench must not be applied over it.
- Migration versions overlap with different meanings: staging
  `20261005000001` is `patient_lab_identity`, whereas this branch uses that
  version for `walk_in_operations`. Production also has remotely assigned
  migration versions. A migration-history repair would conceal these differences.

## Required integration before promotion

1. Confirm the live Vercel target. Preserve both current deployments until then.
2. Integrate current main and PR #14 with the walk-in work in an isolated checkout.
   Preserve clinician history, referral provenance, laboratory data and existing
   payment records. Choose one canonical laboratory schema and adapt the UI/RPCs;
   do not create parallel clinical histories or silently discard existing data.
3. Produce new, forward-only compatibility migrations after inspecting hosted
   schema definitions. Do not replay the fresh-install chain or repair version
   history to pretend migrations were applied.
4. Rehearse the upgrade against a representative schema with synthetic data,
   including old clinical history, referrals, payments, and laboratory orders.
   Verify preservation and authorization as well as clean-install behavior.
5. Verify backup/restore availability and environment configuration for the
   selected project. Do not assume PITR from historical documentation.
6. Run lint, typecheck, all tests, build, database authorization/integrity checks,
   and authenticated browser workflows for the integrated release.
7. Stage a production-environment deployment without domain assignment, verify
   runtime and database behavior, then promote that same tested artifact.

No production or staging schema, deployment, domain, environment, webhook, or
patient data was changed during this preflight. Payroll and device adapters remain
out of scope. This branch's lab verification/release remains unavailable; the
other laboratory implementation has not been audited or approved by this check.
