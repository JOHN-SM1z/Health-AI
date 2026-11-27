# Health AI live database audit — November 1, 2026

Read-only audit of the active Health AI Supabase project `cpoiachyfozjnlguaykz`, compared with the current checkout. No production rows, configuration, migrations, or external deliveries were changed. Queries returned schema definitions and aggregate counts, not patient records. Existing workspace changes were preserved.

## Findings requiring repair

### 1. P1 — This checkout's clinical-notes API does not match production

`src/app/api/doctor/clinical-notes/route.ts:81` and `:204` query `public.clinical_notes`, including its doctor foreign-key relationship. Production has no such table: `to_regclass('public.clinical_notes')` is NULL. It instead has `clinical_records`, with a different contract (`author_doctor_id`, `summary`, `details`, `record_type`, and append-only correction references). Authorized requests reaching these queries will fail against this production schema. This is a confirmed checkout/production incompatibility, not proof that the currently deployed application uses this checkout.

Repair: recover the source revision matching production and align the endpoint and generated types to the intended clinical-record contract. Do not create a parallel clinical table or rename existing records just to satisfy stale queries. Verify both authorized access and unauthorized denial through the real API.

### 2. P1 — Live walk-in consultation start depends on future appointment availability

Live `start_visit_consultation` calls `start_walk_in_consultation` with `date_trunc('minute', now()) + interval '1 minute'`. That function calls `book_appointment`, which rejects time blocks, slots outside working hours, and overlapping appointments, and reserves the service duration. A patient already registered in the live queue can therefore be prevented from starting care by future-slot rules. This is confirmed from live function definitions; no patient consultation was started to reproduce it.

Repair: model the actual encounter independently from optional scheduled reservations, preserving the booking engine and overlap protection for scheduled bookings. Define and test queue behavior at closing time, during blocks, and when a scheduled reservation overlaps.

### 3. P1 — Webhook recovery has no claim ownership token

Live `claim_webhook_update(source, external_id)` reclaims a processing row after five minutes. `release_webhook_update` deletes any processing row with that key, and `finish_webhook_update` marks the key processed without identifying the worker that owns its current claim. If worker A runs past five minutes and B reclaims, A can delete or finish B's claim. A third worker can then claim again while B is still performing side effects. Atomic initial claiming alone does not prevent this stale-worker race.

Repair: return a unique claim token/generation; require it for completion/release and renew leases where necessary. Keep downstream effects independently idempotent. Verify concurrent expired-lease scenarios in an isolated database. No live duplicate delivery was observed or attempted.

### 4. P2 — Notification claims have no database recovery for a crashed worker

Live `claim_due_notification_jobs(integer, uuid[] DEFAULT NULL)` claims only `pending` Telegram jobs, setting them to `in_progress`. It contains no timeout quarantine/recovery. No public database function with notification/stale-recovery logic was found. The checkout's `20261006000005_notification_stale_claims.sql` has a quarantine step that is absent from the live definition. A process terminated after claiming cannot execute the application catch block and can leave jobs stuck indefinitely.

There were **zero currently stuck jobs**: the aggregate notification inventory contained 9 skipped, 4 sent, and 4 cancelled jobs. A separate deployed application recovery process was not inspected, so the finding specifically establishes the database recovery gap.

Repair: quarantine ambiguous expired claims for human review, with claim ownership; do not automatically resend a potentially delivered message.

### 5. P2 — NULL notification limit bypasses the batch bound

The live guard is `if p_limit < 1 or p_limit > 200 then ...`. For NULL, this predicate is unknown and the exception is skipped. PostgreSQL `LIMIT NULL` is unbounded, so a server call with NULL can claim every matching due job. A read-only expression check confirmed the guard does not reject NULL; the claiming RPC was not invoked. Execution is restricted to the server role, so this is not anonymous access.

Repair: explicitly reject NULL before side effects. The existing uncommitted RPC-hardening migration already contains such validation; review it against the actual production signature before deployment.

### 6. P1 — Repository migrations cannot be treated as the production schema

Production has 69 public tables and 63 recorded migrations, with latest history `20261013170947 / 20261013000001_rls_auth_uid_initplan`. This checkout has 53 migration files, ending in uncommitted October 8 audit fixes. Production contains later visits, online payment, identity, SaaS and clinical-record functionality absent from this migration chain. The missing clinical-notes table is one concrete consequence. Migration counts alone do not establish which migrations are missing because hosted timestamps/names can differ.

Repair: reconcile migration contents and the deployed source revision in a separate reviewable change before applying this checkout's migrations. Rehearse clean and upgrade paths against a disposable database. Never replay the old setup script into production.

## Security and performance advisories

- Leaked-password protection is disabled. Enable it subject to the available Auth plan, and verify password-policy behavior. [Supabase guidance](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- 146 foreign-key index advisories. Examples include appointment `(doctor_id, clinic_id)` and `(patient_id, clinic_id)` relationships and clinical-record patient/consultation relationships. These are candidates for measured optimization, not 146 proven slow queries. Prioritize frequently joined tables and parent modification paths. [Index advisory](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys).
- 18 multiple-permissive-policy advisories. Review execution plans before consolidating policies. [Policy advisory](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies).
- `btree_gist` is installed in public. Moving it needs dependency review because appointment overlap protection depends on GiST support. [Extension advisory](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public).
- 64 unused-index advisories are **not** a recommendation to drop indexes; observation windows and integrity constraints matter.
- 35 tables have RLS with no policies. This denies ordinary-role access and can be intentional for server-only tables. Six authenticated-callable security-definer helpers are authorization predicates and are not automatically vulnerabilities; the reviewed doctor helpers resolve the current user and active doctor membership.

## Checks that passed

- RLS enabled on all 69 public tables.
- No unvalidated public constraints and no invalid public indexes.
- No anonymous-executable public security-definer functions.
- No public table granted TRUNCATE to anon or authenticated.
- Existing appointment exclusion constraint protects overlapping active reservations.
- Aggregate checks returned zero active appointment overlap pairs, appointment patient/doctor/service tenant mismatches, payment/appointment patient or tenant mismatches, and visit/patient/doctor tenant mismatches.
- Zero invalid charge arithmetic/quantities and zero paid payments missing `paid_at`.
- Zero processing webhooks older than 15 minutes at audit time.
- Voice-object SELECT policy is limited to owner/admin/manager/receptionist roles; the old audit's broad-doctor storage policy is not the current definition.
- Last-24-hour log query for ERROR/FATAL/PANIC returned no matching rows. This is not proof that every request succeeded or every log source was complete.

## Coverage and limits

Inspected live public table/RLS inventory, policies, function signatures and grants, selected booking/clinical/queue/payment/webhook implementations, constraint/index validity, migration history, storage policies, cron inventory, security/performance advisors, logs, and aggregate integrity checks. The staging project is inactive and was not resumed.

This is a broad database audit, not exhaustive proof of correctness of every function, every foreign-key relationship, or every application path. No production write probes, destructive tests, payment execution, clinical actions, notification sends, or patient-record exports were performed. Concurrency findings are implementation-confirmed scenarios, not live reproductions. App release gates were not run because this task changed only this report and did not prepare a release. The Supabase changelog fetch was attempted but the web reader rejected its content type.
