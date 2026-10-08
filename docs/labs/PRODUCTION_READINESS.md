# Laboratory Module — Production Readiness (Phase 21)

Date: 2026-10-06. Branch `claude/sharp-ptolemy-rl1rnc` (Phases 0–21), draft PR #14.

**Overall verdict: CONDITIONALLY READY.**

The internal laboratory workflow can go to a first clinic once the conditions in [§ 3](#3-conditions-before-go-live) are met. That workflow is: order → manual payment → collection → result entry → second-person verification → doctor and patient access.

Three features are not ready to switch on, and all three ship switched off:
- AI summaries;
- external-laboratory integration;
- critical-result alerts (deferred by the owner).

**What this review is and is not**
- This is an engineering review of the code, the database and the evidence from tests.
- **Nothing was deployed and no production or staging migration was applied.** Everything ran against a local Supabase stack (PostgreSQL 17.11).
- **This document makes no claim of legal or regulatory compliance.** That includes data protection, medical-records law, fiscal receipts, and AI-provider data processing. Those questions are open and are listed as owner decisions.
- **Retention decided (owner, 2026-10-07):** clinical and lab data are kept indefinitely; terminating a clinic
  keeps its data. Since `20261008000004` the database refuses to delete clinics, patients, clinical records
  and referrals, so lab data cannot be erased through them either. Legal review of the policy is still the
  owner's.

## 1. Verdicts at a glance

| Area | Verdict | Why, in one line |
|---|---|---|
| Database | **CONDITIONALLY READY** | Clean dry-run on populated pre-lab data, and the schema is identical to a clean build. It has not yet run on staging or a production copy, and there is no confirmed backup before applying. |
| Application | **READY** (after B1) | Authorization, validation, idempotency, retries and error handling are tested end to end. Three gaps found in this review were fixed: **B1 was a go-live blocker** (no way to record a date of birth, so no lab order could be placed); R1 and R2 were small. |
| Documents | **READY** | Private bucket; 20 MB limit and type check; 60-second signed links; withdrawn, never deleted; audited. Open: file retention, and storage cleanup on clinic erase. |
| Notifications | **CONDITIONALLY READY** | Atomic claims, idempotency keys, retry and give-up are tested. Real Telegram delivery is unverified. Patient messages ride the 15-minute notification cron. |
| Payments | **CONDITIONALLY READY** | Server-controlled manual payments, audited, refunds as a whole-bill status. There are no receipts and no partial refunds; the owner must accept that, or have them built. |
| Clinical records (lab results) | **CONDITIONALLY READY** | Authorship, versioning, access and audit are enforced in the database and the server. Retention and legal requirements are an open owner decision. |
| AI | **READY while disabled; NOT READY to enable** | The computed fallback is verified, and so are the safety checks and injection handling. Before enabling: choose a provider, sign a data-processing agreement, and review real answers. |
| Historical migration (import) | **CONDITIONALLY READY** | Dry-run analysis, duplicate and match handling, partial failure and audit are verified with synthetic files. It has not been run on a real export from the old system, and exact matching by PINFL or passport is unavailable until those can be recorded (B2). |
| External laboratories | **NOT READY (by design, off)** | Only a mock adapter exists, and it is refused in production. No real provider API has been verified. |
| Critical-result alerts | **Deferred** | Owner decision: not needed now. |

## 2. Evidence by area

### 2.1 Database

**Migration dry-run on a populated pre-lab database (new in this phase).**
1. A scratch database was built in the local Postgres cluster with the Supabase base schemas (`auth`, `storage`, …).
2. It received all 47 pre-lab migrations and the seed.
3. It was then filled with production-shaped data:
   - 302 patients across 2 clinics, 50 of them with duplicate names;
   - 300 completed or cancelled appointments;
   - 300 payments (paid and pending);
   - 120 legacy doctor records, among them free-text `lab_result` records;
   - 723 audit rows.
4. The 21 lab migrations `20261005000001`–`…021` were applied **one file at a time** with `psql -v ON_ERROR_STOP=1`.

Results:

| Check | Result |
|---|---|
| Each migration applies | 21/21, about 80–160 ms each at this size |
| Pre-lab data unchanged | MD5 fingerprints of patients, appointments, payments, clinical records, audit events and staff roles were **identical before and after** |
| Resulting schema | `pg_dump --schema-only` of `public` is **identical** to a clean `supabase db reset` (tables, constraints, indexes, functions, policies and grants). The only differences are the scratch database's own default privileges, which are environment setup, not migrations |
| Existing rows satisfy the new constraints | Yes. For example, `payments_one_subject_check` holds for every existing appointment payment, and the new patient checks hold because the new columns are empty |
| Transaction safety | Each file also applies under `--single-transaction`, including the enum additions (`000005`, `000013`, `000018`) |
| Partial failure | `000008` was run with an injected error at its end. Nothing from it remained: `payments.lab_order_id` was absent and `appointment_id` was still NOT NULL. It then re-applied cleanly, and the remaining 13 followed |
| Ordering | Lab migrations sort after everything on `main`. `origin/main` is an ancestor of the branch and has no newer migrations |

**The previous app on the new schema (new in this phase).**
- `origin/main`'s complete test suite was run against the fully migrated local database: **709/709 passed**.
- One test, an unscoped notification-claim count, failed once because jobs from parallel suites were left in the shared database. It passed on rerun. The branch already scopes that claim (Phase 16).
- Conclusion: rolling back the application alone, without the schema, leaves the existing booking, payment, referral and clinical features working. See [§ 4](#4-rollback-and-reversal).

**Constraints, foreign keys, RLS** (Phases 2–3, 19)
- Every lab table has RLS enabled.
- Result tables, documents, imports and send-outs give signed-in roles **no** privileges; the server reads them and audits each read.
- Tenant integrity uses composite foreign keys that include `clinic_id` (and `patient_id` where the row belongs to a patient), so a row cannot point into another clinic or patient.
- Phase 19 revoked TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every public table, and restricted `payments` to non-amount columns for signed-in users.
- Evidence:
  - `lab-domain.test.ts`, `lab-security-review.test.ts`, `tenant-integrity.test.ts`;
  - 352 database tests in total.

**Indexes**
- Every hot path has an index:
  - the queue (`lab_order_items_status_idx`);
  - patient history (`lab_orders_patient_idx`, `lab_order_items_patient_test_idx`);
  - dashboards (`lab_orders_created_idx`, `lab_orders_ordering_doctor_idx`, `lab_results_verified_idx`);
  - workers (`lab_external_requests_due_idx`, `notification_jobs_due_idx`);
  - idempotency (`lab_orders_creation_key_key`, `payments_lab_order_key`).
- A catalog query found foreign keys whose child column is not the leading column of any index. They fall into three kinds:
  - **actor columns**: `*_by` references to `profiles`;
  - **`clinic_id`-only references**: on parameter, range, panel, sample-item, value, import-row and provider-code tables;
  - **a few secondary references**: `notification_jobs.lab_order_id`, `lab_import_rows.lab_result_id`, `lab_external_requests.result_id`, `lab_result_values.reference_range_id`.
- These indexes would only be used when a **parent row is deleted**. The application never deletes any lab row:
  - the catalog is deactivated;
  - documents are withdrawn;
  - results are superseded;
  - the only `delete()` in lab code replaces a provider's code mapping.
- So they matter only for a platform-level **clinic erase**, where they make the cascade slower, not wrong.
- **Recommendation, not blocking:** if clinic erase becomes an operational task, add those indexes in a follow-up migration. Nothing was added now, to keep the production migration set unchanged after its dry-run.

**Locks during apply**
- `000001`, `000008`, `000014`, `000016` and `000019` alter existing tables (`patients`, `payments`, `notification_jobs`), and `000016` adds triggers to `appointments` and `clinical_records`.
- These statements take short exclusive locks, and the new CHECK constraints scan the existing rows.
- At the dry-run size this was milliseconds. Apply in a low-traffic window anyway.

**Database conditions**

| | Condition |
|---|---|
| D1 | Apply the 21 migrations to **staging, or a copy of production**, first. Then run the E2E suite there (`npm run test:e2e` refuses non-local targets by design (`assertLocalOnly`), so staging checks are the manual smoke test in § 3). |
| D2 | Take and **verify a backup** immediately before applying to production: Supabase PITR, if the plan includes it, or `pg_dump`. Whether PITR is available on the project's plan was not checked. |
| D3 | Confirm the hosted Postgres major version. On 17 or newer the `MAINTAIN` revoke applies; on older versions it is skipped by design. |
| D4 | **Do not use `supabase db push` on the existing production project.** Its migration history was written by name with fresh version stamps (for example version `20260911102114` named `20260821000001_telegram_…`), so the CLI's version comparison sees none of the repository's 68 files as applied. It refuses to push, or tries to re-run them. Apply only the 21 lab files, **in filename order, one transaction per file**, recorded under their file names as before: the SQL editor, `psql --single-transaction -v ON_ERROR_STOP=1 -f`, or the Supabase MCP `apply_migration` with `name` = the file name. Check by name afterwards (`STAGING_ACCEPTANCE.md` A3). Never hand-edit a file. `full-db-setup.sql` is for an empty project only. |
| D5 | Checked read-only on 2026-10-06: the project "Health AI" (PostgreSQL 17.6, so the `MAINTAIN` revoke applies) has `20260930000006_tenant_integrity_hardening` as its latest migration, the same as `main`. That is the base the dry-run used. It has no development branches, so **no staging environment exists yet**. |
| D6 | **Staging database built on hosted Supabase (2026-10-06).** A separate free project, "Health AI staging" (`qoupbbsspzfyjqfzykuk`, ap-northeast-1, PostgreSQL 17.11), with no production data. How it was built:<br>• the 68 migrations and the seed were fetched by the database from this repository, pinned to commit `ce4ccab`;<br>• each file's SHA-256 matched the repository file exactly (69/69);<br>• they were applied in order, in transactions split at the enum additions, and recorded under their real versions and names;<br>• the pre-lab migrations went first, then the seed's rows, then the 21 lab migrations on top.<br>Results:<br>• all applied;<br>• `STAGING_ACCEPTANCE.md` checks A3–A8 pass;<br>• the schema fingerprint (45 tables, 299 function bodies, 57 policy rules, 84 triggers, 199 indexes, 348 constraints) is **identical** to the local build;<br>• Supabase's security advisor lists no lab function callable through the API; its other findings are pre-existing or intentional (RLS without policies on server-only tables). |

### 2.2 Application

| Property | Evidence |
|---|---|
| Authorization | Each route goes through `requireLabCapability` / `requireRoles` / `requireLinkedDoctor`, and patient routes through verified Telegram `initData`. Doctors reach patients only through `doctor_patient_access()` (own patient or active referral), checked again on every read. Phase 19 verified 15 required properties and found and fixed F1–F4. `lab-redteam.test.ts`, `lab-security-review.test.ts`, E2E HTTP red team 55/55 |
| Input validation | zod on every body (`parseBody`, which also enforces same-origin since F3); UUID checks on path ids; server-side price, test and patient resolution — the browser's price is ignored (critical path step 2) |
| Idempotency | Order `creation_key`; sample collection keys; repeated submit and verify change nothing; payment transitions are checked; notification `idempotency_key`; external send-outs keyed per item. Race tests: three concurrent orders → 1; three-way sample race → 1; verification race ×4 |
| Retries | Notification worker: release on error, retry, give up after the limit. External labs: backoff `BACKOFF_SECONDS`, `MAX_ATTEMPTS = 6`, leases. Shared rate-limit falls back to the instance limit if the database is unreachable |
| Error handling | `handleApiError` returns a generic `internal` 500 without details. Domain errors carry stable codes such as `order_has_samples` and `already_collected` |
| Rate limits | Shared (Postgres) limits on every lab-data read for doctors: history, result, document, summary. Also on imports, uploads, result saving and merges. Patient Mini App routes: per-IP, plus **per patient across instances (R1, this phase)**. Staff queue, catalog and configuration routes rely on authentication and clinic scoping, like the rest of the staff app; a platform-level limit (Vercel firewall or WAF) is recommended for all `/api/*` |
| Logging | Lab code logs error codes and ids only. All 51 logger calls in lab, patient and notification code were reviewed. **R2 (this phase):** the external-lab worker logged the raw message of an unexpected exception; it now logs the class or code only |
| Fail-closed configuration | Production refuses to start with the default `CRON_SECRET`. The mock lab adapter is refused in production unless `ALLOW_MOCK_LAB_PROVIDER=true` *and* the database is localhost. AI needs `ENABLE_AI=true` plus key and URL *and* the clinic's `aiSummaries`. `PAYMENT_PROVIDER` other than `manual` refuses to start without an adapter. The development Telegram identity is refused in production |

#### Found and fixed in this phase

**B1 — no lab test could be ordered for a real patient (go-live blocker).**
- Since Phase 2 the database refuses a lab order (doctor or desk) for a patient without a date of birth. The error tells staff "reception must fill it in before ordering".
- But nothing in the application could record a date of birth, or a patient's sex. The only patient update route saves the front-desk note.
- Every test and E2E run created its patients with the date written straight into the database, so none could catch it. Every existing patient has no date of birth, so in production **every first lab order would have been refused**.
- **Fix:** `PATCH /api/admin/patients/demographics` records the date of birth and sex:
  - the same roles as the patient card (owner, admin, manager, receptionist); the clinic comes from the session;
  - a real calendar date from 1900 to today in the clinic's time zone, with the database check as the last word;
  - sex is optional (unknown stays unknown, never guessed);
  - a record merged into another is refused (`patient_merged`);
  - audited as `patient_demographics_updated` with the names of the changed fields only, never the values.
- The patient card (`/admin/patients`) gains a "Shaxsiy ma’lumotlar" section with the two fields and a "Tug‘ilgan sana kiritilmagan" badge while the date is missing.
- **Tests:** `patient-demographics.test.ts` (4, real routes and database):
  - an order is refused with `dob_required`; reception records the date; the same order then succeeds;
  - audit rows hold field names only;
  - invalid dates, wrong roles, another clinic and merged records are refused.
- **E2E:** `lab-collection` now registers its patient without a date of birth; reception records it on the patient card before the walk-in order (15/15).


**R1 — patient lab routes were limited per instance only.**
- `requireMiniAppPatient()` is used by the three `/api/me/lab-*` routes. It used the in-memory, per-instance limiter, keyed by IP.
- The project's own rule (`src/lib/rate-limit.ts`) is that limits guarding clinical data use `sharedRateLimit()`.
- **Fix:** after the signature check, a shared per-patient limit (30 per minute per route) applies across instances. The cheap per-IP check still runs first.
- **Test:** `me/lab-results.test.ts` sends 31 requests from 31 different IPs. The first 30 get 200 and the 31st gets 429; another patient is unaffected.
- The test fails without the fix.

**R2 — an adapter exception's message could reach the logs.**
- The external-lab worker logged `e.message` for unexpected exceptions, in two places.
- Only the mock adapter exists today, but a future adapter could raise an error built from a provider's response, and that response contains patient data.
- **Fix:** log `ApiError:<code>` or the error class only.
- **Test:** `lab-external.test.ts` makes an adapter throw an error containing a patient name and value. It checks that the send-out is retried and then sent, and that neither the name nor the value appears in any `logger.error` / `logger.warn` call.
- The test fails without the fix.

### 2.3 Documents (Phase 11)

- **Storage:** private bucket `lab-documents`, server-only.
  - The only `storage.objects` policy is for `service_role`.
  - The bucket itself enforces a 20 MB `file_size_limit` and `allowed_mime_types` (PDF, JPEG, PNG, WebP).
- **Upload checks:** the server checks the size (413) and **sniffs the file's bytes** (`file-type.ts`), so a declared type is not trusted.
- **Downloads:** only through 60-second signed URLs, issued after the same authorization as the result. Each one is audited (`lab_document_viewed`).
  - Patients get only their own verified results.
  - Doctors get only patients they may access.
  - Withdrawn documents are refused.
- **No deletion.** Documents are withdrawn with a reason, and the row and bytes are kept. A storage object is removed only if its database row could not be written (`documents.ts`, orphan cleanup).
- Evidence: `lab-documents.test.ts`, E2E `lab-documents` 12/12, critical path step 10.

**Open**
- How long files are kept, and how they are eventually purged: owner and legal decision; nothing is purged.
- **Clinic erase removes the database rows but not the storage objects.** There is no application erase feature today; a platform operator erasing a clinic must also empty `lab-documents/<clinic_id>/`. The same applies to the existing `voice-messages` bucket.

### 2.4 Notifications (Phases 12, 16)

- **Duplicate prevention**
  - A unique `idempotency_key` per job (one "result ready" message per verified version).
  - Jobs are claimed with `FOR UPDATE SKIP LOCKED` (`claim_due_notification_jobs`).
  - A second worker run sends nothing (critical path step 8).
- **Retry and failure handling**
  - A failed send is released and retried.
  - It is given up after the limit (`lab-notifications.test.ts`).
  - The job is skipped if the patient's Telegram changed or the clinic stopped releasing results.
  - "Sent but not recorded" is logged with the job id only.
- **Content**
  - Patient messages contain no test name and no value: only the date and a button.
  - Staff in-app notifications contain no values.
- **Scheduling**
  - Patient Telegram messages are sent by `/api/notifications/process`, which production runs every 15 minutes (`supabase/ops/scheduled-jobs.sql`). So "result ready" can take up to about 15 minutes.
  - Staff in-app notifications are rows written at the event and need no worker.
  - **`/api/lab/providers/process` (external labs) is not in the schedule.** It is not needed while no real adapter exists; add it to `scheduled-jobs.sql` with the first real adapter.

**Open**
- Real delivery by Telegram, and rendering in Telegram clients, are unverified (stubbed in tests).

### 2.5 Payments (Phase 6)

- **Authoritative state:** the existing payment engine, extended so that a payment has exactly one subject (appointment **or** lab order).
  - The browser cannot set status or amount.
  - Signed-in roles cannot update `payments` (trigger), and since F2 cannot read amounts directly.
  - The amount is the stored bill; a forged amount is ignored (critical path step 2).
- **Refunds**
  - Cancelling a paid order marks the bill "Qaytarish kerak" (refund needed) at the Kassa.
  - The refund is a whole-payment status change, with the legal transitions enforced (`lab-kassa.test.ts`).
  - An unpaid bill drops to the remaining tests.
- **Audit trail:** `payments_audit` writes id-only rows for every change. Lab payment actions carry the actor.
- **Production mode:** `manual` only, as AGENTS.md requires. Click/Payme are not built for lab orders.

**Owner decisions (conditions)**
- **No receipts.** The repository has no receipt system, and any fiscal requirements are not assessed here.
- **No partial refunds.**
- Who may take payment: owner and administrator, as for appointments.

### 2.6 Clinical records — lab results (Phases 8–10, 14)

- **Authorship**
  - The person who enters, submits and verifies is recorded on the result.
  - The database checks eligibility (F4): lab staff, or a doctor with access to the patient, within the clinic's `verifiers` setting.
  - The verifier must differ from the enterer (O4).
- **Versioning**
  - A verified result is frozen.
  - A correction is a new version (`supersedes_result_id`) through the same two-person flow. The old version is kept and marked superseded.
  - Imported results keep `source = import` and their historical date.
- **Access**
  - Lab staff: the work queue and entry.
  - Doctors: through `doctor_patient_access()` only.
  - Patients: their own **verified** results, through verified Telegram identity, while the clinic releases results.
  - Reception and cashier: order and payment status, no values.
  - Every read is audited with ids only.
- **Deletion behaviour (verified)**
  - Lab history is **not** deleted with a patient: deleting a patient that has lab orders is refused by the foreign key (`lab-domain.test.ts` "never deletes a patient's lab history with the patient").
  - A merged patient cannot be deleted before unmerging.
  - Erasing a whole clinic removes its lab data ("erases a clinic together with all of its lab data"). There is no application feature for either deletion.
  - (The pre-existing `clinical_records` still cascade with a patient. That is the open legal question from `TASKS.md`, and is unchanged by this module.)
- **Retention behaviour:** kept indefinitely (owner decision 2026-10-07). Nothing is purged automatically; results, documents and import evidence (`lab_import_rows.raw`) stay, and the retention guard (`20261008000004`) stops clinic or patient deletion from erasing them.

**Owner decisions (conditions)**
- Retention periods and legal requirements for lab results, documents and import evidence.
- Whether imported historical results should be visible to patients. Today they are, if the clinic releases results; they never trigger a message.
- `releaseToPatient` defaults to **on**. Confirm per clinic before go-live.

### 2.7 AI (Phase 18)

- **Off by default, at two levels:** the deployment's `ENABLE_AI` with key and URL, and the clinic's `aiSummaries` (default false).
- **Disabled fallback:** the summary is computed without AI from verified values. The AI may only reword it. Disabled, unavailable or rejected all show the computed text with the same statements (critical path step 11; `rewrite.test.ts` 22 tests; E2E `lab-ai-summary` 8/8).
- **Safety boundaries**
  - Only structured, verified lab values reach the model: no clinical notes, history, names or identifiers.
  - Test and parameter names are sanitised (`cleanName`, 60 characters).
  - Doctors only, for patients they may access.
  - Each summary is audited with counts and status only.
- **Prompt-injection resistance:** the model's answer is shown only if it passes **all** of these checks; otherwise the computed text is shown:
  - same statement ids;
  - every number and date traceable to that statement;
  - forbidden diagnostic and treatment terms absent;
  - bounded length.

  A name crafted to inject instructions can change at most the wording of an answer that still has to pass these checks.
- **No autonomous diagnosis:** the facts are placement against configured ranges only. There is no diagnosis, treatment, prescription or alert.

**Not ready to enable until:**
- the owner chooses a provider and region, and signs a data-processing agreement. The statements contain values and dates.
- someone reviews real provider answers. The term check cannot catch a new analyte *name* added without a number; such an answer still has to pass the other checks.

### 2.8 Historical migration — import (Phases 13, 14)

- **Dry run:** every file is first *analysed*. Nothing is written to results until a second person confirms.
- **Patient matching**
  - Exact identifiers match.
  - Weak matches wait for staff confirmation.
  - Names alone never import.
  - Unmatched patients are reported, never created.
- **Duplicate detection**
  - Duplicate rows and already-imported results are reported.
  - Possible duplicate patients go to the merge tool (Phase 14). The tool is non-destructive and audited, can be undone, and is restricted to owner and administrator after a preview.
- **Partial failure**
  - A result is imported whole or not at all (`group_has_errors`).
  - Good groups import, and failed rows can be fixed and retried.
  - A report lists every row's outcome.
- **Input safety**
  - CSV only. A PDF data file is refused (`file_pdf_not_supported`).
  - Spreadsheet formulas are neutralised.
  - At most 5 000 rows per file.
- **Audit:** analysis, confirmation, the run, cancellation, row views and report downloads are audited (`lab_import_*` actions) with ids and counts.
- Evidence: `import.test.ts`, `lab-imports.test.ts`, `patient-merge.test.ts`, E2E `lab-import` 18/18, `patient-merge` 14/14.

**Condition**
- Run the import on a **real export** from the old system (encoding, date formats, column names) in staging, and confirm the reports, before importing for real.
- Windows-1251 files must be saved as UTF-8 first.

**B2 — exact matching needs identifiers the application cannot record (open, owner decision).**
- An import row matches a patient *exactly* by Health AI patient id, PINFL or passport/ID number. The database has columns for PINFL and the document number (Phase 2), but no screen or route records them.
- An old system's export will not carry Health AI ids. So until PINFL or passport numbers are recorded, every imported patient is at best a *possible match*: phone or full name **plus date of birth** (now recordable, B1), confirmed by a person, row group by row group.
- Whether reception should record PINFL or passport numbers is a privacy decision (national identifiers) for the owner. Nothing was added.

### 2.9 External laboratories (Phase 15)

The internal workflow does not depend on them. The adapter interface, retries, leases, webhook signatures and code mapping are tested with the mock adapter. **No real provider is integrated**, and the mock is refused in production.

Before connecting a real laboratory:
- verify the provider's API documentation and credentials;
- write and test the adapter;
- schedule `/api/lab/providers/process`.

## 3. Conditions before go-live

**Must be done (engineering and operations)**
1. Apply the migrations to staging, or a copy of production. Run the manual smoke test of the acceptance flow:
   - order;
   - pay at the Kassa;
   - collect;
   - enter;
   - verify by a second person;
   - doctor view;
   - patient Mini App view in Telegram on a phone;
   - document download;
   - cancel and refund.
2. Back up production and verify the backup. Then apply the migrations in a low-traffic window (D2–D4).
3. Confirm the 15-minute notification cron runs (`scheduled-jobs.sql` check query). Send one real "result ready" message to a test patient.
4. Create the lab staff accounts, with the lab role. Configure the catalog, reference ranges and lab settings per clinic.
5. Tell reception that a patient's date of birth (and sex, where known) is recorded on the patient card before the first lab order (B1). Every existing patient starts without one.
6. Keep `ENABLE_AI` off, or `aiSummaries` off, and configure no external provider.
7. Recommended: a platform-level rate limit for `/api/*` (Vercel firewall).

The step-by-step staging check is [`STAGING_ACCEPTANCE.md`](STAGING_ACCEPTANCE.md).

**Owner decisions (product, legal — not engineering)**
1. Retention of lab results, documents and import evidence, and the related legal requirements. No period is assumed.
2. Receipts and any fiscal requirements; partial refunds.
3. Patient release (`releaseToPatient`) per clinic, and the visibility of imported historical results.
4. Clinician and native-speaker review of the Uzbek wording, flags and reference ranges. Ranges are configured by each clinic; the system only places values against them.
5. Before AI is enabled: provider, region and data-processing agreement.
6. Critical-result alerts: deferred until the owner has consulted doctors and clinical managers.
7. Whether reception records PINFL or passport numbers, which the import needs for exact matching (B2).

## 4. Rollback and reversal

**The migrations are forward-only.** There are no down migrations, by design. Reversing them would delete clinical data (results, documents, payments for lab orders) or break the audit trail. Use these paths instead, in order of preference.

**A. Switch the module off without touching the schema** (minutes, no data loss)
- Deactivate the clinic’s lab tests in the catalog (admin → “Laboratoriya”): no new orders can be placed.
- Remove the lab role from staff.
- Set `releaseToPatient = false` to stop patient access, and `aiSummaries = false`.
- Unset `ENABLE_AI` if needed.
- Existing data stays readable to the people already authorized.

**B. Roll back the application only** (keep the migrated schema)
- Redeploy the previous app version (the Vercel or hosting rollback; § 4A of `docs/PRODUCTION_RELEASE_CHECKLIST.md`).
- Evidence that this is safe: `main`'s full test suite passes on the migrated schema (709/709).
- Two effects to expect:
  - **Pending lab notification jobs:** the old worker does not know lab job types, which have no appointment, so it will not deliver them.
  - **The lab screens disappear.** Lab data is kept, untouched, for when the new version returns.

**C. Restore the database** (last resort; loses everything written since the backup)
- Restore the pre-migration backup or PITR point (§ 4B of the release checklist). Then redeploy the matching app version.
- Use it only if the migrations themselves damaged data. The dry-run found no such case.

**D. Schema changes to existing objects, if a targeted manual reversal is ever needed** (reviewed by an engineer, on staging first):

| Migration | Change to pre-existing objects | Reversal note |
|---|---|---|
| `000001` | `patients`: date of birth, sex, document number, PINFL (nullable) and their checks | Columns may hold patient data entered since. Drop only after export, and never if lab rows depend on ranges by sex or age |
| `000005` | enum value `staff_role.lab` | PostgreSQL cannot drop an enum value. Remove the role assignments instead |
| `000008` | `payments.appointment_id` nullable; `lab_order_id`; one-subject check | Cannot restore NOT NULL while lab payments exist |
| `000013`, `000018` | enum values on `notification_job_type` | Cannot be dropped; harmless if unused |
| `000014`, `000019` | `notification_jobs`: `lab_result_id`, `recipient_profile_id`, `lab_order_id`, `read_at`, checks; `claim_due_notification_jobs` replaced | The new claim function still serves appointment jobs (tested by `main`'s suite) |
| `000016` | `patients.merged_into_patient_id` and `merged_at`; `doctor_patient_access()` now covers merge groups; triggers refusing new work on a merged record | Unmerge first (`unmerge_patients`), then the columns are inert |
| `000021` | revokes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from `anon` / `authenticated` on all public tables; `payments` column-level SELECT | Security hardening. Do not reverse |
| others | new lab tables, functions, policies, the private bucket | Self-contained. Unused if the module is switched off (A) |

## 5. What was run for this review

| Gate | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` | pass |
| `npm test` (clean local stack) | **1056 / 1056** (1050 from Phase 20 + R1 + R2 + B1 ×4) |
| `npm run build` | pass |
| `npm run test:e2e` (Chromium, against the production build) | **all 18 scripts pass** (referral 84/84 … HTTP red team 55/55; lab patient results 10/10, lab external 13/13 with R1 and R2 in place; lab collection 15/15 with B1) |
| Migration dry-run on populated pre-lab data | 21/21 applied; data unchanged; schema identical; transactional; partial failure rolled back |
| `main`'s tests on the migrated schema | 709/709 |
| Phase 20 CI (head `002062e`) | green |

**Not verified** (carried over from `QA_REPORT.md`, unchanged unless noted)
1. Real Telegram delivery and the Mini App inside Telegram on a phone.
2. A real AI provider.
3. A real external laboratory.
4. Online payments.
5. Hosted Postgres version, staging, production data and backups (now partly addressed: the dry-run used populated data, but locally).
6. Production configuration and cron.
7. Load at clinic scale.
8. Browsers other than Chromium, and accessibility.
9. Clinical and wording review.
10. Other time zones.
11. Retention and legal requirements.
