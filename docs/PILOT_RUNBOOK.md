# Outpatient pilot — release runbook (Phase 4)

This runbook is preparation only. **No production migration, deployment or patient-facing activation is
authorized by this document.** Each of those needs the owner's explicit go-ahead at the time.

## 1. What production has today (read-only check, 2026-10-07)

- **Supabase project `cpoiachyfozjnlguaykz`.** It has 24 migrations, ending with `20260930000005_unified_booking_engine`.
  - The migration history was applied **by name, with different version stamps** than the files.
  - **Never run `supabase db push` against it.** Apply the missing files by name, one transaction per file, in
    order.
- **Missing in production:**
  - `20260930000006_tenant_integrity_hardening` (check whether it is present by name first);
  - the 21 laboratory migrations `20261005000001`–`021`;
  - the outpatient migrations `20261007000001`–`003`.
- **The live app is `health-ai-w1vc.vercel.app`, which runs `main`.** This branch (PR #14) is not deployed.
- **The scheduler secret is not aligned.** The Vault `health_ai_cron_secret` must equal `CRON_SECRET` on
  health-ai-w1vc. Reminders fail with 401 until it does.

## 2. Before the pilot — clinic inputs (owner / acceptance contact)

| Input | Needed for |
|---|---|
| Pilot doctors, their hours and their services; reception and cashier staff | accounts and roles (`/admin/staff`) |
| Service catalogue with current prices | `/admin/services` — the server prices every charge from here |
| Acceptance contact at the clinic | sign-off and daily reconciliation |
| Refund grants: which cashiers, granted by whom | `/kassa` → "Kassirlarga qaytarish ruxsati" |
| Discount, partial-payment and exception rules | **not built until decided** |
| Lab verifiers, report layout, label printer, critical-result procedure | Phase 3 laboratory release |
| SMS gateway, MyID/OneID, fiscal receipt provider contracts | blocked features |

## 3. Release steps (when authorized)

1. **Freeze and back up.**
   - Take a Supabase backup (dashboard → Database → Backups); free plan users should take a manual
     `pg_dump` first.
   - Write down the time and the backup id.
2. **Rehearse on staging first.**
   - Staging project `qoupbbsspzfyjqfzykuk` has the schema up to the lab module.
   - Apply `20261007000001`–`003` there by name, then run the acceptance checks in §5 against a staging
     deployment.
3. **Pre-flight on production (read-only):**
   - migration names present;
   - no rows that would violate the new constraints. The new tables are empty; `patients.patient_number` is
     backfilled by the migration in `created_at` order.
4. **Apply to production by name, one file per transaction:**
   - first, the lab files `20261005000001`–`021`, if the lab module is part of the release (decision needed);
   - then `20261007000001_operations_enums`, `20261007000002_outpatient_operations` and
     `20261007000003_visit_actual_end`.
   - Every existing clinic becomes `operating_mode = 'mixed'`, so bookings keep working.
5. **Deploy the app** by merging the release branch into `main`; Vercel builds `health-ai-w1vc`. Then check
   that `/api/health` and `/login` respond.
6. **Smoke test with a test patient,** then cancel and refund it:
   - registration → payment → queue number → doctor queue → complete;
   - the waiting-room screen `/queue/<clinic id>` shows the number;
   - the patient's Telegram receives the ticket, if linked.

## 4. Running the pilot

- **Small group:** one or two doctors, one receptionist, one cashier.
- **Authoritative record:** for the pilot's doctors, Health AI holds arrivals, queue and kassa money. The
  existing paper or MedPlus process continues in parallel for everything else.
  - For pilot visits, the kassa records money **only in Health AI**. The existing cash book is reconciled
    against the Health AI day totals, not entered twice.
- **Daily reconciliation** (kassa → "Bugun kassaga tushgan pul"):
  - cash net against the drawer count;
  - terminal net against the terminal's daily report;
  - record any difference and its explanation.
- **Downtime** (app or internet unavailable):
  1. Write arrivals on a numbered paper list.
  2. Take money as before and note the method.
  3. When the system is back, register each arrival and record each payment. The day totals must then match
     the paper list.
  4. Tell patients their number aloud.
  5. The waiting-room screen shows "Aloqa yo‘q" when it cannot refresh — don't rely on it during an outage.
- **Measurements:** start them with a measured baseline from the current process. No improvement is claimed in
  advance.
  - registration time (arrival → registered);
  - kassa wait (registered → queued);
  - doctor wait (queued → called);
  - duplicate-identity refusals;
  - voided charges (wrong service);
  - unmatched day totals;
  - failed or unsent Telegram tickets;
  - staff-reported blockers.

## 5. Acceptance checks (staging, then production smoke)

- [ ] Reception finds a returning patient by passport, JSHSHIR or patient number, and must confirm identity
      before selecting.
- [ ] A second card for the same passport or JSHSHIR is refused.
- [ ] Reception cannot take money; the cashier cannot register.
- [ ] Full payment split between cash and terminal issues the next queue number. An underpayment is refused.
- [ ] A cashier refund is refused without a grant and allowed with one. The ledger shows both people.
- [ ] Admin cannot refund.
- [ ] The doctor sees only their own queue. Start → workspace → notes → complete, and the next patient starts
      immediately.
- [ ] An unfinished visit from yesterday is still in today's queue.
- [ ] The waiting-room screen shows numbers only.
- [ ] Day totals by method match the test payments.

## 6. Monitoring (SQL, read-only; run daily during the pilot)

```sql
-- Visits waiting for payment for more than 2 hours
select count(*) from public.visits where status = 'awaiting_payment' and arrived_at < now() - interval '2 hours';
-- Unfinished visits from an earlier clinic day
select count(*) from public.visits where status in ('waiting','called','in_progress') and queue_date < (now() at time zone 'Asia/Tashkent')::date;
-- Queue tickets not delivered
select status, count(*) from public.notification_jobs where type = 'queue_ticket' and created_at > now() - interval '1 day' group by status;
-- Visits with money held but cancelled (should be 0: cancel requires refund first)
select v.id from public.visits v join public.visit_transactions t on t.visit_id = v.id where v.status = 'cancelled'
 group by v.id having sum(case when t.kind = 'collection' then t.amount else -t.amount end) <> 0;
```

## 7. Rollback

- **App:** in Vercel, promote the previous production deployment (instant).
- **Database:** the outpatient migrations only add tables and columns, so the previous app version ignores them.
  - Do **not** drop the tables: they hold real money records.
  - Rolling back the app is enough. Turn walk-in screens off by not linking staff to them, or restore the
    previous app.
- **Restoring the backup** is a last resort. It loses everything recorded since, so reconcile first.
- **Ownership:** the owner decides on rollback; the person deploying executes it and records the time and reason.
