# Health AI live database audit — November 14, 2026

Read-only audit of the production Supabase project `cpoiachyfozjnlguaykz` (Postgres 17), compared against the current checkout (`codex/clinic-operations-pilot`). Nothing was written to the database: no migrations, no row changes, no RPC side effects. Queries returned schema definitions and aggregate counts only, never patient rows. Follows up on `docs/DATABASE_AUDIT_2026-11-01.md`.

Inventory: 69 public tables, 63 recorded migrations (latest `20261013000001_rls_auth_uid_initplan`), 3 clinics, 14 patients, 13 appointments, 13 payments, 0 visits, 146 processed webhooks.

## Findings

### P1-1. This checkout cannot run against the production schema (wider than reported on Nov 1)

The deployed app is **not** this checkout. Live cron traffic calls `claim_due_sms_jobs`, which nothing in this checkout calls. The checkout's code calls database objects that do not exist in production, or calls them with the wrong signature:

| Code | Calls | Production |
|---|---|---|
| `src/app/api/operations/visits/route.ts:39` | `rpc register_walk_in` | missing |
| `src/app/api/operations/visits/route.ts:52` | `rpc transition_visit` without `p_reason` | exists, but `p_reason` has no default, so PostgREST finds no matching function |
| `src/app/api/operations/visits/route.ts:23` | `visits.service_id` | column missing |
| `src/app/api/admin/staff/route.ts:61,75,85` | `rpc manage_clinic_staff` | missing |
| `src/app/api/operations/payments/route.ts:24` | `rpc set_manual_visit_payment` | missing |
| `src/app/api/operations/summary/route.ts:5` | `rpc operations_summary` | missing |
| `src/app/api/doctor/laboratory/route.ts:12` | `rpc lab_workbench` | missing |
| `src/lib/referrals/access.ts:156` | `rpc doctor_patient_access(p_clinic, p_patient, p_actor)` | signature is `(p_doctor_id, p_patient_id)` |
| `src/app/api/doctor/clinical-notes/route.ts:81,204`, `src/app/api/doctor/referrals/[id]/notes/route.ts:78` | table `clinical_notes` | missing (production has `clinical_records`) |

If this branch were deployed, the following would break: walk-in registration, queue transitions, staff management, visit payments, the operations summary, the lab workbench and clinical notes. The `doctor_patient_access` mismatch fails closed: the error is swallowed as "no access", so doctors would silently lose patient history.

The repository's migrations (53 files) and production's migration history (63 entries) are separate lineages. Production has lab, visits, online payments, SMS, OneID and SaaS migrations that this checkout lacks. This checkout has walk-in, staff-management and lab-workbench migrations that production lacks.

**Repair:** Recover the source revision that matches production, decide which lineage is canonical, and reconcile schema and code in one reviewable change. Rehearse it on a disposable or staging database. Do not apply this checkout's migrations to production. Do not create parallel objects (for example `clinical_notes` next to `clinical_records`) just to make the stale code run.

### P1-2. Starting a walk-in consultation still depends on future-slot availability (unchanged)

Live `start_visit_consultation` calls `start_walk_in_consultation(..., date_trunc('minute', now()) + 1 minute, ...)`, which goes through the booking engine. A patient already in the live queue can be blocked from starting care by working hours, time blocks or an overlapping booking. This conflicts with the rule that walk-in tickets are not future appointments. The function also deletes the generated `unpaid` payment row (`delete from public.payments ...`).

**Repair:** Model the encounter independently of optional scheduled reservations, keeping overlap protection for real bookings.

### P1-3. Webhook claims have no ownership token (unchanged)

`claim_webhook_update` re-claims a `processing` row after 5 minutes. `release_webhook_update` and `finish_webhook_update` act on the key alone. A slow worker A can delete or finish worker B's newer claim, which allows a third claim while B is still producing side effects. The uncommitted `20261008114633_db_audit_rpc_hardening.sql` targets this, but it was written against the checkout's lineage. Re-base it on the production definitions before use.

### P2-1. Notification claims: NULL limit bypass now affects both channels, and there is no crash recovery

- `claim_due_notification_jobs` **and** `claim_due_sms_jobs` (SMS is new since Nov 1) guard with `if p_limit < 1 or p_limit > 200`. A NULL limit skips that guard, and `LIMIT NULL` is unbounded. Execution is server-role only.
- Neither function recovers jobs left in `in_progress` by a crashed worker. Today there are 0 stuck jobs (4 sent, 9 skipped, 4 cancelled).

**Repair:** Reject NULL explicitly. Add claim ownership and quarantine for expired claims so a human reviews them. Do not resend automatically.

### P2-2. Stale appointments and unpaid payment rows

- 9 appointments are still `pending` although their end time passed 24–86 days ago. Each has an `unpaid` manual payment.
- `unpaid` payment rows are also attached to 2 `cancelled`, 1 `no_show` and 1 `completed` appointment.
- No database job resolves past `pending` appointments.

This inflates outstanding balances and pending-appointment counts in reports. Clinic policy decides the resolution (no-show, cancel, or waive). The database should not invent one.

### P2-3. Orphan tenant and an orphan doctor role

- Clinic `health-ai-clinic` is `is_active = true` but has **no staff and no owner** (created 2026-08-19, 0 patients). It looks like a leftover seed tenant. While it stays active, any public surface that lists active clinics can expose it. Confirm, then deactivate it.
- In clinic `my-clinic`, a staff member has the `doctor` role but no `doctors` row. `current_doctor_id()` returns NULL for them, so every doctor screen denies access. Either link a doctor record (server-side) or remove the role.

### P2-4. Non-application tables in production `public`

`todos`, `todo_deps` and `inbox_entries` are not part of the app. No code references them, no migration in either lineage created them, and they are empty. `authenticated` has SELECT/INSERT/UPDATE/DELETE grants on all three. RLS is on with no policies, so they are not reachable today, but one added policy would expose them. Confirm their origin, then drop them, or at least revoke the grants.

### P3. Hygiene and advisories

- **Leaked-password protection is disabled** (Auth). [Docs](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
- **`btree_gist` is installed in `public`.** Moving it needs dependency review because the appointment exclusion constraint uses it. [Docs](https://supabase.com/docs/guides/database/database-linter?lint=0014_extension_in_public)
- **18 multiple-permissive-policy warnings.** Most come from `… write for management` policies declared `FOR ALL`, which also apply to SELECT and overlap the read policy. Splitting them into INSERT/UPDATE/DELETE fixes it. [Docs](https://supabase.com/docs/guides/database/database-linter?lint=0006_multiple_permissive_policies)
- `expire_due_referrals` pins `search_path = public` without `pg_temp`. It is SECURITY INVOKER and server-only, so the risk is low; align it with the other functions anyway.
- `payments` has no delete guard (unlike `visit_transactions` and `visit_charges`). Deletes are audited, and today only unpaid rows are deleted, by `start_visit_consultation`.
- The `messages` DELETE policy is dead because `authenticated` has no DELETE grant. It is harmless; remove it to avoid confusion.
- 146 unindexed-FK and 64 unused-index notices. With 13 appointments these are not urgent. Do not drop indexes based on "unused" counts.
- The 6 `authenticated`-executable SECURITY DEFINER helpers (`is_clinic_staff`, `current_doctor_id`, `is_linked_doctor`, `doctor_can_read_patient`, `doctor_can_read_appointment`, `is_platform_admin`) were reviewed. Each resolves `auth.uid()` internally and only answers questions about the caller. This is intended for RLS.

## Checks that passed

- RLS enabled on all 69 public tables.
- `anon` has no table privileges. Neither `anon` nor `authenticated` has TRUNCATE, TRIGGER, REFERENCES or MAINTAIN on any public table.
- No SECURITY DEFINER function is executable by `anon`. Every SECURITY DEFINER function pins `search_path = public, pg_temp`.
- Payments cannot be written from a browser session (`payments_block_direct_write`). Doctor-account linking is server-only (`doctors_account_link_server_only`). Patient Telegram identity is server-only.
- Zero tenant mismatches across appointments↔patients/doctors/services, payments↔appointments, visits↔patients/doctors/appointments, and charges/transactions↔visits.
- Zero overlapping active appointments; the exclusion constraint is present.
- No duplicate patient numbers, active Telegram identities, staff roles or queue numbers. No merge chains or cross-clinic merges.
- No paid payment missing `paid_at`. No consent without a timestamp.
- 0 webhooks stuck in `processing`. 0 overdue pending notifications.
- All 3 cron jobs succeeded on every run in the last 2 days. The notification and referral jobs read their secret from Vault (no literal token in `cron.job`). All `pg_net` responses in the retention window were HTTP 200.
- No Postgres ERROR, FATAL or PANIC in the last 24 hours of logs.
- Storage: `voice-messages` reads are limited to owner/admin/manager/receptionist in the same clinic folder. `lab-documents` is service-role only.

## Changes since November 1

- Still open: walk-in consultation start, webhook ownership, notification recovery, NULL limit, migration drift, leaked-password protection.
- New: the NULL limit also affects `claim_due_sms_jobs`; code/schema drift now covers 7 RPCs plus a table and a column; stale appointments and payments; orphan clinic and doctor role; stray `todos`/`inbox_entries` tables.

## Limits

Read-only. No write probes, concurrency reproductions, payments, notifications or clinical actions were performed; concurrency findings come from the function definitions. The inactive staging project was not resumed. Not every function body was reviewed line by line; the review focused on authorization helpers, booking, queue, payment, webhook and notification paths. App release gates were not run, because only this report was added.
