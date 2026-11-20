# Laboratory Module — Phase 8 Structured Result Entry

Status: **implemented and tested locally; not deployed.** The migration has not
been applied to any hosted database.

## What lab staff do

1. In the work queue (`/lab`, "Jarayonda"), a test whose sample the lab has received shows **Natija kiritish**.
2. The entry form lists the test's configured parameters. Each row has:
   - an input matching the parameter's type (number, text, yes/no, or a configured choice);
   - the unit;
   - the clinic's configured range for this patient's sex and age.
3. **Qoralamani saqlash** saves a draft. Each saved value then shows where it sits against that range, as computed by the database: normal, low / high, critical low / high, different from the expected text, or no range configured.
4. **Saqlash va tekshiruvga yuborish** submits a complete draft for second-person verification (Phase 9). The result is read-only from then on.

Example (the prompt's CBC):

```
Gemoglobin   118 g/L        Me’yor: 120–150 g/L   → Me’yordan past
Leykotsitlar 7,2 ×10⁹/L     Me’yor: 4–9 ×10⁹/L    → Me’yor oralig‘ida
```

The wording only ever places a value against the **configured** range. The form states this is not a diagnosis. There is no diagnosis or interpretation logic anywhere, and critical flags raise no alert, because critical alerts remain deferred.

## Database (`20261005000010_lab_result_entry.sql`)

| Function | Does, in one transaction |
|---|---|
| `save_lab_result_draft(clinic, item, entered_by, values jsonb, lab_comment?, performed_at?)` | locks the item; refuses imported orders; creates the first draft if none exists, which needs the item to be `processing` (sample received); refuses a submitted result (`lab_result_submitted`), a verified one (`lab_result_verified`, so a change must be a correction) and **someone else's draft** (`lab_result_draft_owned`); sets or clears each value |
| `submit_lab_result(clinic, result, submitted_by)` | only the draft's author; every **active** parameter must have a value (`lab_result_incomplete`); draft → submitted, item → resulted; a repeat by the same person is a no-op |
| `discard_lab_result_draft(clinic, result, by)` | any staff member of the clinic (the route requires `result.enter`) may discard a draft, for example one left by a colleague; audited with that person as the actor |
| `lab_entry_ranges(clinic, item)` | the range each parameter would use for this patient now |
| `lab_applicable_range(parameter, sex, age_days)` | **the** range choice, now used both by the value trigger and by the preview, so the screen and the stored flag cannot disagree |
| `lab_current_actor()` | names the acting staff member for trigger-written audit rows (`app.lab_actor`), since the server runs as `service_role` |

`lab_result_values_validate` is unchanged except for two things:
- it calls `lab_applicable_range`;
- it now also enforces the parameter's configured **decimal places**.

Type, configured choices, inactive parameters and "parameter of this test" were already enforced. Unit, range snapshot and flag are still set by the database, never by the caller.

### Why only the author edits a draft

O4 requires that the person who entered a result cannot verify it. If a colleague could change values in someone else's draft, that colleague would be recorded neither as `entered_by` nor `submitted_by`, and could then verify values they had partly typed. So a draft has exactly one author. Others can only discard it and start their own.

## Validation, three times

1. **Screen:** `src/lib/labs/values.ts` (`parseParameterValue`) shows a mistake inline and disables saving. Numbers accept a decimal comma and are kept as text, so no precision is lost.
2. **Server:** the same parser runs again in `saveResultDraft` before the database is called. The parameter must belong to the item's test, and an error names the parameter code.
3. **Database:** the triggers check type, choices, decimals, active status and the test, whatever the caller sends.

## Access

- `result.enter` (lab, doctor) is enforced at the route.
- `resolveLabResultAccess` is then applied per patient:
  - lab staff: their clinic's lab work;
  - doctors: only own or referred patients;
  - everyone else, and anyone of another clinic: **404**.
- Owner, manager, admin and receptionist get 403 and see no values (O5).
- The entry read is audited **strictly** (`lab_result_viewed`, `via: result_entry`) before any value is returned. The route is rate-limited.
- Trigger audit rows carry ids, version and status only: `lab_result_entered`, `lab_result_submitted` and `lab_result_draft_discarded`, the last with the real actor.
- `src/lib/ai/clinical-isolation.test.ts` now also forbids AI code from importing `@/lib/labs/results` and `@/lib/labs/collection`.

## API

| Route | Capability |
|---|---|
| `GET /api/lab/items/[id]/result` | `result.enter` + per-patient access; parameters, ranges, current draft or submitted result (audited) |
| `PUT /api/lab/items/[id]/result` `{ values: [{ parameterId, value }], labComment? }` | `result.enter` + per-patient access; save the caller's draft |
| `POST /api/lab/results/[id]` `{ action: "submit" \| "discard" }` | `result.enter` + per-patient access |

## Tests

| Suite | Covers |
|---|---|
| `src/lib/supabase/lab-result-entry.test.ts` (10) | flags from the sex-specific range (women 120–150 → 118 low; critical; boolean expected text); any-sex range when sex is unknown, with the same preview; refusals for wrong type, non-numeric input, choice, decimals, another test's parameter, duplicates, unknown and inactive parameters (nothing stored); submit only complete and only by the author, then no edits (including direct writes) and no discard; once verified, a save is refused; colleague discard is audited with the actor and they can then start their own; not before receipt; tenancy; **two people starting the same result at once → one draft (×4)**; audit carries no values; no grants to signed-in roles |
| `src/app/api/lab/lab-results.test.ts` (8) | role matrix (owner and receptionist 403, anonymous 401); ranges and flags through the API; audited read without values; server-side refusals (400, nothing stored); submit / owner / incomplete / read-only; discard and re-entry; waits for receipt; a doctor only for their own patient; cross-clinic 404 |
| `src/lib/labs/values.test.ts` (5) | number parsing (comma, sign, decimals, magnitude), boolean, choice and text parsing, clearing, range labels |
| `e2e/lab-results.mjs` (11) | in a browser: reception has no access; the lab sees the range, an invalid number is blocked, saved values show the database's flags and the not-a-diagnosis note, submit is blocked until complete, then submitted, stored exactly, read-only, and the read is audited |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **851/851** across 86 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, **lab result entry 11/11**, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql` is regenerated (`--check` passes).

## Not in this phase

- Verification, returning a result for correction, and corrections / new versions of verified results are Phase 9. The database already enforces second-person verification and versioning, and this phase refuses edits to submitted or verified results.
- A doctor entry screen: the API admits doctors for their own patients, but the UI is the lab workspace only.
- Document upload (`lab_documents`) and import of external results: later phases.
- Critical-result alerts: deferred by owner decision. Critical flags are shown, not sent anywhere.
