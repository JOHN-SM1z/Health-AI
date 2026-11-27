# Pilot validation — 2026-10-06

This is a development candidate, not a production release or complete clinic replacement. See [the implementation checklist](PILOT_IMPLEMENTATION_CHECKLIST.md) for unfinished work and clinic inputs. Payroll remains deferred.

## Executed checks

| Check | Result |
|---|---|
| Fresh isolated PostgreSQL migration replay | 50 migration files passed, one transaction per file |
| Database operation/security regression harness | 72 checks passed, including concurrent arrivals/retries and laboratory authorization/transitions |
| Complete application suite with isolated Supabase Auth/PostgREST/database | 60 files, 486 tests passed; no skipped tests |
| TypeScript | `npm run typecheck` passed |
| ESLint | Zero errors; one existing unused `servMap` warning in `scripts/seed-clinic-catalog.ts:78` |
| Supported webpack build | `npm run build -- --webpack` passed |
| Default build | Turbopack hit the environment's worker-port restriction; not reported as passing |
| Browser journey | Synthetic receptionist registration/talon, denied clinical access, owner cashier collection, queue payment status, doctor visit/history, laboratory order/specimen progression/draft result passed |
| Responsive inspection | Laboratory desktop and 390px mobile screenshots inspected; no horizontal page overflow |

The full local suite exposed and helped correct PostgREST payment relationship cardinality after composite foreign keys, missing legacy referral acceptance timestamps, outdated referral fixtures, time-dependent appointment fixtures, and tests that inferred revenue without payment records. Repeated fixture runs now isolate booking doctors rather than competing for the same seed doctor's slots.

The browser walkthrough exposed a login navigation/refresh race that reset form state. Login now opens a fresh authenticated document. The reproducible browser script waits for login navigation to settle. The workbench retains draft status, preserves result revisions and does not expose release actions.

## Reproduction

Use an isolated local Supabase project with a distinct project ID and ports. Apply this checkout's migrations and synthetic seed data. Do not reset another developer's local database or a hosted project.

```bash
# Redirect status output: it includes local credentials and must not enter logs or Git.
supabase status --workdir /path/to/isolated-stack -o json > /private/tmp/pilot-status.json

# Run all application tests using that stack's settings, without editing real env files.
node scripts/pilot-local.mjs /private/tmp/pilot-status.json /private/tmp/unused-fixture.json test

# Create a NEW synthetic clinic and accounts; private file must be outside this repository.
node scripts/pilot-local.mjs /private/tmp/pilot-status.json /private/tmp/pilot-fixtures.json
node scripts/pilot-local.mjs /private/tmp/pilot-status.json /private/tmp/pilot-fixtures.json serve

# In another terminal, with Playwright and its browser installed/available:
# NODE_PATH may point to an existing Playwright package installation.
node scripts/pilot-browser.mjs /private/tmp/pilot-fixtures.json /private/tmp/pilot-screenshots
```

Use fresh fixtures for each browser run. The script intentionally creates records; it does not erase financial or clinical history to make a test reusable. The local API URL must be loopback. Dispose of the dedicated test stack/credentials after use. The SQL harness remains independently reproducible using `scripts/test-operations-db.py` and a disposable local Unix-socket PostgreSQL instance.

## Practical limits

- No production database, deployment or patient-data import was changed. Existing deployed migration histories and data still require review, especially previously uncommitted referral migration versions.
- The browser check covers a representative outpatient journey, not every role/action, failure mode, printer or scanner.
- Real bank execution, fiscal receipts, Telegram delivery, laboratory devices and government interfaces were not exercised.
- Laboratory orders currently use explicit test names and one specimen type, without automatic billing/catalogue mapping. Accession text is not a scan-validated barcode. Only authorized active doctors can use the current workbench; lab-operator/verifier permissions and approved clinical release policy are pending.
- Result verification, release, corrected released reports and private patient delivery remain disabled/unimplemented. Inpatient workflows, comprehensive billing/reconciliation and expenses remain product work.
- Clinic acceptance, recovery/restore rehearsal and pilot reconciliation remain required before real use.

## Local database advisor

The security advisor completed with no errors and two existing warnings: the shared `set_updated_at` trigger function has no pinned search path, and `btree_gist` is installed in `public`. New privileged laboratory functions have fixed search paths and restricted execution grants. These inherited warnings remain visible for the pre-release database review; the advisor result is not a production certification.
