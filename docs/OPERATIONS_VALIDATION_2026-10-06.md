> Historical validation snapshot. See [pilot validation](PILOT_VALIDATION_2026-10-06.md) for the later full local integration and browser results.

# Operations revision validation — 2026-10-06

These results validate the current local checkout, including uncommitted changes. They are not production approval. See [the revision report](OPERATIONS_REVISION_2026-10-06.md) for implemented scope and remaining replacement work.

| Check | Result |
|---|---|
| Complete ordered migration replay | All 48 SQL migrations passed on isolated PostgreSQL 16.14, one transaction per file |
| Database operation/security checks | 55 passed using synthetic fixtures |
| `npm run typecheck` | Passed |
| `npm test` | 41 test files passed, 17 skipped; 319 tests passed, 160 skipped |
| `npm run lint` | Zero errors; one existing unused `servMap` warning in `scripts/seed-clinic-catalog.ts:78` |
| `npm run build -- --webpack` | Passed on the final application code |
| `git diff --check` | Passed |

## Database evidence

The repeatable harness is [scripts/test-operations-db.py](../scripts/test-operations-db.py). It creates a randomly named disposable database on a local Unix socket, replays every migration, tests real PostgreSQL policies/functions/constraints and drops its own database. It uses minimal Supabase auth/storage scaffolding; no production credentials or patient records are required.

The 55 checks cover registration and server pricing, retry payload binding, cross-clinic and role denial, immediate referral history access, private notes and append-only clinical authorship, queue state conflicts, privileged RPC grants, exposed-table RLS, staff membership controls, manual collection/refunds, immutable tenant/identity fields, restricted financial summaries and uncertain notification quarantine. Concurrent tests exercise eight distinct arrivals and eight retries of the same arrival; duplicate retries create one charge.

Reproduce against a disposable local PostgreSQL instance:

```bash
PGHOST=/path/to/local/unix/socket PGPORT=5432 python3 scripts/test-operations-db.py
npm run lint
npm run typecheck
npm test
npm run build -- --webpack
```

## Limits

- No hosted database, actual clinic data, deployed migration history or production environment was inspected or changed. Fresh schema replay does not establish that existing production rows satisfy the new constraints.
- The 160 skipped tests require the full local Supabase HTTP/Auth/PostgREST/Storage stack. PostgreSQL tests do not substitute for those suites. A logged-in browser workflow was not tested.
- The default Turbopack build encountered an environment restriction when opening its worker port. The supported webpack build passed; this does not assert that the default build passed.
- No live payment, bank refund, fiscal receipt, Telegram delivery or external government integration was verified.
- Renumbered previously uncommitted referral migrations require comparison with any environment that already applied an earlier version before deployment.

Full local Supabase integration tests, browser workflows, reviewed data migration and clinic reconciliation remain release gates. Inpatient operations, comprehensive billing/expenses/payroll and laboratory fulfillment remain product work.
