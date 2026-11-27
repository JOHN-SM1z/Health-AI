# Clinic operations revision — 2026-10-06

This revision changes the existing product around the observed walk-in workflow. It is **not a complete MedPlus/Excel replacement or a production release**. The accepted target is documented in [CLINIC_OPERATIONS_PRODUCT.md](CLINIC_OPERATIONS_PRODUCT.md).

## Implemented in this checkout

- Reception: find an existing patient by stable number/name/phone; register an arrival; issue a printable queue ticket; call or remove a waiting patient. Registration, patient creation, clinic-local ticket allocation, price snapshot and unpaid charge are one database transaction. Retry keys bind the original request. Queues retain unfinished arrivals across midnight and paginate instead of silently hiding excess patients.
- Doctor: own walk-in queue, attributed append-only history, new clinician-written notes, printing, and simple referrals. An open referral grants the receiving doctor shared history immediately. No accept/start ceremony is required. Other authors' private notes remain private. Expiry, completion and revocation end the referral's general history grant; an independent care relationship may still grant access.
- Services cashier: authorized management staff can locate charges and record verified cash/terminal collection or a full refund with a reason. Concurrent stale writes fail. Cancelling an unpaid waiting visit voids its charge. This records money received/refunded; it does not execute a bank transfer or generate a fiscal receipt. Reception alone cannot collect money.
- Management: monthly walk-in counts, current live queue and doctor workload. Owner/admin financial totals distinguish money collected from money refunded. They are not profit or payroll calculations. Managers can see workload; existing financial-report role restrictions remain.
- Clinic configuration: walk-in by default; optional scheduled/mixed modes. Public landing/help, booking endpoint, Telegram menu and AI instructions respect the operating model. Scheduled clinics retain their appointment queue/calendar. Public information uses configured clinic facts, not a hard-coded demo name or a promise that every doctor is available 24/7.
- Staff: completed the previously unfinished owner-only staff endpoints. Database serialization protects membership changes, self-removal is refused, direct browser role writes are removed, and removing a doctor revokes access. Generated initial passwords are not falsely described as single-use passwords.

## Database and authorization corrections

The original [database audit](DATABASE_AUDIT_2026-10-05.md) remains a record of the pre-repair findings. Changes address the exposed notification/webhook RPC grants; direct paid-payment insertion; cross-clinic foreign keys and parent reassignment; missing clinical-note schema; migration dependency/enum ordering; forged referrals; mutable referral narratives; reception access to clinical content; inactive-doctor access; private-note filtering; incorrect referral columns; stale payment/queue writes; appointment reactivation/day-boundary validation; and unsafe test-environment loading.

Notification processing now checks the appointment's clinic and actual patient recipient, inspects returned database errors, and quarantines stale uncertain delivery claims instead of automatically resending them. This is not a claim of exactly-once delivery from Telegram; uncertain outcomes require review.

Tenant foreign keys validate existing rows; they do not silently repair or delete inconsistent data. Original deletion semantics are preserved for the converted legacy foreign keys. New clinical records and their authorship are append-only. The old concatenated `full-db-setup.sql` is retired because it was stale and could not safely run as one transaction.

## Migration and verification limits

No hosted database, production patient data, migration history or deployment was accessed or changed. The previously uncommitted referral migrations were split/renumbered. Any environment that already applied versions of them needs a migration-history comparison before applying this checkout. Back up and investigate inconsistent rows before validating the new constraints.

Run migrations through the ordered migration runner, one transaction per file. Do not paste all files into one SQL Editor transaction. The isolated PostgreSQL test harness creates a fresh randomly named database, applies the complete chain, uses synthetic fixtures and minimal Supabase auth/storage scaffolding, and drops only the database it created:

```bash
PGHOST=/path/to/local/unix/socket PGPORT=5432 python3 scripts/test-operations-db.py
```

The application test runner now loads only `.env.test` or `.env.test.example`. Both Supabase URL variables must be loopback addresses. It never loads `.env` or `.env.local` for fixture tests. The complete Supabase HTTP/Auth/Storage integration suites still need the local Docker stack; the PostgreSQL harness does not replace those checks or a logged-in browser walkthrough.

Final check results are recorded in [OPERATIONS_VALIDATION_2026-10-06.md](OPERATIONS_VALIDATION_2026-10-06.md). The default Turbopack build cannot start its local worker port in this environment; the supported webpack build is used as a separate compilation check.

## Still required before operational replacement (payroll deferred)

1. Inpatient admission, beds/wards, ICU transfers, rounds, package inclusions and discharge/refund rules.
2. Multi-item orders, partial settlement, discounts, cashier shifts/reconciliation, expenses and financial reconciliation. Payroll and compensation are explicitly deferred.
3. Laboratory sample tracking, complete orders, authorized result verification, printing, verified private electronic delivery and incremental analyzer connections; see [the device integration plan](labs/DEVICE_INTEGRATION_PLAN.md).
4. Department contacts, missed-inquiry tracking, and configured follow-up/result reminders. No speculative eHealth/Mehmon interface is claimed.
5. Reviewed identity/balance import, complete Supabase and browser tests, staff training, clinic-led parallel reconciliation, downtime procedures and rollback rehearsal.

Inpatient package/refund policies are inputs to the current roadmap. Wage formulas are only needed if a future payroll module is separately scoped. No commission percentage, daily bed charge, staff penalty, automatic diagnosis or AI prescription has been invented.
