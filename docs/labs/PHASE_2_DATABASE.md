# Laboratory Module — Phase 2 Database Foundation

Status: **implemented and tested locally; not deployed.** No migration has
been applied to any hosted database. Design: `PHASE_1_DOMAIN_MODEL.md`.

## Migrations

| File | Contents |
|---|---|
| `20261005000001_patient_lab_identity.sql` | `patients.date_of_birth`, `sex` (`patient_sex`, NULL = unknown), `document_number`, `pinfl`; normalisation trigger; duplicate pre-flight; per-clinic partial unique indexes (O1) |
| `20261005000002_lab_catalog.sql` | `lab_test_categories`, `lab_tests`, `lab_test_parameters`, `lab_reference_ranges`, `lab_panels`, `lab_panel_tests`; overlap / type validation of ranges; fixed parameter identity; config audit; staff read, server write |
| `20261005000003_lab_orders_samples.sql` | `lab_orders`, `lab_order_items`, `lab_samples`, `lab_sample_items`; any-staff ordering with recorded orderer; consultation provenance FK; DOB required; catalog-derived snapshots; order / item / sample lifecycles; one live sample per item (row lock); id-only audit; server-only |
| `20261005000004_lab_results_documents.sql` | `lab_results` (versions, second-person verification O4, corrections supersede atomically), `lab_result_values` (unit / range / flag set by the database), `lab_documents` (withdraw-only) + private bucket `lab-documents`; id-only audit; server-only, RLS without policies |

`supabase/full-db-setup.sql` regenerated (`npm run db:full-setup`, `--check`
clean). `src/lib/supabase/database.types.ts` extended with the new tables,
enums and patient columns (see *Verification* for how). `clinical-isolation.test.ts`
now forbids `lab_results`, `lab_result_values` and `lab_documents` in AI and
patient-facing code.

## Deliberately not in this phase

- `staff_role` value `lab` → Phase 3 (permissions). Until then the database
  only requires lab actors to be staff of the clinic.
- `payments` lab-order subject → Phase 6; `notification_job_type`
  `lab_result_ready` + job subject → Phase 16. Both touch booking/payment and
  notification code paths and ship with their regression tests.
- Panel price allocation function (O2) → Phase 5 ordering. The schema stores
  `list_price_snapshot` and the allocated `price_snapshot`; single-test items
  are forced to their list price by the database.
- Retention: no period defined. Lab rows do not cascade from `patients`
  (deleting a patient with lab history fails); clinic erasure removes them.

## Verification

Run locally on 2026-10-05:

| Check | Result |
|---|---|
| All 51 migrations + seed from an empty database | applied |
| `src/lib/supabase/lab-domain.test.ts` | 30/30 passed, 3 consecutive runs |
| `npm test` (whole suite) | 452 passed, 0 failed, 287 skipped (REST-API suites) |
| `npm run typecheck`, `npm run lint`, `npm run build` | passed |
| `scripts/build-full-db-setup.mjs --check` | up to date |

The lab suite covers: valid creation end to end; identity normalisation and
per-clinic uniqueness; catalog read/write access; cross-clinic catalog,
patient, doctor, sample, item and result references; consultation provenance
and doctor impersonation; DOB requirement; inactive tests; forged snapshots
and prices; idempotency; order cancellation rules; item / sample / result
transition rules; configuration-derived flags (sex, age, critical, choice,
unranged); second-person verification; immutable verified results and
versioned corrections; concurrent sample collection and concurrent
verification (one winner each); document provenance and withdrawal; no direct
access for any signed-in or anonymous role; RLS backstop behaviour; audit rows
without values or comments; patient-deletion protection; clinic erasure.

**How it was verified, and what was not:**
- The Supabase Docker images could not be pulled in this environment (proxy
  denial), so the database suites ran against local **PostgreSQL 16** with a
  minimal stand-in for Supabase's `auth` / `storage` schemas and API roles.
  Production uses Postgres 17 under Supabase. CI's `database` job runs the
  real Supabase stack and is the authoritative check.
- The REST-API-based suites (`integration`, `tenant-isolation`,
  `role-authorization`, `booking-engine`, …) were skipped locally for the same
  reason; they run in CI.
- `database.types.ts` could not be generated with `supabase gen types` (same
  image restriction). It was produced by a script reading the local schema,
  which was first shown to reproduce all 26 existing tables, 18 enums and
  their constants in the file byte-for-byte.
