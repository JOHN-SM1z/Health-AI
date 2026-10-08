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
  not hidden; to watch.

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
