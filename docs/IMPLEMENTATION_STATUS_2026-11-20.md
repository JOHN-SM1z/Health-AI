# Specification implementation status — 20 November 2026

The reported migration, compiler and legacy-suite blockers have been repaired. Lint, typecheck, production compilation, the complete real-database Vitest suite, and clean-install/upgrade rehearsals pass. The complete production-build browser and HTTP gate also passes. This document supersedes the earlier blocked-state report for this working tree.

The implementation follows [the specification analysis](SPECIFICATION_IMPLEMENTATION_ANALYSIS_2026-11-20.md). Work preserved the extensive existing edits on `codex/clinic-operations-pilot`. No production database was accessed or migrated, no real patient data was inspected, and no deployment was performed. Tests used generated local clinics, accounts and patient fixtures. External Telegram and SMS delivery was mocked or used the local test outbox.

## Canonical migration history

Remote `main` was fetched and verified at `990d082274575baadc402e9c7732d27fc56b1f45`, the intended specification baseline. Its **84 original migrations remain byte-identical**, pinned by `supabase/migration-lineage.json` and checked in tests. The stale local `main` ref was not used as the baseline.

Nineteen conflicting pilot migrations were preserved unchanged under `supabase/legacy-migrations/clinic-operations-pilot/`, with SHA-256 hashes. They are excluded from automatic migration replay. See [archive and upgrade rules](../supabase/legacy-migrations/README.md).

The active history now has **94 uniquely versioned migrations**: the canonical 84 plus 10 forward changes. The new final convergence migration restores `set_updated_at()` to a safe `pg_catalog` search path after the canonical baseline's later definition; historical canonical SQL was not edited. `supabase/full-db-setup.sql` was regenerated and its drift check passes. The generator rejects duplicate migration versions.

The new `npm run test:schema-rehearsal` creates and removes three disposable databases. It verifies:

- A fresh ordered application of all 94 migrations.
- An upgrade from the 84-migration canonical baseline through the 10 forward migrations.
- Equivalent tables, defaults, constraints, functions, indexes, triggers, RLS policies and role grants after those paths.
- Equivalent schema from the generated SQL-editor bundle.
- The updated read-only release preflight, targeting canonical clinical records, outpatient ledger, lab domain, booking/access and worker RPCs.

An installation that actually applied the archived pilot schema is a different data-conversion project. Its migration ledger and data must be inspected and mapped before upgrading. Do not reset a populated database, erase its ledger, or apply the full-setup bundle over it. This repair proves canonical upgrades, not conversion of unknown deployed pilot databases.

## Source and API compatibility

- Legacy clinical-note reads and referral-history reads now use the audited canonical clinical workspace. Clinical writes require a consultation, record type and idempotency key and create immutable `clinical_records`. Legacy unaffiliated/private-note writes are rejected.
- The compatibility referral access helper resolves the active doctor in the verified clinic, then calls the authoritative two-argument database access predicate. It reads only referral permission metadata. Database errors fail closed; management receives no clinical bypass.
- Referral action bodies reject forged/unknown lifecycle fields. Expiry and patient-history permissions remain enforced by the database-backed canonical services.
- Legacy operations list/arrival and analytics reads delegate to current routes. Retired queue/payment mutation contracts return authenticated `410 endpoint_replaced` responses pointing to current transactional reception and idempotent kassa APIs. They cannot revive obsolete RPCs or directly set payment state.
- Legacy laboratory reads delegate to the doctor lab dashboard; obsolete order writes point to the validated patient-order API. Old cashier, operations and laboratory screens redirect or render current workflows. Shared input/select controls now forward correctly typed native HTML attributes.
- Referral, staff-directory, queue, laboratory and payment fixtures now match current authorization and query contracts. Obsolete management-access assertions were removed in favor of current denial and provenance checks. Existing broad canonical database, RLS, authorization, concurrency and adversarial suites execute successfully.

## Worker safety and privacy

The earlier implementation batch is retained:

- Renew/finalize RPCs fence every notification outcome by clinic, job, claim token, state and database-clock lease. Renewal rechecks human takeover. Browser roles cannot call these RPCs.
- Telegram/SMS workers renew before sending and finalize through the same fence; no unguarded id-only fallback overwrites another worker's state.
- Ambiguous delivery is quarantined for review. A timeout/null response cannot trigger automatic duplicate delivery. Definitive preparation/rejection failures retain bounded retries. Receipt/finalization errors are never reported as successful delivery.
- Telegram fallback avoids a third send after an ambiguous second attempt. Selected Telegram, transcription and API error boundaries omit identifiers, upstream response bodies and raw exceptions.
- Real-database notification tests cover verified successful delivery exactly once, medical-value exclusion, ambiguous-delivery quarantine and changed-recipient denial. Unit tests cover stale ownership, retries, receipt failures and fallback ambiguity.

The legacy Telegram adapter cannot distinguish every definitive rejection from unknown acceptance. Quarantining every null response is intentional and can require manual review. A later typed provider-status interface may reduce that operational burden.

## Test and build isolation

Vitest and E2E load `.env.test` or safe example defaults only; they do not preload `.env` or `.env.local`. Supabase API/database targets must be loopback, and database URL query overrides are rejected before creating clients. E2E requires explicit disposable local database credentials. Session-expiry tests take their signing secret only from test configuration, never another stack's secret files. The owner bootstrap requires explicit email/password credentials and omits the password and unexpected raw exceptions from its output; its local replay and missing-credential refusal were verified.

`REQUIRE_TEST_DATABASE=true` makes unavailable database fixtures a hard failure. Database CI sets this flag. Real-database runs bound concurrency to two workers and allow 30 seconds per multi-request test and 60 seconds per fixture hook. Fast unit-only runs keep normal timeouts. Immediate provider polling tests explicitly schedule their jobs as due rather than relying on host/database clock timing. The outpatient browser check awaits the completion response, verifies persisted status and waits for removal from the queue; it no longer closes the page after an arbitrary 500ms delay. Browser error listeners are detached immediately before an intentional context close so interrupted polling during teardown is not mistaken for a workflow failure. A real-browser sentinel check confirms that active console errors are still recorded.

`npm run build` uses the documented Next.js Webpack build. The default Turbopack worker could not bind a port in the managed environment. The successful production build used explicit inherited local-stack variables; compiled browser chunks were checked to reference the isolated local API. Runtime production fail-closed checks remain enabled.

Archived/generated files are excluded from TypeScript, ESLint and the Docker build context. This prevents restored backups and agent worktrees from being compiled or copied into the server image.

## Verification evidence

| Gate | Result | Evidence/scope |
| --- | --- | --- |
| `npm run lint` | Passed, no warnings | Active project source and tests. |
| `npm run typecheck` | Passed | Active routes, UI, libraries and test contracts. |
| Full `npm test` | 1,353 passed in 153 files; zero skipped | Required real Supabase Auth, PostgREST, Storage and PostgreSQL 17.6, plus unit/API suites. Includes the positive verified-delivery/privacy regression. |
| `npm run build` | Passed | Production Webpack/standalone build, all 56 static pages; verified local browser configuration. |
| `npm run test:notification-claims` | 22 checks passed | PostgreSQL 17.6; concurrent claims, ownership/tenant fencing, lease expiry, cancellation, takeover, quarantine and RPC grants. Also passed on native PostgreSQL 16.14. |
| `npm run test:schema-rehearsal` | Passed | Clean install, canonical upgrade, complete schema/grant equivalence, SQL bundle and preflight on PostgreSQL 17.6 and 16.14. |
| Historical DB-audit regressions | 28 passed | Disposable native PostgreSQL cluster. |
| Generated SQL drift and `git diff --check` | Passed | Aggregate matches the active migration set; no whitespace errors. |
| `npm run test:e2e` | 522/522 checks passed across all 25 workflows | One uninterrupted successful run after the timing/teardown fixes; pinned Playwright 1.56.1 / Chromium 141, isolated app and synthetic clinic. |

The temporary standalone app server and native PostgreSQL rehearsal cluster were stopped. The isolated Supabase test stack remains running at API port 59321 / database port 59322 so `.env.test` can reproduce the tests. All generated rehearsal databases were removed. No container image was built and no deployment was performed.

Local evidence logs and browser artifacts are under ignored `tmp/blocker-repair/`; credential files there and `.env.test` must remain untracked. The approved force restart recovered Docker. Only this task's compiler cache and partial browser downloads were removed to recover disk space; existing databases, patient backups and unrelated Docker volumes were not deleted.

## Scope remaining outside this repair

These passing engineering gates do not implement or approve real Click/Payme/Rahmat payments, OneID agreements, speech/recording providers, national prescribing, identity-encryption rollout or production hosting/cutover. Their requirements and decisions remain in the specification analysis. Production deployment still requires reviewing the target's actual migration ledger, operational configuration and release artifact; this task performed no deployment.
