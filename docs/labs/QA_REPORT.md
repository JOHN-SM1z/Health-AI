# Laboratory Module — QA Report (Phase 20)

Date: 2026-10-06. Branch `claude/sharp-ptolemy-rl1rnc`, after Phases 0–19.

**This is a local QA pass. It does not show production readiness.** Everything below ran against a local Supabase stack (PostgreSQL 17, Docker) and a local production build of the app, with Chromium. What that leaves unverified is listed at the end; Phase 21 (release gate) must close or accept each item.

## Gates run

From a clean `supabase db reset`, with all 68 migrations replayed from scratch and the seed loaded:

| Gate | Command | Result |
|---|---|---|
| Lint | `npm run lint` | pass, 0 warnings |
| Typecheck | `npm run typecheck` | pass |
| Unit tests | `npm test` (pure modules: aggregators, AI fact builder and checker, import parser, values, trends, permissions…) | 361 tests in 46 files — pass |
| API / integration tests | `npm test` (`src/app/api/**`: real route handlers + real database) | 337 tests in 40 files — pass |
| Database / RLS tests | `npm test` (`src/lib/supabase/**`: SQL as `anon` / `authenticated` / `service_role`, triggers, functions, concurrency) | 352 tests in 23 files — pass |
| **All tests** | `npm test` | **1050 / 1050 passed**, 109 files. Of these, 340 lab-specific: 110 unit, 133 API, 97 database. |
| Migration tests | clean reset + `full-db-setup.test.ts` (the single-file setup equals the migrations, each migration once and in order) + `build-full-db-setup --check` | pass |
| Build | `npm run build` (standalone production build, then served for E2E) | pass |
| E2E | `npm run test:e2e` (Chromium, desktop and phone viewports) | **all 18 scripts pass** — see below |

E2E: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering + Kassa 14/14, **lab collection 14/14** (now including cancellation), lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, patient merge 14/14, lab external 13/13, lab notifications 7/7, lab dashboards 10/10, lab AI summary 8/8, HTTP red team 55/55.

## The critical path — one connected run

`src/app/api/lab/critical-path.test.ts` (new, 11 steps) walks the whole chain for one patient through the **real route handlers, database, notification worker and storage**. Only Telegram's network call and the AI provider are stubbed, and the stubs record what they receive.

| # | Step | Verified |
|---|---|---|
| 1 | Patient → doctor consultation → lab order | Dr A orders from the consultation. A repeated request (same key) returns the same order, so there is one order. An inactive test is refused. Another clinic's patient → 404. The price is the catalog price at ordering. |
| 2 | Payment according to clinic policy | The policy is `before_collection`. Collection before payment → 409 `awaiting_payment`. Reception may not take payment (403). The owner takes cash; a forged amount in the request is ignored and the stored 60 000 is kept. The test is then released for collection. |
| 3 | Sample collection | Collection works once. The same request replays; a new collection of the same test → `already_collected`. |
| 4 | Processing → result entry | The lab receives the sample. An empty result cannot be submitted (missing values). The report PDF is attached to the version being entered. A repeated submission changes nothing. |
| 5 | Verification | The enterer cannot verify (409). A second lab person verifies. A late second verification changes nothing: one verification, one audit row. |
| 6 | Longitudinal history | The doctor's history shows 112 g/L, flagged low against the configured 120–160. |
| 7 | Doctor notification | The doctor's inbox has "Laboratoriya natijasi tasdiqlandi", without the value. |
| 8 | Patient Telegram notification | **Interruption:** the first send fails, so the job stays pending with attempt 1. The retry sends it. A second worker run sends nothing. **One message**, to the patient's own chat, with no value or test name. |
| 9 | Patient result view | Mini App with real signed `initData`: the list and detail show the patient's own verified result. |
| 10 | Secure document access | A 60-second signed link; the downloaded bytes are the stored PDF. **Patient mismatch:** another patient of the clinic gets 404 for the result and the document, and the result is absent from their list. |
| 11 | AI summary when enabled | Enabled → `source: ai` with the value. **AI unavailable** → computed, same statements. **AI disabled** → computed, same statements. |

The same suite also covers:
- **Correction:** version 2 via a second person; version 1 superseded; the patient sees the corrected value; one new "result ready" message.
- **Cancellation and refund:** see Q1 below.
- **Single lab person on shift:** the result waits for a second verifier, and nothing reaches the patient.
- **Inactive doctor:** no history and no ordering (403).

## Scenario matrix

| Scenario | Where verified |
|---|---|
| Normal flow, end to end | `critical-path.test.ts`. In the browser: `lab-ordering`, `lab-collection`, `lab-results`, `lab-verification`, `lab-history`, `lab-documents`, `lab-patient-results`, `lab-notifications` (E2E) |
| Failure / interruption flow | critical path: payment before collection, failed Telegram send and retry, AI unavailable, single lab person. `lab-imports.test.ts`: partial import, failed rows retried. `lab-external.test.ts`: provider down, retry limit, lost response |
| Cancellation | critical path (unpaid → bill to 0; paid → refund; collected → refused; repeat → no change; another clinic → 404; a doctor without the patient → 404; the patient's doctor may). **E2E** `lab-collection`: reception cancels from the queue. `lab-notifications.test.ts`: who is told |
| Refund where supported | critical path (paid → cancelled → refunded, whole payment); `lab-kassa.test.ts` (refund rules, illegal transitions). Partial refunds are not supported by the existing payment engine (Phase 6) |
| Duplicate order | critical path (same key → same order); `lab-ordering.test.ts`; `lab-security-review.test.ts` (three concurrent requests → one order) |
| Duplicate sample | critical path; `lab-collection.test.ts` (three-way race → one sample ×5; same-key race); `lab-queue.test.ts` (API race → one 201) |
| Duplicate result submission | critical path; `lab-result-entry.test.ts` |
| Result correction | critical path; `lab-result-verification.test.ts`; `lab-verification.test.ts`; E2E `lab-verification` |
| Verification race | critical path; `lab-result-verification.test.ts` (×4 rounds); `lab-security-review.test.ts` (doctor and lab at once) |
| Patient mismatch | critical path (another patient's result and document → 404); `me/lab-results.test.ts`; `lab-history.test.ts` |
| Cross-clinic mismatch | critical path; `lab-redteam.test.ts`; `lab-security-review.test.ts`; every per-phase suite |
| Inactive test | critical path (ordering refused); `lab-ordering.test.ts`; `lab-config.test.ts` |
| Inactive doctor | critical path (history and ordering → 403); `clinical-access.test.ts` (database) |
| Missing verifier | critical path (one lab person: stays submitted, nothing released); `lab-security-review.test.ts` (verifier setting enforced in the database) |
| Missing result | critical path (no values → cannot submit); `lab-result-entry.test.ts` (every parameter required) |
| Imported result | `lab-imports.test.ts` (end to end with two people, historical date, source `import`, no patient message); E2E `lab-import` |
| Imported PDF | **A PDF data file is refused** with a clear code (`file_pdf_not_supported`, `lab-imports.test.ts`) — only CSV is parsed. A PDF report from the old system is attached to the result as a document (`lab-documents.test.ts`) |
| Malformed CSV | `import.test.ts` (broken files, wrong cell counts, formulas neutralised); `lab-imports.test.ts` (mixed file → partial import with a report) |
| Duplicate patient | `import.test.ts` / `lab-imports.test.ts` (possible duplicates reported, never imported by name alone); `patient-merge.test.ts` (non-destructive merge) |
| Unmatched patient | `lab-imports.test.ts` (never imported; weak matches wait for confirmation) |
| Failed notification | critical path (retry once, then sent); `lab-notifications.test.ts` (give-up after the limit, wrong patient skipped) |
| AI disabled | critical path; `lab-summary.test.ts`; `rewrite.test.ts`; E2E `lab-ai-summary` |
| AI unavailable | critical path; `lab-summary.test.ts`; `rewrite.test.ts` |

## Found and fixed in this phase

**Q1 — no way to cancel a lab order in the application.**
- **What was there:** the database supported cancellation since Phase 2. A trigger cancels the open tests, an unpaid bill drops to the remaining tests, a paid bill shows "Qaytarish kerak" at the Kassa, and Phase 16 notifications go out. The permission model granted `order.cancel` to every clinic role. But no route or screen used it; Phase 7 noted "no cancel route exists yet".
- **What was added:**
  - `POST /api/lab/orders/[id]` `{ action: "cancel", reason }`. The work-queue roles may cancel any order of their clinic; a doctor only an order of a patient they may access. A reason is required. It is idempotent. The database refuses an order with a collected sample (409).
  - "Buyurtmani bekor qilish" on each order card in the work queue (`/lab`, `/admin/lab-queue`) while no sample has been taken, with a reason dialog.
- **Tests:** critical path step 10, and E2E `lab-collection` (two new checks).

**Test-only corrections:** three of my own new assertions assumed the wrong behaviour.
- The Telegram send takes one payload object.
- A document attaches before verification; a verified version is frozen.
- A correction's patient message is the per-version "result ready".

The product behaviour was right in each case.

## What was NOT verified

These are not covered by any automated or local test here.

**External services**
1. **Real Telegram delivery.** The Bot API call is stubbed. Message text, chat id, retry and idempotency are verified; actual delivery and rendering in Telegram clients are not.
2. **Real Telegram Mini App WebView.** `initData` signing is verified with real HMAC, but the app has not run inside Telegram on a phone. Mobile layout is checked only in Chromium's phone viewport.
3. **A real AI provider.** No provider is configured, and no external AI call was made. The checks are verified against recorded good and bad answers only.
4. **A real external laboratory.** Only the mock adapter exists, and it is refused in production.
5. **Online payments (Click/Payme).** Not built for lab orders. Lab payments are manual at the desk, the only mode the project allows in production.

**Deployment and environment**

6. **The production database.** Migrations were replayed only on a local PostgreSQL 17. The hosted Supabase version, existing production data, applying migrations 20261005000001–21 to that data, and rollback were not tested. The F1 `MAINTAIN` revoke is conditional on PostgreSQL 17 or newer.
7. **Production configuration.** Environment variables, secrets, cron schedules (`/api/notifications/process`, `/api/lab/providers/process`), storage bucket settings and the Vercel deployment itself were not tested. `ALLOW_MOCK_LAB_PROVIDER` is set only in local and CI runs.

**Coverage gaps**

8. **Load and performance.** No volume test: no thousands of orders, no long result histories at clinic scale, no concurrent desks beyond the race tests. The dashboard and analytics reads have documented caps (5 000 open tests, 20 000 orders per period).
9. **Browsers other than Chromium; accessibility.** Firefox, Safari and real phones were not tested. There was no audit beyond role and label-based selectors.
10. **Clinical and wording review.** Uzbek wording, flag wording and the AI summary statements have not been reviewed by clinicians or native-speaking staff.
11. **Time zones other than the demo clinic's.** The seed picks a daytime zone. One unrelated pre-existing test (`workspace.test.ts`) fails only in the last ~15 minutes before midnight, Tashkent time. A separate task was suggested; it is not lab-related.
12. **Backups, retention and legal requirements** for lab data and documents. Retention is an open owner decision.

## Recommendation

The module behaves correctly and safely across every scenario in scope **on a local stack**. Before any clinic uses it, Phase 21 should:
1. apply the migrations to a staging copy of production;
2. run the E2E suite against staging;
3. confirm real Telegram delivery and Mini App use on a phone;
4. set the cron jobs;
5. keep the AI and external-lab switches off until their provider decisions are made.
