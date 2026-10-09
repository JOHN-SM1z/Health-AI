# Outpatient pilot — release runbook (Phase 4)

This runbook is preparation only. **No production migration, deployment or patient-facing activation is
authorized by this document.** Each of those needs the owner's explicit go-ahead at the time.

> **2026-10-08 additions** — identity privacy, online identity, online payment and SMS add migrations
> `20261008000005` and `20261008000010`–`20261008000013`. Operator guide: `docs/PILOT_ONLINE_SERVICES.md`.
> Decisions: `docs/decisions/2026-10-08-identity-online-booking-payments-sms.md`. All switches are off by default;
> the same apply-by-name rule below holds for these files.

## 1. What production has today (read-only check, 2026-10-07)

- **Supabase project `cpoiachyfozjnlguaykz`.** It has 24 migrations, ending with `20260930000005_unified_booking_engine`.
  - The migration history was applied **by name, with different version stamps** than the files.
  - **Never run `supabase db push` against it.** Apply the missing files by name, one transaction per file, in
    order.
- **Missing in production:**
  - `20260930000006_tenant_integrity_hardening` (check whether it is present by name first);
  - the 21 laboratory migrations `20261005000001`–`021`;
  - the outpatient migrations `20261007000001`–`003`;
  - the laboratory-visit migration `20261008000001_lab_visits` (needs the laboratory migrations);
  - the Telegram queue follow-up `20261008000002_queue_called_enum` and `20261008000003_visit_follow`;
  - the retention guard `20261008000004_retention_guard`.
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
| Lab setting "Namuna faqat to‘lovdan keyin olinadi" (owner 2026-10-08: paid before the sample) | `/admin/lab` → To‘lov va namuna olish. Without it, lab walk-in tests are collectable before payment |
| Lab opening hours and per-slot capacity | lab slot booking (not built yet) |
| SMS gateway, MyID/OneID, fiscal receipt provider contracts | blocked features |

## 3. Release steps (when authorized)

1. **Freeze and back up.**
   - Take a Supabase backup (dashboard → Database → Backups); free plan users should take a manual
     `pg_dump` first.
   - Write down the time and the backup id.
2. **Rehearse on staging first.**
   - Staging project `qoupbbsspzfyjqfzykuk` ("Health AI staging") has the repository's migrations up to
     `20261005000021`, with matching stamps. Spot-checked 2026-10-08: function sources identical to the repo.
   - Apply `20261007000001`–`003` and `20261008000001`–`004` there by name. Then run the acceptance checks in
     §5 against a staging deployment.
   - **Progress 2026-10-08:**
     - Applied, owner-approved, through the Supabase connector:
       - `operations_enums`;
       - `20261007000002` in parts: `outpatient_operations_part1_schema`, `…part2a_helpers_registration`,
         `…part2b_kassa`, `…part2c_charges_queue`.
     - **Stopped before** `start_visit_consultation` and `doctor_patient_access`, then `20261007000003` and
       `20261008000001`–`004`.
       - The connector holds every statement containing `delete`/`drop` for the owner's confirmation; from
         the agent's session that times out.
       - Finish in the Supabase SQL editor, or approve the connector prompts.
     - Staging is safe in this partial state: the new tables are server-only and the old
       `doctor_patient_access` still applies.
   - **The connector times out on large files.** Apply `20261007000002` as separate parts, or use the SQL
     editor. Each function's revoke/grant goes in the same part as the function.
3. **Pre-flight on production (read-only):**
   - migration names present;
   - no rows that would violate the new constraints. The new tables are empty; `patients.patient_number` is
     backfilled by the migration in `created_at` order.
   - after `20261008000004`: `select count(*) from internal.retention_override` **must be 0**. A row there
     would make clinics and patients deletable. It is only ever seeded on local and CI test databases.
4. **Apply to production by name, one file per transaction:**
   - first, the lab files `20261005000001`–`021`, if the lab module is part of the release (decision needed);
   - then `20261007000001_operations_enums`, `20261007000002_outpatient_operations` and
     `20261007000003_visit_actual_end`;
   - then, with the lab files, `20261008000001_lab_visits` (laboratory on the visit bill, lab queue);
   - then `20261008000002_queue_called_enum` and `20261008000003_visit_follow` (the kassa's Telegram QR and
     "you are called"). The enum file must be committed before the next one, so they are separate
     transactions;
   - then `20261008000004_retention_guard` (clinics, patients, clinical records and referrals can no longer
     be deleted). It changes no data. To roll back, drop the triggers, which nobody should need.
   - Every existing clinic becomes `operating_mode = 'mixed'`, so bookings keep working.
5. **Deploy the app** by merging the release branch into `main`; Vercel builds `health-ai-w1vc`. Then check
   that `/api/health` and `/login` respond.
6. **Smoke test with a test patient,** then cancel and refund it:
   - registration → payment → queue number → doctor queue → complete;
   - the waiting-room screen `/queue/<clinic id>` shows the number;
   - the patient's Telegram receives the ticket, if linked;
   - a lab walk-in with one test: one bill at the kassa, the test collectable only after payment, the lab
     calls the number. Cancel the test in the lab and refund at the kassa.

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
- [ ] A lab walk-in shows its tests as lines of one bill; `/admin/lab-kassa` shows no second bill for it.
- [ ] The tests cannot be collected before full payment, and can be after.
- [ ] The kassa cannot remove a test line. A test cancelled in the lab leaves the bill; if paid, the kassa shows
      "Qaytarilishi kerak".
- [ ] The waiting-room screen shows the lab's numbers under "Laboratoriya".
- [ ] Reception: passport + `dd.mm.yyyy` opens a returning card at once.
  - With no card, the new-patient form opens with both filled in.
  - A wrong date of birth is caught.
  - A patient without a document is taken with "Hujjat yo‘q — davom etish".
- [ ] **With the clinic's real bot**, scan the kassa QR with a test phone. The ticket arrives in Telegram.
  - Calling the number delivers "Navbatingiz keldi" within seconds.
  - "🔄 Navbatim" shows the position.
  - Scanning the same QR from a second phone gets the neutral refusal.
  - This is the only check of real Telegram delivery: local tests use a stand-in bot.

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
-- "You are called" messages not delivered today (failed, or still pending after 5 minutes)
select status, count(*) from public.notification_jobs where type = 'queue_called' and created_at > now() - interval '1 day'
   and (status = 'failed' or (status = 'pending' and created_at < now() - interval '5 minutes')) group by status;
-- Retention guard active: must be 0 (a row makes clinics and patients deletable)
select count(*) from internal.retention_override;
-- Visit-billed lab tests still held although the visit owes nothing (should be 0)
select i.id from public.lab_order_items i join public.lab_orders o on o.id = i.order_id
 where o.visit_id is not null and i.status = 'ordered'
   and (select outstanding from public.visit_balance(o.visit_id)) <= 0;
```

## 7. Rollback

- **App:** in Vercel, promote the previous production deployment (instant).
- **Database:** the outpatient migrations only add tables and columns, so the previous app version ignores them.
  `20261008000001` also adds triggers on lab orders and payments; they act only on orders billed to a walk-in
  visit, which an older app never creates.
  - Do **not** drop the tables: they hold real money records.
  - Rolling back the app is enough. Turn walk-in screens off by not linking staff to them, or restore the
    previous app.
- **Restoring the backup** is a last resort. It loses everything recorded since, so reconcile first.
- **Ownership:** the owner decides on rollback; the person deploying executes it and records the time and reason.
