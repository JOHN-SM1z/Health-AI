# Laboratory Module — Phase 10 Longitudinal Patient Record Integration

Status: **implemented and tested locally; not deployed.** No migration is
needed in this phase.

## One record, not two

Laboratory data joins the patient record the doctor already uses, in the existing doctor patient workspace (`/doctor/patients/[id]`). No second history system is created.

| Part of the patient record | Where it lives |
|---|---|
| Consultations, diagnoses, prescriptions, treatments | `clinical_records` (existing, doctor-authored) |
| Referrals | `referrals` (existing) |
| **Laboratory orders** | `lab_orders` / `lab_order_items` (Phases 2, 5) |
| **Laboratory results** | `lab_results` / `lab_result_values` (Phases 8–9) |
| **Documents** | `lab_documents` + private bucket `lab-documents` (lab attachments) |
| Imaging | not in the product yet |

The workspace's **Laboratoriya** section now has three tabs:
- **Buyurtmalar**: orders and their status (Phase 5, unchanged);
- **Natijalar tarixi**: every verified result of the patient;
- **Dinamika**: trends.

Natijalar tarixi shows, for each result, newest first by clinical time (performed, else collected, else verified):

| Field | Shown |
|---|---|
| test | name, corrected version and reason, and a "N values outside the configured range" summary |
| dates | order date (and who ordered), collection date, performed date, verification date (and who verified) |
| source | clinic laboratory / imported / external laboratory |
| values | value + unit, the configured range used, the position against it (never an interpretation) |
| lab comment | the laboratory's technical remark |
| attachments | each opens through a 60-second signed link |

**Dinamika** shows a line per numeric parameter of a test, in one unit, with at least two results:
- the configured range of the latest value is a light band;
- hovering a point shows its date, value and position;
- a table gives the same values in text form.

## Authorization: the existing model, unchanged

- Every request calls `canDoctorAccessPatientClinicalData()`, which wraps `doctor_patient_access()`. A doctor gets in through the same route as the rest of the workspace: their own patient, or an active, unexpired referral. A failed check gives the same 404 / 410 as the rest of the workspace.
- **O3:** such a doctor sees every **verified** result of the patient in their clinic, whoever ordered it. They never see drafts, results awaiting review, superseded versions or other clinics.
- **Doctor B** (referred) sees Doctor A's ordered results. B cannot change them:
  - results are not authored by either doctor, and verified versions are immutable in the database;
  - a doctor may correct only a result they entered themselves (Phase 9).

  If B's assessment differs, B writes their own clinical record. Doctor A's clinical records stay A's (existing `clinical_records` rules, unchanged).
- Referral access ends at revocation, decline, completion or expiry, checked on every request.
- Attachments are listed and opened only for the current verified result, never for withdrawn documents. The bucket stays private; each link is short-lived and issued after the check.

## Audit

Each read is audited **strictly**, before data is returned:
- `lab_result_viewed` with `via: doctor_history`, one row per result shown;
- `lab_document_viewed`, one row per link issued.

Results are read only when the doctor opens the history or trend tab, so opening the patient workspace alone reads nothing. Audit rows carry ids only.

`src/lib/ai/clinical-isolation.test.ts` now also forbids AI code from importing `@/lib/labs/history`.

## API

| Route | Access |
|---|---|
| `GET /api/doctor/patients/[id]/lab-history` | linked doctor + `doctor_patient_access`; rate-limited; audited |
| `GET /api/doctor/patients/[id]/lab-documents/[documentId]` | same; returns `{ url, expiresIn: 60 }`; audited |

## UX fix found while testing

An attachment opened with `window.open` after an `await` loses the click's user gesture. Real browsers (Safari in particular) then block or blank the tab. The tab is now opened synchronously on the click and pointed at the signed link once it arrives.

## Tests

| Suite | Covers |
|---|---|
| `src/app/api/doctor/lab-history.test.ts` (6) | own doctor sees every verified result (newest by clinical time; a correction keeps its place) with order / collection / verification dates, verifier, source, values, ranges and live documents only; no drafts or pending reviews; strict per-result audit without values; **referred doctor** sees the same history, including results another doctor ordered; **unrelated doctor**, **another clinic's doctor**, lab staff (not a linked doctor) and anonymous are refused; **read-only**: a referred doctor cannot correct another person's result, versions keep their values, the server itself cannot rewrite a verified or superseded version; attachments through an audited 60-second link (file content verified), withdrawn and unverified ones refused; **revoked referral ends access** while the own doctor keeps it |
| `src/lib/labs/trends.test.ts` (3) | grouping by test / parameter / unit, numeric only, ordered by instant (not text), dated by performed → collected → verified |
| `e2e/lab-history.mjs` (12) | in a browser: referred Dr Nazarova sees the three verified results (not the pending one) with dates, verifier, value, position, source and the not-a-diagnosis note; opens the attached report through a signed link; sees the haemoglobin trend; reads are audited and the pending result never read; revocation ends her access; Dr Aliyev keeps his; reception refused |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **878/878** across 90 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, **lab history 12/12**, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql --check` passes.

## Not in this phase

- Uploading lab documents. The bucket, table, listing and secure opening exist; the upload screen and import come with the import / documents phase.
- Imaging: not part of the product yet.
- Patient-facing results (Phase 12) and lab notifications: later phases. Critical alerts remain deferred.
- Superseded versions are visible to lab staff (Phase 9 history), not in the doctor history. The doctor sees the current verified version and the correction reason.
