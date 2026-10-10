# Laboratory Module — Phase 9 Result Verification and Versioning

Status: **implemented and tested locally; not deployed.** The migration has not
been applied to any hosted database.

## Lifecycle (the approved states, no duplicates)

| Prompt | Health AI (`lab_result_status`) |
|---|---|
| RESULT_ENTERED | `draft` (Phase 8) |
| REVIEW | `submitted` |
| VERIFIED | `verified` |
| RESULT_READY | a `verified` result the clinic releases to patients (`releaseToPatient`, Phase 12), not another status |
| (correction) | the previous version becomes `superseded` |

```
draft ──submit──▶ submitted ──verify (second person)──▶ verified ──(correction verified)──▶ superseded
  ▲                   │
  └──── return ───────┘
```

## Database (`20261005000011_lab_result_verification.sql`)

| Function | Does, in one locked transaction |
|---|---|
| `verify_lab_result(clinic, result, verified_by)` | only a `submitted` version; never by whoever entered or submitted it (`lab_result_second_person`, also a CHECK constraint); a repeat by the same verifier is a no-op; completes the order once every test is verified or cancelled |
| `return_lab_result(clinic, result, by)` | `submitted → draft` for the same author to fix |
| `start_lab_result_correction(clinic, result, by, reason)` | only the **current verified** version; reason required; creates version n+1 (`supersedes_result_id`, `correction_reason`) starting from the verified values; one correction at a time; the same person repeating it gets the same draft |

When a correction is verified, the trigger from Phase 2 marks the previous version `superseded` in the same statement. The previous version's values, author, submitter, verifier and times stay unchanged, because no column of a verified or superseded version can change. Until the correction is verified, the earlier version **remains the verified result** everyone sees.

`save_lab_result_draft` now edits whichever version is in progress, a first result or a correction. It refuses an item that only has a verified result (`lab_result_verified`).

`lab_workflow_audit` and `lab_results_sync_item` now name the acting staff member through `lab_current_actor()`. Before this, returned results, completed orders and item moves made by the server were audited without an actor.

## Who verifies (clinic configuration)

The new setting `verifiers` in `/admin/lab` → settings can be:
- `lab_and_doctor` (default);
- `lab_only`;
- `doctor_only` — a doctor only for patients `doctor_patient_access()` admits.

Whatever the setting, the verifier is never the person who entered or submitted the version (O4, owner decision 2026-10-05). Settings are now parsed field by field, so one malformed stored field falls back to its own default without resetting the others (for example a stricter payment policy).

## Doctor ownership

- A doctor whom `doctor_patient_access()` admits reads the current verified result. The correction reason is now shown, and the previous version is kept in the lab.
- Correcting a result is open to lab staff and to the person who entered the version being corrected. A doctor who can read a result someone else entered **cannot** correct it (`correction_not_allowed`). A correction never modifies a version; it is a new version authored by whoever starts it.
- Clinical interpretation stays in the doctor's own `clinical_records`, unchanged.

## Audit

The trigger writes these, with ids, version, status and the actor only:
- `lab_result_entered`, `lab_result_submitted`, `lab_result_returned`, `lab_result_verified`;
- `lab_result_correction_started`, `lab_result_corrected`, `lab_result_superseded`, `lab_result_draft_discarded`.

The server writes `lab_result_viewed` (strict, before data is returned) for each read in the lab workspace and the doctor workspace, listing the versions shown. No values, comments or reasons go into audit rows.

## API and UI

`POST /api/lab/results/[id]` takes `{ action }`:

| Action | Requires |
|---|---|
| `submit` / `discard` (Phase 8) | `result.enter` |
| `verify` | `result.verify` + clinic verifier setting + per-patient access |
| `return` | a verifier, or the author |
| `correct` with `reason` | lab staff, or the author of the corrected version |

`GET /api/lab/items/[id]/result` now returns:
- the current version with its full provenance;
- every other version (values read-only);
- `can { verify, giveBack, correct }` for the UI. The server checks again on every action.

Work queue (`/lab`):
- **New views:** "Tekshiruvda" (results and corrections awaiting review) and "Tasdiqlangan" (verified, including orders completed in the last 14 days).
- **Badges:** "Tuzatish tekshiruvda" / "Tuzatilmoqda" mark corrections in progress. These are statuses only; the queue still carries no values.

Result dialog:
- **Tasdiqlash** and **Qayta ishlashga qaytarish** for reviewers; the author gets **Qaytarib olish** but never Tasdiqlash.
- **Tuzatish** (reason required) on a verified result.
- **Oldingi versiyalar** shows the preserved history.

## Concurrency (one final state wins)

| Race | Result |
|---|---|
| two reviewers verify at once | one verifies; the other gets `not_awaiting_review` (×4) |
| verify vs return at once | exactly one final state, matching the winner (×4) |
| two people start a correction at once | one version 2 (×4) |

## Tests

| Suite | Covers |
|---|---|
| `src/lib/supabase/lab-result-verification.test.ts` (11) | second person; order completion (and not before every test is verified); only submitted is verifiable; return → fix → resubmit, with audit actors for result and item; correction as a new version (no overwrite even for the server, reason required, replay, one at a time, starts from verified values, the earlier version stays verified until the correction is, then superseded with values and verifier preserved; version 3 from the current one only); return / discard of a correction; the three races; tenancy; no grants to signed-in roles |
| `src/app/api/lab/lab-verification.test.ts` (7) | author vs reviewer abilities, verify, order completion, recently completed orders in the queue; operational roles refused; verifier setting (lab only / doctor only) and doctor patient access; return and author take-back; correction with history, queue correction flags, doctor sees the corrected version and reason; doctor cannot correct someone else's result but can correct their own; cross-clinic 404 |
| `src/app/api/admin/lab/lab-config.test.ts` (updated) | the verifier setting validates, and one malformed field no longer resets the others |
| `e2e/lab-verification.mjs` (13) | in a browser with two lab staff members: return, author cannot verify (UI and API), second person verifies, order completes, correction with reason → version 2 listed for review → verified by another person, version 1 preserved and shown, doctor sees the correction and cannot correct it, full audit trail without values |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **869/869** across 88 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, **lab verification 13/13**, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql` is regenerated (`--check` passes).

The e2e seed adds a second demo lab user, `lab2@e2e.local`.

## Notes and not in this phase

- A correction's flags are recomputed from the reference ranges configured **when the correction is entered**. The superseded version keeps the ranges and flags it was verified with.
- Corrections of results older than the queue's 14-day window need a patient result history screen. That screen belongs to the later result-viewing phases.
- Releasing verified results to patients (RESULT_READY) is Phase 12. Notifications are a later phase. Critical alerts stay deferred.
