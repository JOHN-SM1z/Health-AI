# Laboratory Module — Phase 14 Patient Merge Tool

Status: **implemented and tested locally; not deployed.** The migration has not been applied to any hosted database.

The patient record is the root of the longitudinal record, so the merge is **non-destructive**:
- It **links** the duplicate record to the canonical record.
- Nothing recorded for either record is moved, rewritten or deleted.
- It can be undone.

Screen: **Boshqaruv → Kartalarni birlashtirish** (`/admin/patients/merge`), owner and administrator only.

## What links to a patient (inspected)

| Entity | Link | What a merge does |
|---|---|---|
| appointments, payments, conversations, referrals | `(patient_id, clinic_id)` FK, cascade | stay on their record; read as one person |
| clinical_records | FK; immutable; authored by a doctor in their own consultation | stay; **authorship untouched** |
| lab_orders → items → samples → results → values; lab_documents | composite FKs that include `patient_id`; results and values frozen once verified | stay (versions, verifier, dates unchanged) |
| audit_events | append-only, tenant-checked | untouched; two new `patient_merged` rows are added |
| analytics_events | FK, set null | untouched |
| notification_jobs | via appointment / lab result; Telegram id | appointment jobs block the merge; "result ready" jobs still reach the person |
| lab_import_rows | FK, set null | rows still waiting to import block the merge |

**Why not move rows to the canonical record?**
- Clinical records and verified lab results are immutable by design.
- The lab chain's composite keys include `patient_id`.
- Audit rows are append-only.

Re-pointing would rewrite whom a historical fact was recorded about, and would need those safeguards switched off. A link changes no fact and is fully reversible.

## How it works

| Piece | |
|---|---|
| `patients.merged_into_patient_id`, `merged_at` | the link (same-clinic composite FK; never self). Merges are one level deep: a merged record cannot be canonical, and a record with merged records cannot be merged |
| `patient_merges` | the log: who, when, why, the confirmed preview, identity moved and facts copied, and the undoing. It cannot be rewritten or deleted (trigger) |
| `patient_record_group(patient)` | the canonical record plus the records merged into it (the same from any member) |
| `doctor_patient_access()` | the **same rules over the group**. A doctor still sees only their own visits, referral-linked visits and shared histories; never clinic-wide access |
| Server reads (`patientRecordIds`) | doctor workspace (visits, records, referrals), lab history and results, lab orders, Mini App results and visits, desk patient detail, front-desk referral list |
| `refuse_merged_patient` trigger | a merged record takes **no new** appointments, lab orders, referrals, clinical records or conversations. Desk bookings and walk-in lab orders for an old record go to the canonical record |
| Lists | the directory, desk/lab patient search and possible-duplicate suggestions show live records only. The doctor's list shows the person once |
| Imports (Phase 13) | a file naming an old record's Health AI id matches the canonical record |

### Identity
**Unique identifiers move** to the canonical record when only the duplicate has them, so the bot and future imports find the person there:
- the Telegram identity (with its name fields);
- PINFL;
- passport/ID number.

**Facts the canonical record lacks are copied:** date of birth, sex, name, phone and consent. The duplicate keeps its own copy.

Everything moved or copied is recorded on the merge.

## Merge workflow

1. **Select** the canonical record and the duplicate. Possible-duplicate suggestions are offered (same name and birth date, same phone and birth date, or same name and phone without contradicting dates); they are never merged automatically.
2. **Complete preview** (`patient_merge_preview`):
   - both records' details;
   - counts of every entity above for each record;
   - the identity plan (keep / same / copy / move / differs);
   - blockers;
   - warnings, including **the doctors whose access will extend** to the combined record.

   No clinical text, result values or identifier values are shown.
3. **Conflicts stop the merge.** These are blockers; nothing is guessed:
   - the two records disagree on date of birth, sex, PINFL or passport/ID;
   - they hold two different Telegram identities;
   - the duplicate has live work: upcoming or ongoing visits, open referrals, active lab orders or unfinished results, open conversations, pending appointment notifications, or import rows waiting.
   
   Differing names or phones are warnings: the canonical record's value stays.
4. **Confirm.** The staff member gives a reason and confirms it is the same person, checked against a document.
5. **Merge** (`merge_patients`), in one transaction:
   - locks both records in a fixed order;
   - checks the actor is the clinic's owner or administrator;
   - recomputes the preview and refuses if any blocker exists or **anything changed since the preview** (fingerprint);
   - moves/copies identity, links, logs and audits.
6. **Unmerge** (`unmerge_patients`):
   - removes the link;
   - moves each identifier back **only if it is exactly as the merge left it**; otherwise it reports the identifier and leaves it in place;
   - keeps copied facts on the canonical record (the duplicate still has its own);
   - reports what was created on the canonical record after the merge (that stays);
   - audits.

## Requirements → how they are met

| Requirement | |
|---|---|
| Canonical / duplicate / complete preview / conflicts | above |
| Preserves longitudinal history | nothing moves; reads and access cover the group |
| Does not modify another doctor's authorship | clinical records untouched (tested: same author, same patient id) |
| Does not lose audit history | no audit row changes; new rows are added |
| Does not cross clinics | composite keys; every read and function is scoped to the clinic; another clinic's record is "not found" |
| Does not silently change historical facts | no recorded row changes. Identity moves and copies are previewed, logged and reversible |
| Auditable | `patient_merged` / `patient_unmerged` on both records; `patient_merge_previewed`. Ids and field names only, never identity values or the reason text |
| Clinic-scoped, authorized, transactional | owner/admin in the route **and** in the database function; row locks; one transaction |
| Reversible | unmerge, as described above |

## Tests

| Suite | Covers |
|---|---|
| `src/app/api/admin/patient-merge.test.ts` (6) | Real routes and database. **Complete preview** (counts, plan, doctors gaining access, no identity values); confirmation required. **Nothing changes**: snapshots of every linked table are identical before and after, clinical-record authorship kept, earlier audit rows intact, audit without values. **Longitudinal record**:<br>• each doctor sees only their own visits across both records;<br>• opening the old record shows the canonical one;<br>• lab history from both records;<br>• one entry in the doctor's list;<br>• an unrelated doctor still denied;<br>• the Telegram identity resolves to the canonical record and the Mini App lists both records' results;<br>• the directory lists the person once.<br>**Unmerge**: identity restored, access back to before, a second unmerge refused, the log cannot be rewritten or deleted. **Blockers**: each identity contradiction; live visits, lab orders and conversations; same, unknown and other-clinic records. **Stale preview** and forged fingerprint refused. **Concurrency**: the same duplicate into two records, and two records into each other — exactly one wins. **Chains** refused. **Merged record takes no new work** (direct inserts refused; a desk booking goes to the canonical record). **Authorization**: manager, receptionist, doctor and lab get 403; the database refuses a non-admin actor and another clinic's owner; anonymous and signed-in clients cannot read the log, run the functions or set the link. **Suggestions** never merge |
| `src/lib/labs/import/import.test.ts` (+1) | an import naming a merged record's id matches the canonical record; a contradiction still conflicts |
| `src/app/api/admin/patients/route.test.ts` (updated) | the detail reads the person's group |
| `e2e/patient-merge.mjs` (14) | Browser:<br>• suggestion → full preview (counts, identity move, access warning) → reason and confirmation required → merge (linked, Telegram moved, visit not moved);<br>• the merged record no longer offered in search;<br>• a birth-date contradiction blocks the merge on screen;<br>• unmerge from the log restores everything;<br>• audited without values;<br>• reception has no screen and gets 403 |

Local run after a clean `supabase db reset`:
- `npm test`: **933/933**.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, **patient merge 14/14**, HTTP red team 55/55.
- Lint, typecheck and build pass; `full-db-setup.sql` regenerated.

## Not built / decisions

- **Deleting a patient** that is part of a merge is refused by the foreign keys (unmerge first). There is no patient deletion feature today.
- **Analytics** counting distinct patients still counts merged records separately.
- **Who may merge:** owner and administrator, one person. A second-person approval, like lab verification, can be added if wanted.
- **Bulk automatic duplicate resolution** is intentionally not built. Suggestions need a person, and the import (Phase 13) still imports only exact or staff-confirmed matches.
