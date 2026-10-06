# Laboratory Module — Phase 11 Result Documents and Secure Storage

Status: **implemented and tested locally; not deployed.** The migration has not
been applied to any hosted database.

## One storage architecture

Lab files use the existing pattern from voice messages:
- a **private** Supabase bucket (`lab-documents`, Phase 2);
- objects at `<clinic_id>/<id>`;
- a `service_role`-only storage policy;
- no policy for `anon` or `authenticated`.

Bytes are delivered **only** through 60-second signed links that the server issues after its own authorization. Public URLs serve nothing. The bucket itself also enforces the 20 MiB limit and the four allowed types.

Each `lab_documents` row keeps:
- clinic, patient, order and result (optional);
- kind: `report` (PDF report), `scan`, `image` or `import_source` (imported laboratory report);
- MIME type, size, SHA-256;
- `uploaded_by` and `created_at`.

## Rules

| Rule | Where it is enforced |
|---|---|
| Upload is lab work (`document.upload`: lab) for a patient of the uploader's clinic | route + `resolveLabResultAccess` |
| The file type comes from the file's own bytes (PDF / JPEG / PNG / WebP); the name and the browser's declared type are ignored; an executable, HTML or SVG renamed `.pdf` / `.png` is refused (415) | `src/lib/labs/file-type.ts` + table CHECK + bucket |
| 1 byte … 20 MiB (empty 400, larger 413, declared size checked before the body is read) | route + table CHECK + bucket |
| Attached to the order and, while the result is a **draft or in review**, to that result. A verified version's evidence is final; a corrected report goes with the correction (new version) | `lab_documents_validate` (new) + server |
| The result must belong to the same order, patient and clinic | composite FKs + trigger |
| An upload posted from another site (any `Origin` but this one, including `null`) is refused | upload route |
| Bytes first, row second; if the row is refused, the orphaned bytes are removed | `uploadLabDocument` |
| Retrieval: 60-second signed link after the check, audited (`lab_document_viewed`, strict); withdrawn documents are not offered | server |
| **No deletion.** Documents are **withdrawn** with a reason; the row and the bytes are retained (clinical retention). The server has no DELETE privilege, and the trigger refuses deletes too | table grant + trigger |
| A draft with attached documents cannot be discarded (it would leave retained records pointing at nothing) | `discard_lab_result_draft` (new) |
| Doctors see only documents of the current verified result, never withdrawn ones (Phase 10) | server |
| Audit: `lab_document_uploaded`, `lab_document_viewed`, `lab_document_withdrawn` — ids and kind only, never file names, contents or reasons | triggers + server |

## API

| Route | Access |
|---|---|
| `GET /api/lab/orders/[id]/documents` | lab staff; metadata (withdrawn ones marked) |
| `POST /api/lab/orders/[id]/documents` (multipart: `file`, `kind`, `resultId?`) | lab staff; same-origin; rate-limited |
| `GET /api/lab/documents/[id]` | lab staff; `{ url, expiresIn: 60 }`; audited |
| `POST /api/lab/documents/[id]` `{ action: "withdraw", reason }` | lab staff |
| `GET /api/doctor/patients/[id]/lab-documents/[documentId]` | linked doctor with `doctor_patient_access` (Phase 10) |

## UI

The lab result dialog has an **Ilovalar** panel:
- the order's files, each labelled with its result version, uploader and time;
- **Ochish** opens a signed link. The tab opens in the click, so browsers don't block it;
- **Olib tashlash** withdraws a file with a reason, and the panel states that the file is kept;
- **Fayl biriktirish** lets you choose a kind and attach a file while the result is a draft or in review.

The doctor's lab history (Phase 10) lists and opens the current verified result's files.

## Tests (including direct URL / API attacks)

| Suite | Covers |
|---|---|
| `src/app/api/lab/lab-documents.test.ts` (8) | upload with full provenance, stored bytes and SHA-256 match, order-level import source; **forged types** (exe as PDF, HTML as PNG, SVG) 415, empty 400, **20 MiB + 1 byte** 413, missing / non-file / bad kind 400, nothing stored; **cross-site** and `Origin: null` uploads 403; reception / owner / doctor 403, anonymous 401; a result of another order 404, a **verified** result 409, a draft with documents not discarded; signed link works, a **tampered signed path** fails, withdrawal requires a reason, is final, closes the link and keeps the bytes; audit trail without the reason; **another clinic's** lab staff get 404 on list / upload / link / withdraw, path-traversal and non-UUID ids 404; **direct bucket and table attacks** by an anonymous client and by signed-in lab staff of the same and of another clinic (download, list, sign, upload, remove, select), and the **public URL**, all fail with the file untouched |
| `src/lib/labs/file-type.test.ts` (2) | byte signatures for PDF / JPEG / PNG / WebP; executable, HTML, SVG, truncated, WAVE-in-RIFF and empty refused |
| `src/lib/labs/permissions.test.ts` (+1) | `document.upload` is lab-only, clinical group |
| `e2e/lab-documents.mjs` (12) | no-session API calls 401; in the browser the technician's renamed non-PDF is refused, two PDFs attach with provenance, a file opens through a signed link, the duplicate is withdrawn with a reason and no longer offered; after verification the doctor sees the report but not the withdrawn copy and cannot use the lab document API; the storage **public URL**, the **token-less object URL** and a **forged signature** serve nothing |
| Phase 2 / 10 suites (updated) | documents are now attached before verification, as the new rule requires |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **889/889** across 92 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, **lab documents 12/12**, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql` is regenerated (`--check` passes).

## Not in this phase

- Importing external laboratory reports as structured results: the import phase. `import_source` documents can already be attached to an order.
- Malware scanning of uploads: no scanner exists in the project. Files are never served inline from this app (only through Supabase signed links), and only PDF / image types pass.
- Document retention periods and the eventual purge: a legal / product decision, still open from the Phase 0 audit. Nothing is deleted today.
