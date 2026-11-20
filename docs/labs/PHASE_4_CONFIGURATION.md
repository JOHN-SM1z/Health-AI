# Laboratory Module — Phase 4 Clinic Lab Configuration

Status: **implemented and tested locally; not deployed.**

Owners, managers and admins configure their laboratory without code changes
at **/admin/lab** ("Laboratoriya" in the admin navigation).

## What can be configured

| Area | Fields |
|---|---|
| Categories | name, active — clinic-defined grouping (e.g. "Qon tahlili", "Bioximiya"); no fixed universal categories |
| Tests | code, name, category, sample type, preparation instructions, turnaround (hours), price, active |
| Parameters | code, name, value type (number / text / yes-no / choice), unit, choices, active — code and type are fixed once created |
| Reference ranges | sex (or any), age band (entered in years, stored in days), normal low/high, optional critical low/high, expected value for non-numeric parameters, method / equipment label, active |
| Panels | code, name, panel price, member tests (≥ 2), active — the screen shows the standalone total; the price is split proportionally at ordering time (O2, Phase 5) |
| Workflow settings | payment before collection (default: not required, O6); show verified results to the patient (default: yes) |

Verification mode is intentionally not configurable: a second person always
verifies (O4). Critical bounds are configured and shown only — critical-result
alerts remain deferred.

## Rules enforced on the server

- `GET /api/admin/lab/catalog` — `catalog.read` (every clinic role; no patient
  data). `POST|PATCH /api/admin/lab/{categories|tests|parameters|ranges|panels}`
  and `GET|PUT /api/admin/lab/settings` — `catalog.configure` /
  `settings.configure` (owner, manager, admin). Clinic always from the session.
- zod validation mirrors the database constraints; database refusals
  (duplicates, foreign clinic references, overlapping ranges, type mismatches)
  become plain Uzbek messages, never raw errors.
- Every referenced id (category, test, parameter, panel members) must belong to
  the session's clinic.
- Nothing is deleted. Tests, parameters, panels and ranges are deactivated;
  inactive tests cannot be newly ordered (database trigger) while history stays
  intact (items hold snapshots). A reference range only (de)activates — a
  different range is a new range, so evaluated results keep pointing at the
  range used.
- A parameter's choices cannot drop a value an active range expects.
- Every change is audited with the acting staff member (`lab_*_created` /
  `_updated`, `lab_settings_updated`).
- Settings are re-validated on every read: management can also write
  `app_settings` directly, and a malformed value falls back to the safe
  defaults.

## Tests

- `src/app/api/admin/lab/lab-config.test.ts` (real database and guards): role
  refusals (reception, doctor, lab, anonymous), a full CBC / biochemistry /
  panel configuration with actor-attributed audit, validation failures,
  overlapping ranges (409), choice protection and fixed parameter type,
  deactivation, cross-clinic read/write attempts, settings validation and the
  malformed-value fallback.
- `e2e/lab-configuration.mjs` (browser, built app): a manager configures a
  category, test, parameter and range; an overlapping range is refused with the
  reason shown in the dialog; the owner adds a lab staff member who lands on
  `/lab`, is kept out of the admin desk, can read but not configure the
  catalog, and cannot list patients. Added to `npm run test:e2e`.

## Verification (2026-10-05)

Run locally against the **real Supabase stack** (images pulled from Docker
Hub with `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`, since the default
registry is blocked in this environment):

| Check | Result |
|---|---|
| `npm test` | 774 / 774 passed, nothing skipped |
| `npm run test:e2e` | referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, HTTP red team 55/55 |
| `npm run lint`, `npm run typecheck`, `npm run build` | passed |

Doctor ordering (Phase 5) is not implemented yet; the catalog is ready for it.
