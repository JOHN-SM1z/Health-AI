# Structured prescribing — implementation record

27 November 2026, Asia/Tashkent · Technical specification v1.1 (14 November 2026), §9.2–9.3 and §14 · workstream W13 · built on `codex/clinic-operations-pilot` @ `3eb2d66`

This change adds the doctor's prescribing workflow: a drug catalogue with search, a clinic formulary, an ICD-10 catalogue, allergies on the patient card, and prescriptions that are drafted, signed, replaced and cancelled. It follows the [103-requirement audit](SPECIFICATION_GAP_AUDIT_2026-11-20.md), where these rows were "Missing". No production database, hosted setting or deployment was touched; everything was built and tested against a local disposable stack.

Nothing in this workflow uses AI (RX-03). Search results are what the catalogue holds for the typed letters, templates and "recent" are the doctor's own rows, and the allergy warning is an exact match of recorded data.

## What is built

| Requirement | State now | Where |
| --- | --- | --- |
| RX-01 Drug catalogue and search | Built. INN, Latin INN, trade name, form, strength, manufacturer, registration number, class, aliases, prescription-only and controlled flags, active flag, source, version and import record. Search from two characters by prefix over every name and word, in Latin or Cyrillic, and by trigram similarity from four characters; further words narrow by strength or form. | `drug_catalog`, `drug_search_terms`, `search_drug_catalog()` in [the migration](../supabase/migrations/20261126000001_structured_prescribing.sql) · [`GET /api/doctor/drugs`](../src/app/api/doctor/drugs/route.ts) |
| RX-02 Catalogue source | Built for all three options. The shared catalogue is loaded only from a named file with [the import script](../scripts/import-reference-data.mjs); a clinic can keep its own entries until one is loaded. Source and version are shown in the screen footer. No entry is generated, and no catalogue data ships in this repository. | `reference_data_imports`, `import_drug_catalog()` · [formulary page](../src/app/admin/formulary/page.tsx) |
| RX-03 No AI in prescribing | Holds. No model is called anywhere in `src/lib/prescribing`. | — |
| RX-04 Controlled medicines | Built. A controlled medicine is listed in search with a "Nazoratdagi" chip and cannot be added; the database refuses it in a draft and again at signing if it became controlled meanwhile. | `save_prescription_draft()`, `sign_prescription()` |
| RX-05 National e-prescription, phase 1 | Built. Prescription-only items show a copy panel (INN, form, dose, schedule, days, quantity) and a field for the national number; the prescription is marked "Milliy e-retsept talab qilinadi" until the number is recorded. Phase 2 (server integration) still waits for the Ministry. | [`prescription-workspace.tsx`](../src/components/doctor/prescription-workspace.tsx) · `record_national_rx_number()` |
| RX-06 Immutable after signing | Built. A signed prescription and its items cannot be edited or deleted. Replacing writes a new signed prescription that names the old one and a reason; cancelling writes a correction record with a reason. The free-text record form cannot "correct" a structured prescription around this. | `prescriptions_guard`, `prescription_items_guard`, `clinical_records_prescription_guard` |
| RX-07 Printed copy and verification | Built. The print view carries clinic, doctor, date, items and a QR code of `/v/<code>`. That page says only whether the sheet is genuine and current (clinic, doctor, date, valid / replaced / cancelled). The database stores the SHA-256 of the code, never the code. | [print page](../src/app/doctor/prescriptions/[id]/print/page.tsx) · [`/v/[code]`](../src/app/v/[code]/page.tsx) · `verify_prescription_code()` |
| RX-08 Interactions | Out of scope, as specified. The screen and the footer say that interactions are not checked. | — |
| DW-01 Signed work is a clinical record | Holds. Signing inserts the doctor-authored `clinical_records` entry in the same transaction; the prescription is readable exactly where that record is. | `sign_prescription()` · [`prescriptions.ts`](../src/lib/prescribing/prescriptions.ts) |
| DW-02 ICD-10 picker | Built, without data. Catalogue table, import and a picker by code prefix or name words in the diagnosis form. Once a catalogue is loaded, a diagnosis code must be an active entry; until then the code is typed by hand as before. | `icd10_codes`, `search_icd10()` · [`clinical-record-form.tsx`](../src/components/doctor/clinical-record-form.tsx) |
| DW-03 Allergies | Built. Recorded by a doctor who treats the patient, shown at the top of the patient page, never edited (marked inactive with a reason). At signing, a medicine that matches an active allergy — by the chosen catalogue entry, INN, Latin INN, alias or class, in either script — blocks until the doctor writes a reason for that item. | `patient_allergies`, `prescription_allergy_matches()` · [`patient-allergies.tsx`](../src/components/doctor/patient-allergies.tsx) |
| EV-05 Drug search tests | Built. Latin and Cyrillic prefixes, misspellings, INN versus trade name, both flags, clinic isolation, ordering and latency on 4,000 synthetic entries. | [`prescribing.test.ts`](../src/lib/supabase/prescribing.test.ts) |

## Access

Every new table has RLS on and no grant to `anon` or `authenticated`; every new function is callable by the server role only. The release preflight now requires these functions and flags any browser grant on them.

| Data | Who reaches it | How |
| --- | --- | --- |
| Drug and ICD-10 search | A linked doctor | Server route; rate-limited per doctor |
| Clinic formulary | Owner and administrator | `/api/admin/formulary*`; each change audited |
| Allergies | A doctor with a clinical relationship (own patient or active referral) | Same decision as clinical records (`doctor_patient_access`); each read audited |
| Signed prescriptions | The same doctors who can read the consultation's clinical records | Same coverage filter as clinical records; each read audited |
| Drafts | Only the doctor who wrote them | — |
| Writing, signing, cancelling, national number | Only the author, in their own started consultation | Enforced in the database functions as well as the routes |
| Public verification | Anyone holding the printed code | Clinic, doctor, date, status only |

Audit rows carry ids, counts and statuses. Medicines, doses, instructions, allergy substances and reasons do not reach `audit_events` or the logs; the tests check this with marker strings.

The drug catalogue is reference data shared by all clinics, with an optional owning clinic (`owner_clinic_id`) for a clinic's own entries. A clinic row may point at a shared entry, so these references cannot carry `clinic_id` in the foreign key the way references between tenant tables do. Each referencing table (`clinic_formulary`, `patient_allergies`, `prescription_items`) has a trigger instead that refuses another clinic's own entry, and the tests cover all three. References between the tenant tables themselves — a prescription to the one it replaces and to its clinical records — are composite keys that include the clinic.

The spec's access table also gives lab staff sight of allergies and reception a print-only path. Neither is built: both need a design that keeps the existing clinical disclosure boundary.

## Loading the catalogues

```bash
# Check a file without writing anything
node scripts/import-reference-data.mjs --dataset drug_catalog --file register.csv \
  --source uz-register --source-version 2026-11 --dry-run

# Load it (one transaction; SUPABASE_DB_URL is read from the environment and never printed)
SUPABASE_DB_URL=… node scripts/import-reference-data.mjs --dataset drug_catalog --file register.csv \
  --source uz-register --source-version 2026-11 --deactivate-missing

SUPABASE_DB_URL=… node scripts/import-reference-data.mjs --dataset icd10 --file icd10.csv \
  --source who-icd10-uz --source-version 2019
```

Every drug row must say `rx_only` and `controlled` explicitly; a blank is an error, not a "no". A newer file updates entries by registration number, and entries missing from it are deactivated only with `--deactivate-missing`. Nothing is deleted, because signed prescriptions keep pointing at their entries.

The migration needs `pg_trgm` in the `extensions` schema and stops with an explanation if it finds the extension elsewhere.

## Decisions this leaves with the owner

| Decision | What depends on it |
| --- | --- |
| D-11 Catalogue source | Which file is loaded. Until then clinics type their own entries, including the prescription-only and controlled flags — the clinic's medical lead should review those. |
| Who maintains the formulary | Built as owner and administrator. The manager role is excluded because the flags decide what can be prescribed. |
| `AGENTS.md` | This change lists `patient_allergies` and `prescriptions` beside `clinical_records` as doctor-only clinical data. Please review the wording. |
| D-13 Send by default | Not built; patient delivery (W14) is a separate workstream. The sign button says "Imzolash", not "Imzolash va yuborish", so nothing claims a delivery that does not happen. |

## Not built

- The four-tab workspace layout and the Sign / Send / Print / Refer action bar of §9.2. The prescription section and the allergy card were added to the existing page so the 25 browser workflows keep their selectors.
- Patient delivery of signed prescriptions and "Mening hujjatlarim" (W14).
- National Elektron retsept integration, phase 2 (W15).
- Allergies for lab staff, and reception print access.
- A browser end-to-end script for prescribing. The flow is covered through the real routes against the real database, not through a browser.
- Chronic conditions on the patient card (DW-03 mentions them beside allergies).

## Verification

| Check | Result |
| --- | --- |
| Database guarantees, [`src/lib/supabase/prescribing.test.ts`](../src/lib/supabase/prescribing.test.ts) | 25 tests: grants, search, imports, drafts, signing, immutability, allergies, replace, cancel, national number, verification, templates, and erasing a clinic with signed prescriptions |
| Real routes on the real database, [`src/app/api/doctor/prescribing.test.ts`](../src/app/api/doctor/prescribing.test.ts) | 7 tests: formulary roles, search, allergies, the allergy-blocked signing flow, document and public verification, replacement, templates; refusals for an unrelated doctor, another clinic's doctor, owner and reception |
| Quantity arithmetic, [`options.test.ts`](../src/lib/prescribing/options.test.ts) | 4 tests |
| Full gates (lint, typecheck, full suite, schema rehearsal, build, browser workflows) | Recorded in the [security assessment](SECURITY_ASSESSMENT_2026-11-27.md#verification-of-this-branch), which covers the whole branch |
