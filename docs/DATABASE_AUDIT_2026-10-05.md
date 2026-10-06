# Database audit — 2026-10-05

> This is the pre-repair findings snapshot. See [the October 6 revision](OPERATIONS_REVISION_2026-10-06.md) for implemented corrections and remaining verification limits.

**Verdict: NOT READY for release from this checkout.** The repository contains reproducible migration blockers, exposed privileged functions, payment-integrity gaps, tenant-integrity gaps and referral authorization bypasses.

## Scope and evidence limits

Audited branch: `claude/health-ai-diagnostic-audit-3ebzmq`, HEAD `9b684d1`, including the working tree's pre-existing uncommitted migrations and source files. Reviewed all 36 migration files, the 31-migration setup snapshot, 24 declared public tables, RLS policies, foreign keys, triggers, function grants, storage policies, generated types, and the related booking/payment/referral/notification application paths. No laboratory tables exist in this migration set.

Docker/Supabase was not running. I created a disposable PostgreSQL 16.14 cluster with a Unix socket only, synthetic data and minimal Supabase `auth`/`storage` scaffolding. `auth.uid()` and `auth.role()` read test session claims; production credentials and patient data were not used. SQL tests exercised actual PostgreSQL RLS, constraints, grants and triggers. Storage policy tests demonstrate database permission behavior, not an end-to-end Storage HTTP download.

The normal migration replay passed 29 files, then stopped at finding DB-08. To inspect subsequent defects, only the temporary database used a reordered copy of that migration. The next failure was DB-09. To isolate DB-10, I omitted the missing-table statements in a temporary copy; it then failed on enum use. For later policy tests only, the enum addition was committed separately and the remaining referral policies/triggers loaded. **No `clinical_notes` table was invented. No repository migration was edited.** Findings involving later referral policies describe the intended combined schema after those blockers are addressed, not a successfully deployable current migration chain.

**Live production schema, applied-migration history, existing data corruption and hosted PostgREST/Storage configuration were not inspected.** These are repository and isolated-reproduction findings. No deployment, production migration, or external notification was performed.

Priority: P0 = immediate security release blocker; P1 = repair before release; P2 = correctness/maintainability repair. “Reproduced” means actual isolated SQL or a stated SQL-equivalent concurrency check; “source-confirmed” means reviewed code, without claiming an HTTP reproduction.

## Findings

### DB-01 — P0 — Privileged job/webhook RPCs remain executable by ordinary roles

**Reproduced, probes 01–03 and 31.** [supabase/migrations/20260813000014_release_blockers.sql:69](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000014_release_blockers.sql:69) grants `service_role` execution but never revokes the default `PUBLIC` execute privilege for `claim_due_notification_jobs`, `claim_webhook_update`, `finish_webhook_update` or `release_webhook_update`. All four are `SECURITY DEFINER` and do not authorize their caller. Later replacement of `claim_webhook_update` does not repair the grants.

An `anon` session claimed jobs from both synthetic clinics and received their rows; an authenticated receptionist from Clinic A claimed a Clinic B job. Anonymous webhook claim/finish also succeeded. Job rows contain recipient identifiers, and unauthorized claims can suppress delivery. Booking/rescheduling RPCs correctly reject ordinary roles, demonstrating that the missing revokes are specific to these functions.

**Repair:** revoke from PUBLIC/anon/authenticated, grant only the intended server role, add internal caller checks appropriate to the runtime, and regression-test both execute grants and cross-tenant behavior. Check actual hosted grants before assessing production exposure.

### DB-02 — P1 — Browser sessions can insert already-paid payments

**Reproduced, probe 04.** [supabase/migrations/20260822000001_payments_server_managed.sql:56](/Users/jahonshoh/Health-AI/supabase/migrations/20260822000001_payments_server_managed.sql:56) blocks only UPDATE. [supabase/migrations/20260818000024_role_based_rls.sql:248](/Users/jahonshoh/Health-AI/supabase/migrations/20260818000024_role_based_rls.sql:248) still allows authenticated management INSERT with no restriction on status, amount, provider or payment attribution.

A manager inserted a payment for an existing unpaid appointment with `status='paid'`, amount `1.00`, and no `paid_at`. Direct authenticated appointment INSERT also remains available, so the usual booking engine's automatic payment row does not close this path. Ordinary same-clinic payment UPDATE was correctly denied in control probe 25.

**Repair:** make payment creation server-only as well as updates; derive amount and state inside the authoritative transaction. Test INSERT, UPDATE and upsert paths.

### DB-03 — P1 — Tenant-owned foreign keys do not generally enforce same-clinic relationships

**Reproduced, probes 05–08, 19, 27 and 30.** Relevant definitions include [supabase/migrations/20260813000004_schedules.sql:20](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000004_schedules.sql:20), [supabase/migrations/20260813000005_appointments_payments.sql:33](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000005_appointments_payments.sql:33) and [supabase/migrations/20260813000006_conversations.sql:6](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000006_conversations.sql:6). There are no composite foreign keys in the audited public schema. Most ordinary foreign keys validate an ID's existence only.

An authenticated Clinic A manager successfully created:
- An A conversation referencing a B patient.
- An A time block referencing a B doctor; booking availability checks time blocks by doctor ID, so this can affect B's availability.
- An A cancelled appointment referencing B's doctor, patient and service.
- An A payment referencing B's patient while attached to A's appointment.
- An A service referencing B's specialty.

The `doctor_services` insert trigger correctly rejects a cross-clinic pair, but moving a linked service to another clinic later invalidates the existing pair without firing that trigger. Referral child-write checks have the same general parent-change limitation.

**Repair:** add composite tenant keys/FKs and matching patient/appointment relationships where required; constrain tenant reassignment. Check existing data before validation. Slot validation must not be the sole tenant-integrity barrier.

### DB-04 — P1 — Management can redirect notifications to arbitrary recipients and foreign appointments

**Reproduced database mutation, probe 09; source-confirmed downstream path.** [supabase/migrations/20260818000024_role_based_rls.sql:279](/Users/jahonshoh/Health-AI/supabase/migrations/20260818000024_role_based_rls.sql:279) permits full-row job UPDATE. An A manager changed an A job to reference a B appointment and a different Telegram recipient. [src/lib/notifications/processor.ts:56](/Users/jahonshoh/Health-AI/src/lib/notifications/processor.ts:56) loads the referenced appointment using only its ID and sends to the job's stored recipient.

This combination can redirect another clinic's appointment details when the worker processes the job. No external send was attempted during the audit.

**Repair:** make job payload/recipient/tenant fields server-managed, constrain references, and re-authorize recipient ownership and clinic at send time. Expose narrowly authorized retry/cancel operations rather than unrestricted row updates.

### DB-05 — P1 — A doctor can forge a referral and grant themselves patient access

**Reproduced, probe 10.** [supabase/migrations/20260920000001_referrals.sql:315](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000001_referrals.sql:315) checks clinic membership but does not bind `referring_doctor_id` to the caller or require an existing patient relationship. [supabase/migrations/20260920000002_referral_handoff_workflow.sql:182](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000002_referral_handoff_workflow.sql:182) trusts the resulting referral to grant patient access.

A doctor initially saw zero rows for an unrelated same-clinic patient, inserted a referral naming another doctor as sender and themselves as receiver, and then saw that patient. The source-level clinical-access helper also trusts active referrals, extending the impact if clinical-note storage exists in another deployed schema.

**Repair:** enforce sender identity and patient authorization atomically in the database/server entry point; remove broad direct inserts. Receptionist permissions must not permit clinical authorship forgery.

### DB-06 — P1 — Final referrals can be rewritten; actors can bypass action-specific permissions

**Reproduced, probe 11.** [supabase/migrations/20260920000001_referrals.sql:329](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000001_referrals.sql:329) authorizes full-row UPDATE for either involved doctor. [supabase/migrations/20260920000003_referral_lifecycle_hardening.sql:74](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000003_referral_lifecycle_hardening.sql:74) returns immediately whenever status is unchanged.

A receiving doctor rewrote the originating clinical handoff on a completed referral and set its expiration to NULL. The “terminal states are immutable” comment is therefore false. Action-specific sender/receiver checks in routes do not protect direct database writes. Expiration is defaulted only on INSERT, while the CHECK permits NULL on UPDATE.

**Repair:** use explicit transition operations and immutable authorship/content fields, define corrections, and enforce terminal-state and expiration invariants on every mutation.

### DB-07 — P1 — Reception can read clinical handoff text despite the application restriction

**Reproduced, probes 12 and 18.** [supabase/migrations/20260920000001_referrals.sql:292](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000001_referrals.sql:292) exposes whole referral rows to reception, including `clinical_handoff_note`; [src/lib/referrals/access.ts:37](/Users/jahonshoh/Health-AI/src/lib/referrals/access.ts:37) documents rejection of receptionists. RLS is row filtering, so hiding a field in the UI does not protect it.

The audit trigger also copies complete old/new referral rows, including the clinical handoff, into management-readable audit JSON ([supabase/migrations/20260822130000_fix_audit_and_multiclinic_rls.sql:33](/Users/jahonshoh/Health-AI/supabase/migrations/20260822130000_fix_audit_and_multiclinic_rls.sql:33)). This creates a second clinical-data access path that must be included in the permission model.

**Repair:** separate operational referral metadata from protected clinical text, enforce field-level access through safe views/routes or table separation, and minimize audit content under the approved policy.

### DB-08 — P1 — Fresh migration replay stops when an audit function is dropped too early

**Reproduced on unmodified migration replay.** [supabase/migrations/20260822130000_fix_audit_and_multiclinic_rls.sql:46](/Users/jahonshoh/Health-AI/supabase/migrations/20260822130000_fix_audit_and_multiclinic_rls.sql:46) drops `handle_audit_log()` before dropping its five dependent triggers. The preceding migration created those dependencies.

PostgreSQL: `cannot drop function handle_audit_log() because other objects depend on it`.

**Repair:** detach/rebind all dependent triggers before dropping the function. Determine whether this uncommitted migration has ever been applied elsewhere before choosing a migration-history repair; do not blindly rewrite applied production history.

### DB-09 — P1 — `clinical_notes` exists in types/routes but has no creating migration

**Reproduced after isolating DB-08.** [supabase/migrations/20260920000002_referral_handoff_workflow.sql:34](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000002_referral_handoff_workflow.sql:34) alters a table absent from all earlier migrations: `relation "public.clinical_notes" does not exist`.

[src/lib/supabase/database.types.ts:330](/Users/jahonshoh/Health-AI/src/lib/supabase/database.types.ts:330) declares the table and [src/app/api/doctor/clinical-notes/route.ts:81](/Users/jahonshoh/Health-AI/src/app/api/doctor/clinical-notes/route.ts:81) queries it. Comparing all existing public table Row fields with the diagnostic database found this missing table as the schema/type discrepancy; the other 24 table column-name sets matched.

**Repair:** reconcile the intended target branch/schema and missing migration. The current AGENTS.md prohibits clinical records, so do not fabricate a table without resolving that scope conflict and its authorization model.

### DB-10 — P1 — Referral enum value is added and consumed before transaction commit

**Reproduced after omitting only the missing-table statements.** [supabase/migrations/20260920000002_referral_handoff_workflow.sql:28](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000002_referral_handoff_workflow.sql:28) adds `in_progress`, and the same migration uses it in a policy at [supabase/migrations/20260920000002_referral_handoff_workflow.sql:192](/Users/jahonshoh/Health-AI/supabase/migrations/20260920000002_referral_handoff_workflow.sql:192).

PostgreSQL: `unsafe use of new value "in_progress" of enum type referral_status`. A DO block does not establish a commit boundary.

**Repair:** split enum addition and dependent policy creation into separately committed migrations, matching the existing manager/receptionist migration pattern.

### DB-11 — P1 — The production setup script is stale and fails as one transaction

**Reproduced transaction failure, probe 33; source-confirmed drift.** [supabase/full-db-setup.sql:1](/Users/jahonshoh/Health-AI/supabase/full-db-setup.sql:1) advertises running the entire file once in the SQL editor. As one transaction it fails at line 2064: `unsafe use of new value "manager" of enum type staff_role`.

The snapshot includes 31 migration files while the current working tree contains 36. All included migration bodies match their current source; the drift is the five omitted files. It omits both audit/multi-clinic migrations and all three referral migrations. [docs/E2E_TEST_MATRIX.md:147](/Users/jahonshoh/Health-AI/docs/E2E_TEST_MATRIX.md:147) claims an older all-31 single-script PASS; that claim does not validate this checkout or the tested transaction mode.

**Repair:** establish one authoritative migration path that preserves commit boundaries; regenerate or retire the snapshot and refresh release evidence against the exact source revision.

### DB-12 — P1 — Payment transitions are vulnerable to lost updates

**Source-confirmed; reproduced with equivalent concurrent SQL, probe 32.** [src/lib/payments/status.ts:60](/Users/jahonshoh/Health-AI/src/lib/payments/status.ts:60) validates a previously read status, then [src/lib/payments/status.ts:72](/Users/jahonshoh/Health-AI/src/lib/payments/status.ts:72) updates by ID without matching the expected old status or clinic.

Two transactions both read `pending`; one writes `paid`, then the other writes `failed`. Both succeed and the final state is `failed`, even though `paid → failed` is forbidden by the application transition map. The SQL reproduction tests this read/check/write pattern, not an HTTP payment-provider callback.

**Repair:** execute state validation, mutation and audit atomically with row locking or a compare-and-set update; require exactly one affected row and tenant scoping.

### DB-13 — P1 — Appointment validation can be bypassed on reactivation and multi-day intervals

**Reproduced, probes 16–17.** [supabase/migrations/20260813000020_appointments_slot_validation.sql:36](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000020_appointments_slot_validation.sql:36) skips checks when start/end/doctor are unchanged, including `cancelled → confirmed`. A cancelled 23:00 appointment became confirmed despite working hours ending at 17:00. The same shortcut ignores changes to patient, service and clinic.

At [supabase/migrations/20260813000020_appointments_slot_validation.sql:81](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000020_appointments_slot_validation.sql:81), time-of-day comparisons do not require start and end to fall on the same local date. A 24.5-hour appointment was accepted. Direct operational table INSERT/UPDATE policies also remain available despite the project rule requiring booking-engine entry points.

**Repair:** route booking/rescheduling through the authoritative transactional engine; independently enforce tenant integrity, active-state revalidation, same-day/working-hours rules and valid duration in the database.

### DB-14 — P1 — Private voice storage permits broader access than voice-message metadata

**Reproduced at storage-policy level, probe 13.** [supabase/migrations/20260813000011_storage.sql:19](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000011_storage.sql:19) lets any same-clinic staff role read any object under the clinic folder. A doctor with no conversation permission selected a voice object. Voice-message metadata is restricted to operational roles by the later RLS migration; the storage read policy was not narrowed with it.

**Repair:** align storage reads with the approved role/conversation/consent/retention access decision, preferably through a re-authorizing download path. A private bucket does not by itself enforce patient-level access.

### DB-15 — P1 — Inactive doctors retain direct database access

**Reproduced, probe 14.** [supabase/migrations/20260818000024_role_based_rls.sql:104](/Users/jahonshoh/Health-AI/supabase/migrations/20260818000024_role_based_rls.sql:104) and the referral policies check profile relationships without consistently requiring `doctors.active`. Disabling a doctor's row left their appointment and patient reads available, while [src/lib/referrals/access.ts:147](/Users/jahonshoh/Health-AI/src/lib/referrals/access.ts:147) requires an active doctor on the server path.

**Repair:** define how deactivation revokes authorization and apply that rule consistently in RLS and server checks. Deactivation must not rely on UI routing alone.

### DB-16 — P1 — Notification claims can remain stuck; resolved database errors are ignored

**Reproduced orphan behavior, probe 34; source-confirmed write-error handling.** [supabase/migrations/20260813000014_release_blockers.sql:59](/Users/jahonshoh/Health-AI/supabase/migrations/20260813000014_release_blockers.sql:59) claims only pending jobs. A job inserted as `in_progress` with an update timestamp more than a day old was never reclaimed. A killed process cannot run the processor's catch block.

[src/lib/notifications/processor.ts:183](/Users/jahonshoh/Health-AI/src/lib/notifications/processor.ts:183) and its `markJob` helper await Supabase updates without inspecting returned `{ error }`. The catch blocks only cover thrown failures, so ordinary PostgREST write errors can leave the database state unchanged without the intended handling. Cancellation/retry updates also lack a claim-owner token.

**Repair:** design leases/claim ownership and explicit uncertain-delivery handling; inspect every write result. Do not blindly resend after an ambiguous successful external send. Test both thrown failures and resolved error objects.

### DB-17 — P1 — Clinical-note creation does not enforce the patient-access decision

**Source-confirmed; runtime route not exercised because the table is missing.** [src/app/api/doctor/clinical-notes/route.ts:126](/Users/jahonshoh/Health-AI/src/app/api/doctor/clinical-notes/route.ts:126) resolves an active doctor and checks only that the patient belongs to the clinic. POST never calls `requirePatientClinicalAccess`, although GET does. The optional appointment check verifies clinic but not matching patient or doctor. Optional referral checks do not establish that the caller is an involved doctor.

**Repair:** after resolving the clinical scope/table conflict, authorize the doctor's patient relationship and validate all appointment/referral/patient/actor links in the authoritative write transaction. Add database-backed unauthorized-write tests.

### DB-18 — P1 — Referral idempotency replay can disclose another doctor's referral

**Source-confirmed.** [src/app/api/doctor/referrals/route.ts:108](/Users/jahonshoh/Health-AI/src/app/api/doctor/referrals/route.ts:108) queries by clinic plus client-supplied idempotency key with the service-role client, then returns the complete existing referral before checking patient access. The unique-conflict fallback at line 248 repeats this behavior.

A same-clinic doctor who knows or collides with another doctor's key can receive their referral details. The key is caller-chosen text, not an authorization credential.

**Repair:** scope idempotency to actor/operation, bind the request fingerprint, and enforce normal read authorization before returning a stored result.

### DB-19 — P2 — The doctor-only appointment trigger also blocks managers and receptionists

**Reproduced, probe 15.** [supabase/migrations/20260818000025_no_show_reasons_and_read_tracking.sql:33](/Users/jahonshoh/Health-AI/supabase/migrations/20260818000025_no_show_reasons_and_read_tracking.sql:33) exempts only owner/admin, whereas the later role model grants manager/receptionist operational UPDATE rights. A manager's legitimate note update was rejected as “Doctors may only update the status of their own appointments.”

**Repair:** align trigger logic with the actual role matrix or remove direct staff writes in favor of narrow server operations; test each supported role.

### DB-20 — P2 — “Status-only” appointment writes still permit created-at changes

**Reproduced, probe 29.** The blacklist at [supabase/migrations/20260818000025_no_show_reasons_and_read_tracking.sql:41](/Users/jahonshoh/Health-AI/supabase/migrations/20260818000025_no_show_reasons_and_read_tracking.sql:41) omits `created_at` and `id`. An authenticated doctor changed their own appointment creation date to 2020. The primary-key omission is visible in source; an owned-primary-key mutation was not claimed as reproduced.

**Repair:** protect all immutable columns and constrain the operation to an explicit allowed change set, so new columns do not silently become writable.

### DB-21 — P1 — The “local database” test guard does not enforce a local target

**Source-confirmed; no remote test run performed.** [src/test/global-setup.ts:18](/Users/jahonshoh/Health-AI/src/test/global-setup.ts:18) loads `.env.local` and overwrites environment values, then checks only whether a known seed-clinic row exists. It does not allowlist a loopback host, verify migration completeness, or require an explicit disposable-database marker. [src/lib/supabase/integration.test.ts:84](/Users/jahonshoh/Health-AI/src/lib/supabase/integration.test.ts:84) deletes appointments for the fixture doctor when enabled.

A configured remote database with the seed clinic could therefore be treated as disposable. A partial local database can also be labelled ready. The shared temp marker is not scoped to a workspace/run.

**Repair:** fail closed on nonlocal/non-disposable targets, preserve intended environment precedence, verify migration state, isolate fixtures and marker files, and make required DB suites fail rather than quietly skip in release CI.

### DB-22 — P2 — The newest expired referral can hide another valid referral

**Source-confirmed.** [src/lib/referrals/access.ts:264](/Users/jahonshoh/Health-AI/src/lib/referrals/access.ts:264) filters by status/revocation, orders newest-first and limits to one before checking expiration in JavaScript. If the newest still-pending referral is expired but an older qualifying referral remains valid, it denies access incorrectly. The database patient policy filters expiration before its existence check, creating a route/RLS disagreement.

**Repair:** include the expiration predicate in the query before ordering/limiting, and test multiple concurrent referrals with different expiration dates.

### DB-23 — P1 — Admin referral queries use columns and a relationship absent from the schema

**Source-confirmed against the migration and generated types.** [src/app/api/admin/referrals/route.ts:32](/Users/jahonshoh/Health-AI/src/app/api/admin/referrals/route.ts:32) selects `urgency`, `reason`, `notes`, `referred_at`, `responded_at`, and embeds `receiving_doctor_id`. The database defines `priority`, `referral_reason`, `clinical_handoff_note`, `created_at`, `accepted_at`, and `referred_to_doctor_id`. The query also orders/filters using the nonexistent names, so the admin referral endpoint cannot load from this schema.

The doctor referral GET returns database names while [src/app/doctor/referrals/page.tsx:20](/Users/jahonshoh/Health-AI/src/app/doctor/referrals/page.tsx:20) expects the alternate field names, producing an additional response/UI contract mismatch.

**Repair:** choose one explicit response contract, map/alias real columns and relationships consistently, and add actual schema-backed route tests. Do not rename clinical data columns ad hoc to make one stale client pass.

## Additional scope and validation observations

- Current AGENTS.md prohibits clinical records, diagnosis and prescriptions, while the uncommitted referral/clinical-note changes explicitly introduce clinical handoff text and diagnosis/prescription note types. This policy conflict remains unresolved; the database audit does not authorize a clinical expansion.
- Reception's payment SELECT policy returns full payment rows, not only the status promised in its comment. Probe 26 read the amount. Decide the intended field-level financial permission explicitly; route-level analytics restrictions alone cannot prevent aggregation of readable rows.
- No public table declared by these migrations lacked enabled RLS in the diagnostic schema. This is a positive structural check, not proof of correct policies.
- Existing booking/rescheduling RPC grants correctly deny ordinary roles; same-clinic payment UPDATE protection and cross-clinic doctor-service INSERT protection also worked. The report distinguishes those protections from the gaps around them.
- `npm run typecheck` failed with eight diagnostics: missing `getAdminClientForActor` export, missing staff-route POST/PATCH/DELETE exports, and four unsupported `id` props in the staff manager UI. These pre-existing working-tree issues also block release, although most are outside the database.
- Targeted existing unit tests used a temporary config, placeholder environment, disabled real fetch and no normal global database setup: **48 passed, 5 skipped across 7 selected files**. They do not validate migration replay or close the SQL findings. Full `npm test`, build and release gates were not claimed to pass.
- 34 numbered diagnostic probes were recorded. Probes 22 and 28 affected no rows and are not used as evidence of enforcement. Probe 34 supersedes probe 20's stale-timestamp setup. The payment race is explicitly SQL-equivalent to the application pattern, not a full HTTP integration test.

## Recommended repair order

1. Close public execution of privileged RPCs, authenticated paid INSERT, notification redirection and referral self-authorization.
2. Repair migration ordering and reconcile the missing clinical table/scope, then establish clean and upgrade-path replay tests. Fix/retire the single-script snapshot.
3. Enforce tenant and patient relationship invariants, including parent changes, with validated constraints and narrowly authorized mutation entry points.
4. Make payment transitions atomic; repair booking reactivation/duration checks and referral immutability/action rules.
5. Align clinical, storage, audit, deactivation and field-level access policies with server authorization.
6. Repair job leases/error handling and the test database safety guard; add targeted regression tests for every reproduced defect.
7. Run actual local Supabase/PostgREST/Storage integration tests and all required release commands against the exact repaired commit. Inspect live schema drift separately through an authorized read-only audit before planning production changes.

## Evidence files

The accompanying evidence bundle contains migration errors, synthetic probe results, schema/type drift, unit-test output, and rollback-wrapped SQL reproductions. SQL files require the isolated synthetic fixture schema; they are **not production repair scripts**. No production credentials or patient records are included.
