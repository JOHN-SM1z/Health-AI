# Laboratory Module — Phase 13 Historical Lab Import Engine

Status: **implemented and tested locally; not deployed.** The migration has not been applied to any hosted database, and no real clinic data has been imported.

This is a migration tool for lab staff, not a patient workflow.

## Flow

```
CSV exported from MedPlus / Excel / another lab system   (no provider API assumed)
  → Upload            file stored as rows of cells; nothing imported
  → Schema detection  delimiter, headers, suggested column mapping
  → Field mapping     the preparer confirms or changes it
  → Validation        every cell against the catalog and the parameter's type
  → Patient matching  exact identifiers only; weak matches wait for a person
  → Duplicates        in the file and against the clinic's records
  → Preview           counts, every row with its status and reasons
  → Dry run           every ready result inserted, then rolled back
  → Confirmation      by a SECOND lab staff member
  → Import            each result on its own; failures retryable
  → Report            row number, status and reasons (CSV)
```

Screens: **Laboratoriya → Import** (`/lab/imports`, `/lab/imports/<id>`).

## What a file looks like

- One row is one parameter value: patient identifiers, test, parameter, value, unit, date, and an optional source order or sample number.
- The file is UTF-8 CSV, separated by comma, semicolon or tab, up to 2 MB, 5,000 rows and 50 columns.
- Excel workbooks and PDFs are recognised and refused with an explanation. A PDF has no reliable table to read, and no external format is assumed.
- Tests and parameters are found in the clinic's catalog, by code or by exact name.
  - A historical test missing from the catalog must be added to it first; it may be inactive.
  - Units must match the catalog and are **never converted**.

## Patient matching (there is no merge tool yet)

| Outcome | When | Imported? |
|---|---|---|
| `ready` (exact) | Health AI patient id, PINFL or passport/ID number names exactly one patient, and nothing in the row contradicts that patient (birth date, PINFL, document, sex) | yes |
| `possible_match` | No strong identifier matched, but phone + birth date (or full name + birth date) fit exactly one patient | only after the preparer clicks **"Shu bemor"** (recorded as `staff_confirmed` with who) |
| `conflict` | Identifiers point to different patients; a contradiction with the patient they name; an unknown Health AI id; **several patients fit (possible duplicate patients)** | never — resolve the records first |
| `unmatched` | No patient fits | never — no patient is created |

- **A name alone never matches anyone.** A row with only a name is invalid (`no_identifiers`).
- A name or phone that differs on an exact match is shown as a warning.
- No patient is created, changed or merged.

## Duplicates — nothing is overwritten

- **Same file again:** refused at upload (sha256, one live batch per file).
- **Same line twice in the file:** the second is a `duplicate` and is left out of the result.
- **Two different values for one parameter in the file:** both rows are a `conflict`.
- **Already in the clinic**, i.e. an existing result (any source, any status but superseded) for the same patient, test and day:
  - same values → `duplicate`;
  - different values → `conflict`.
  
  The existing result is never replaced or merged.
- **Two results for one patient and test on one day in the file:** `conflict`. They cannot be told apart from duplicates; enter them by hand.
- The database re-checks both rules when it imports. An import key (`import:<sha256 of patient | test | time | accession>`, unique per clinic) prevents a double import.

## A result is imported whole or not at all

A "group" (one patient, one test, one moment, one accession) becomes one result. If any row of the group has a problem, the other rows of that group are held back too (`group_has_errors`). A result is never imported with values missing.

## How an import is recorded

| | |
|---|---|
| Order | `lab_orders.source = external_import`, `external_reference = import:<key>`, ordered by the preparer, completed |
| Item | the catalog test (snapshot); no payment and no bill is created |
| Result | `source = import`, `performed_at` = **the historical date** from the file (a date alone is noon in the clinic's time zone), entered and submitted by the preparer, **verified by the confirmer** (the O4 second-person CHECK still applies) |
| Values | flags against the clinic's configured ranges, as for every result (placement only, never interpretation) |
| Patient notification | **none.** The `lab_result_ready` trigger now skips `source = import` |
| Lab work queue / doctor's order list | imported orders are left out. The results appear in the doctor's lab history (labelled "Import qilingan") and, once released, in the patient's Mini App list |

## Who

- New capability **`import.manage`: lab only.** The file holds result values and patient identifiers, which owner, manager, admin and receptionist must not see (O5).
- The **preparer** uploads, maps, analyses and confirms suggested patients.
- A **different** lab staff member confirms and runs the import, including retries. This is enforced in three places:
  - the server;
  - `run_lab_import` (`lab_import_second_person`);
  - the CHECK `confirmed_by <> created_by`.
- The confirmation must follow an analysis less than 24 hours old, and must be of the exact analysis the confirmer saw: the update is conditioned on `analysed_at`.

## Database (`20261005000015_lab_import.sql`)

**`lab_import_batches`** and **`lab_import_rows`**
- RLS on, no policies, and `service_role` only: signed-in and anonymous clients get nothing.
- Guard triggers:
  - the cells and the preparer never change;
  - finished batches are frozen;
  - imported rows are frozen;
  - states move only `uploaded → analysed → confirmed → completed` (or `cancelled`).

**`store_lab_import_analysis`**
- Writes the analysis of every row and the batch's new state in **one locked transaction**, so a confirmation cannot land halfway.
- Only the preparer, and only before confirmation.

**`run_lab_import(clinic, batch, actor, dry_run, after_row, max_groups)`**
- Runs each group in its own subtransaction (**partial import**).
- Records failures as **codes only**, because database messages may quote a value.
- A dry run performs every insert up to submission, then rolls the group back.

## Failures and retry

- Groups that fail at import time become `failed` with a code, for example `value_rejected` when the catalog changed after the preview, or `preparer_not_staff`. **"Xatolarni qayta urinish"** retries them.
- A group that meets an existing result at import time becomes `duplicate` and is not retried.
- An import runs about 20 seconds per request. **"Davom ettirish"** continues it.
- **"Yakunlash"** closes the import and leaves the rest `skipped`.
- **"Bekor qilish"** stops it. Results already imported stay; they are verified records, corrected only by the normal correction flow.

## Privacy

- Audit events carry ids, counts and codes only, never file names, cells, identifiers or values:
  - `lab_import_uploaded`, `lab_import_analysed`, `lab_import_dry_run`;
  - `lab_import_match_confirmed` (with the patient id);
  - `lab_import_confirmed`, `lab_import_run`, `lab_import_finished`, `lab_import_cancelled`;
  - `lab_import_rows_viewed` (strict, before the rows are returned);
  - `lab_import_report_downloaded`.
- The CSV report has the row number, status and reason only. Fields are formula-neutralised.
- `clinical-isolation.test.ts` now also keeps AI, the bot, the Mini App and notifications away from `@/lib/labs/imports`, `@/lib/labs/import/*` and `lab_import_*`.

## Tests

| Suite | Covers |
|---|---|
| `src/lib/labs/import/import.test.ts` (18) | CSV (quotes, BOM, `;`/tab, ragged rows kept, broken/xlsx/pdf/binary/non-UTF-8 refused, limits); mapping suggestion and rules; identifiers, dates (day-first, impossible dates, time zone), typed values (decimals, choices, booleans, no guessing); matching (exact, warnings, contradictions, unknown id, weak → possible, **duplicate patients**, **never by name alone**); analysis (**valid data**, **malformed rows**, **mixed valid/invalid**, group held back, **duplicates in file**, conflicting values, same-day, **existing results**, confirmed weak match) |
| `src/app/api/lab/lab-imports.test.ts` (7) | Real routes and database. **Valid data** end to end:<br>• two people; dry run writes nothing; historical date and source kept; entered by the preparer and verified by the confirmer; no notification, no payment, not in the queue; audit has no values; re-upload refused; the same data in another file is a duplicate.<br>**Mixed file:** only the valid result imported; report without values.<br>**Unmatched / name-only / duplicate patients / contradiction:** nothing imported, no patient created.<br>**Duplicate results:** in the file and in the clinic; the existing result is untouched.<br>**Weak match:** only a suggested patient, only by the preparer, audited.<br>**Partial failure:** one group duplicate, one failed; the preparer may not retry; the retry imports it.<br>**Access:** owner, reception and doctor get 403; another clinic gets 404; cross-site upload refused; anon and signed-in clients cannot read the tables or run the functions; the database refuses a self-confirmation; cancel freezes it |
| `e2e/lab-import.mjs` (18) | Browser:<br>• upload, suggested mapping, analysis, the unmatched reason shown;<br>• the preparer is not offered confirmation;<br>• weak match confirmed on screen;<br>• the second technician on a phone screen: dry run, confirm;<br>• results verified with the historical date; nobody notified;<br>• report without identifiers or values;<br>• not in the queue; reception gets 403 |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **926/926** across 95 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, **lab import 18/18**, HTTP red team 55/55.
- Lint, typecheck and build pass. `full-db-setup.sql` is regenerated and `--check` passes.

## Not verified / open decisions

- **Real exports.** No real MedPlus or other export was available, so the column names, date formats and encodings of the clinic's actual files are untested.
  - Windows-1251 (Cyrillic) files are refused; they must be saved as UTF-8.
  - Wide layouts (one column per parameter) are not supported; rows must be in long format.
- **Patients missing from Health AI** are reported, not created. Deciding how to register them, and how to resolve duplicate patient records, is Phase 14 (patient merge).
- **Patient visibility.** Imported results are verified, so the Mini App shows them while the clinic releases results, but nobody is notified. If old results should stay staff-only, that needs a decision (for example a per-source release setting).
- **Retention.** The uploaded cells (`lab_import_rows.raw`) are kept as the import's evidence. How long to keep them is the same open decision as for documents.
- **Who may import.** Lab staff only. If the clinic wants a manager to run migrations, that would conflict with O5 (no result values for management).
- **Item prices.** Imported items carry today's catalog price as a snapshot but have no bill. Phase 17 revenue figures must exclude `external_import`.
- **Throughput** has been checked only at test sizes. 5,000 rows per file analyse in one request; very large migrations should be split into several files.
