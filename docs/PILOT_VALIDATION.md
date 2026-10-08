# Pilot validation — evidence log

These are results on this branch (`claude/sharp-ptolemy-rl1rnc`) against a **local** Supabase stack
(Postgres 17, Auth, PostgREST and Storage in Docker) and the app built locally.
- Nothing here touched production.
- Fixture scripts refuse to run against a non-local database (`assertLocalOnly`).
- Results from other branches are not evidence for this one.

## Run 1 — 2026-10-07 (Phase 1 baseline, before the outpatient work)

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | 0 errors |
| Types | `npm run typecheck` | 0 errors |
| Unit + integration | `npm test` | **1067 passed, 0 skipped** (113 files) |
| Build | `npm run build` (default Turbopack) | passed; standalone server started |
| Browser E2E | each `e2e/*.mjs` run separately | **19 scripts, 336 checks, all passed** (below) |

| Script | Checks |
|---|---|
| referral-workflow | 84/84 |
| booking-channels | 9/9 |
| my-appointments | 6/6 |
| staff-and-safety | 14/14 |
| lab-configuration | 11/11 |
| lab-ordering | 14/14 |
| lab-collection | 15/15 |
| lab-results | 11/11 |
| lab-verification | 13/13 |
| lab-history | 12/12 |
| lab-documents | 12/12 |
| lab-patient-results | 10/10 |
| lab-import | 18/18 |
| patient-merge | 14/14 |
| lab-external | 13/13 |
| lab-notifications | 7/7 |
| lab-dashboards | 10/10 |
| lab-ai-summary | 8/8 |
| redteam-http | 55/55 |

### Defects found and fixed during this run

- **Skipped database suites are not a pass.** The first run showed 431 passed and **636 skipped**: Docker had
  stopped after a container restart, so the database suites skipped themselves. That run is discarded. The
  stack was restarted and the suite re-run with 0 skipped. Future runs must check the "skipped" count.
- **referral-workflow E2E aborted** with "slot overlaps another appointment".
  - Cause: the script's cleanup only cancelled leftover appointments of patients named `E2E …`, but
    `booking-channels` books the same demo doctors "now" under other names.
  - Fix: the cleanup now cancels any active appointment of the two demo doctors in the window. Both exist
    only in the local E2E database.
- Earlier the same day (CI, commit `18098be`), two tests failed only near Tashkent midnight. Both now keep
  their test visits off local midnight.

### What these runs do **not** cover

- Live Telegram delivery, SMS (no gateway contract), MyID/OneID (no contract), fiscal receipts or
  card-terminal integration, Click/Payme.
- Laboratory devices (no inventory or interface documentation).
- Production data: production has not been migrated beyond `20260930000005`, and its rows are not checked by
  these runs.
- Clinic acceptance: no clinic staff have used this build.

## Run 2 — 2026-10-08 (outpatient pilot: walk-in, kassa, queue, referrals)

| Gate | Result |
|---|---|
| Lint / types | 0 errors / 0 errors |
| `npm test` | **1092 passed, 0 skipped** (115 files). Includes 18 outpatient database tests and 4 outpatient route tests. |
| Build | default build passed; app started |
| Browser E2E | **20 scripts, 361 checks, all passed**. New: `outpatient-journey` 25/25. |

### Defects found and fixed in this run

- **A completed walk-in blocked the doctor's next patient.**
  - The consultation appointment kept its full booked duration. Completed appointments still count in the
    overlap rule, so the doctor got "slot taken" when starting the next queued patient.
  - Fixed in `20261007000003_visit_actual_end.sql`: the appointment ends when the visit is completed.
  - Regression test `outpatient-operations.test.ts`: it **fails with the old function and passes with the
    fix**, checked by loading each function in turn.
- **The kassa page requested the refund-permission list as a cashier** and got a 403. The page now asks only
  when the server says the user may manage grants.
- **Test isolation:** `referral-workflow` and `outpatient-journey` both use the demo doctor "now". Each now
  clears that doctor's window in the local E2E database before running.
- **Intermittent failure, observed once:** `multi-channel-booking.test.ts` failed once, in the first full run
  just after the local stack was restarted. It passed on its own and in 4 further full runs. Not reproduced and
  not hidden; to watch. **Root cause found in Run 3** (below).

### Owner decisions applied

- Queue number after full payment.
- Full payment only (cash and terminal split allowed).
- A new cashier role. Refunds: owner/manager, or a cashier with a manager's grant; admin cannot refund.
- No paper ticket: Telegram, the waiting-room screen and the Mini App instead.
- Referral history shared without an accept step.

### Still not covered

Everything listed under Run 1, plus:
- SMS tickets: no gateway.
- Named cashier shifts.
- Discounts and partial payment: no clinic rule.
- Lab orders on the visit bill (Phase 3).
- Screens that switch on `operating_mode`.

## Run 3 — 2026-10-08 (laboratory on the visit bill, walk-in lab queue)

| Gate | Result |
|---|---|
| Lint / types | 0 errors / 0 errors |
| `npm test` | **1101 passed, 0 skipped** (117 files), twice in a row. Includes 7 lab-visit database tests and 2 lab-visit route tests. |
| `full-db-setup.sql` | regenerated from 72 migrations; `--check` up to date |
| Build | default build passed; app started |
| Browser E2E | **21 scripts, 371 checks, all passed**. New: `lab-walk-in` 10/10. Every earlier script, all `lab-*` scripts included, passed unchanged. |

| Script | Checks |
|---|---|
| referral-workflow | 84/84 |
| booking-channels | 9/9 |
| my-appointments | 6/6 |
| staff-and-safety | 14/14 |
| lab-configuration | 11/11 |
| lab-ordering | 14/14 |
| lab-collection | 15/15 |
| lab-results | 11/11 |
| lab-verification | 13/13 |
| lab-history | 12/12 |
| lab-documents | 12/12 |
| lab-patient-results | 10/10 |
| lab-import | 18/18 |
| patient-merge | 14/14 |
| lab-external | 13/13 |
| lab-notifications | 7/7 |
| lab-dashboards | 10/10 |
| lab-ai-summary | 8/8 |
| outpatient-journey | 25/25 |
| lab-walk-in | 10/10 |
| redteam-http | 55/55 |

### Defects found and fixed in this run

- **The intermittent `multi-channel-booking` failure (Run 2) has a cause, and it is fixed.**
  - It failed twice in a row here, at the same line: its seed lookup `services … name = 'Terapevt qabuli'`
    `.single()` found two rows.
  - `menu-buttons.test.ts` (the bot menu work) created a second service with that name in its own test clinic.
    Whenever both files ran at the same moment, every suite that looks the seed service up by name could fail.
  - Fix: the menu test uses its own name. After the fix, two full runs had 0 failed and 0 skipped. The 11
    "skipped" in the failing runs were that file's own tests after its setup failed, so they were not a pass.
- **Cancelling a lab walk-in at reception left its tests in the lab's work queue.** Found in review before the
  first commit. Cancelling now cancels the lab order too, and is refused once a sample is taken; there is a
  database test for both.
- **A finished consultation that still owed for tests a doctor ordered in it was listed under "other"** at the
  kassa. The kassa now lists every visit that owes money under "To‘lov kutilmoqda". This is a screen grouping;
  no automated check covers it.

### Owner decisions applied

- Walk-in lab queue first; lab slot booking waits for lab hours and per-slot capacity.
- Tests are paid before the sample is taken, through the clinic's lab setting `paymentPolicy = before_collection`.
  The pilot clinic must have it on (runbook §2).

### Still not covered

Everything listed under Runs 1 and 2, minus "lab orders on the visit bill", plus:
- lab slot booking;
- a lab queue number for tests a doctor orders during a consultation (they go through the lab's work queue);
- printed labels and a generated lab report.

## Run 4 — 2026-10-08 (one-step reception lookup, Telegram queue follow-up)

| Gate | Result |
|---|---|
| Database | rebuilt from scratch with `supabase db reset` (74 migrations), then the owner account and E2E demo seeded as CI does |
| Lint / types | 0 errors / 0 errors |
| `npm test` | **1114 passed, 0 skipped** (120 files). New: 5 follow-link database tests, including 8 concurrent claims with exactly 1 winner; 2 bot tests on the real database; webhook routing; follow-link roles; search exact/mismatch; `dd.mm.yyyy` parsing. |
| `full-db-setup.sql` | regenerated from 74 migrations; `--check` up to date |
| Build | default build passed; app started |
| Browser E2E | **21 scripts, 378 checks, all passed**. `outpatient-journey` is now 32/32 (was 25). After a last one-line change to the QR component, the app was rebuilt and `outpatient-journey` (32/32) and `lab-walk-in` (10/10) were run again. |

### Defects found and fixed in this run

- **Tenant integrity.** `visit_followers.token_id` referenced the tokens table without `clinic_id`. The
  existing tenant-integrity suite caught it; the reference is now `(token_id, clinic_id)`.
- **Queue messages could arrive up to 15 minutes late.** The scheduled notification worker runs every
  15 minutes, so a queue ticket or "you are called" could sit that long. They are now delivered right
  after the payment, registration or call. Jobs are still claimed atomically, so the scheduled run never
  sends one twice.
- **A false statement was required at reception.** The reception tick "I checked the document" was
  browser-only and required even for a patient without a document. It is removed (owner: no physical
  check).

### What these runs do **not** cover

- **Real Telegram delivery.** The E2E sends a correctly signed, simulated Telegram update to the webhook,
  and checks that the follower and the "you are called" job are recorded. Messages to the stand-in bot do
  not reach Telegram. The runbook's acceptance check with the clinic's real bot and a test phone is the
  only proof of delivery.
- **MyID / OneID** (no contract) and SMS.
- **Earlier runs:** everything listed under Runs 1–3.

## Run 5 — 2026-10-08 (retention guard)

| Gate | Result |
|---|---|
| Database | rebuilt with `supabase db reset` (75 migrations). The seed marked it as a test database (1 row in `internal.retention_override`). Owner account and E2E demo created as in CI. |
| Lint / types | 0 errors / 0 errors |
| `npm test` | **1119 passed, 0 skipped** (121 files). Includes 5 new retention tests. Every existing suite's clean-up still works on the test database. |
| `full-db-setup.sql` | regenerated from 75 migrations; contains no test-database marker (asserted by a test) |
| Browser E2E | **21 scripts, 378 checks, all passed** |

**What the retention tests prove.** With the test marker removed inside a rolled-back transaction (as on
staging and production):
- deleting a clinic, a patient, a clinical record or a referral is refused, also as `service_role`;
- truncating any of the four tables is refused;
- every row is still there afterwards;
- no API role can read or write the marker.

**Staging rehearsal (owner-approved, staging only).** Started; production untouched. Status and the
connector limits are in `PILOT_RUNBOOK.md` §3.2.

