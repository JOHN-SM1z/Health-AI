# Outpatient pilot — baseline, gap list and execution order

Started 2026-10-07 on branch `claude/sharp-ptolemy-rl1rnc` (draft PR #14). This is a working checklist, not a release
approval. Every status below is backed by code or a test in this checkout; "verified" means an automated test or
browser script in this repository exercises it. Historical results quoted elsewhere (for example "48 migrations,
55 database checks, 319 tests") belong to another branch and are **not** evidence for this one.

## 1. Which code is the baseline

Two divergent lines of work exist:

| | This branch (`claude/sharp-ptolemy-rl1rnc`) | `codex/clinic-operations-pilot` |
|---|---|---|
| Based on | current `main` (the lineage production runs) | `main` as of before 2026-09-27; 40 commits behind |
| Production database | matches: production has `main`'s 24 migrations up to `20260930000005_unified_booking_engine` (read-only check 2026-10-07) | none of its migrations are in production |
| Referrals | `main`'s clinical referrals (`20260927…`–`20260929…`) | a separate referral implementation (`20260920…`) |
| Laboratory | full lab module: catalogue, multi-test orders, payments, specimens, entry, two-person verification, versions, documents, patient release, import, external labs, merge, notifications, dashboards | a doctor-only lab workbench (`20261006102150`) |
| Walk-in operations | **missing** | visits, queue numbers, single-service charge, manual collection/refund, doctor queue, simple referrals |

**Decision:** this branch is the baseline. The codex branch is **not merged**:
- its migration versions collide with this branch (both use `20261005000001`… for different files);
- its referral schema conflicts with the one production already has;
- it retires `supabase/full-db-setup.sql`, which this branch keeps current.

Its walk-in design and its five product documents are the requirements source. Its SQL is re-implemented on top
of this branch's schema rather than copied, and the codex branch is left untouched.

## 2. Workflow checklist

Legend: **V** implemented and verified · **U** implemented, unverified · **M** missing · **B** blocked by external input

### Identity and reception
| Workflow | Status | Evidence / gap |
|---|---|---|
| Patient search by name/phone (staff) | V | `/admin/patients`, `src/app/api/admin/patients` tests |
| Stable patient identifiers: PINFL, document number, DOB, sex stored | V | `20261005000001_patient_lab_identity.sql`; DOB/sex entry `patient-demographics.test.ts` |
| Search by document number / PINFL + DOB with identity confirmation before selecting | M | no such search or confirmation step |
| Human-readable patient number for the talon/registry | M | patients have only UUIDs |
| Walk-in arrival registered in one transaction (patient, arrival, charge) | M | only doctor-started walk-in consultations exist (`start_walk_in_consultation`) |
| Live queue (waiting/called/in progress/done) by doctor or department | M | |
| Printable queue talon | M | no print view anywhere in the app |
| Unfinished arrivals survive midnight | M | |
| Duplicate-retry and concurrent-arrival safety | M | (booking engine has idempotency keys; arrivals do not exist yet) |
| Walk-in / scheduled / mixed operation setting | M | today the clinic is booking-first |
| Online identity via MyID / OneID | B | needs a UZINFOCOM / OneID contract, test credentials and documentation |
| SMS queue notifications for patients without a smartphone | B | needs an SMS gateway contract and credentials; only Telegram exists |

### Billing and cashier
| Workflow | Status | Evidence / gap |
|---|---|---|
| Server-controlled prices, price snapshot on the charge | V (appointments, lab orders) | booking engine resolves the amount; lab order lines snapshot prices (`lab-kassa.test.ts`) |
| Itemized multi-service charges for a visit | M | appointment payment is one amount per appointment |
| Charged / paid / refunded / outstanding shown separately | M | status only |
| Cash vs card-terminal recorded once (no double count from two receipts) | M | manual payment has no method |
| `cashier` role, distinct from registration | M | decided 2026-10-07 (`docs/decisions/2026-10-07-retention-tenancy-refunds.md`) |
| Refunds: owner/manager, cashier only with a manager's grant, partial, with reason | M | today owner/admin, full only |
| Concurrent payment/refund writes safe | U | `status-concurrency` tests cover status flips only |
| Cashier totals by payment method (shift reconciliation) | M | |
| Discounts, partial payment, payment exceptions | B | no clinic policy supplied — not to be invented |
| Fiscal receipts / card-terminal or Click/Payme integration | B | not implemented; only `manual` payment is production-usable |

### Doctors and referrals
| Workflow | Status | Evidence / gap |
|---|---|---|
| Doctor's own appointment queue | V | `/doctor`, booking/e2e tests |
| Doctor's walk-in queue | M | depends on arrivals |
| Authorized history (own patient / referral), audited reads | V | `doctor_patient_access()`, `canDoctorAccessPatientClinicalData()`, `clinical-access.test.ts`, `e2e/referral-workflow.mjs` |
| Clinician-authored, append-only records; corrections as new records | V | `clinical_records`, `clinical-records.test.ts` |
| Referral grants the receiving doctor shared history **immediately**, no accept/start step | M (partial) | a pending referral is visible to the receiver, but the referring doctor's visit history opens only after `accepted`/`in_progress` (`doctor_patient_access`) |
| Referral expiry/revocation ends access | V | `referral-lifecycle.test.ts` |
| Printable consultation record / prescription | M | |
| Cross-clinic history (Clinic A → B) | M | decided 2026-10-07; needs its own design (decision record §3) |

### Laboratory
| Workflow | Status | Evidence / gap |
|---|---|---|
| Test catalogue, panels, reference ranges (clinic-entered) | V | Phases 2–4, `e2e/lab-configuration.mjs` |
| Orders with several tests, by any clinic staff | V | Phase 5, `e2e/lab-ordering.mjs` |
| Order payment, lab kassa | V | Phase 6 |
| Specimen ids, collection, receipt, rejection, recollection | V | Phase 7, `e2e/lab-collection.mjs` |
| Printed barcode labels | M | codes are on screen only; printer model unknown (B for printer choice) |
| Manual result entry, partial results, flags from clinic ranges | V | Phase 8 |
| Two-person verification, versions, corrections with reason | V | Phase 9 |
| Release to patient (finalized only, verified Telegram identity) | V | Phase 12 |
| Printable lab report | M | documents can be uploaded; no generated report |
| Delivery jobs with status and retries | V (Telegram) / B (SMS) | Phase 16 |
| Lab booking (collection slot) through the shared booking engine | M | booking engine is doctor-only today |
| Verifier permissions, self-verification | V | setting `verifiers`; self-verification refused (owner decision O4) |
| Critical-result escalation | B | deferred by owner decision; no thresholds invented |
| Device connections | B | no inventory or interface manuals (`DEVICE_INTEGRATION_PLAN.md` on the codex branch) |

### Platform, security, operations
| Workflow | Status | Evidence / gap |
|---|---|---|
| RLS on every exposed table; server-only clinical reads | V | `security/*`, `e2e/redteam-http.mjs` |
| Tenant isolation, forged clinic/actor/patient/payment rejected | V | tenant-isolation and red-team suites |
| Notification claims atomic; uncertain delivery never re-sent | V | processor tests (Phase 16) |
| Retention: database refuses to destroy clinical history | M | clinic/patient deletes still cascade (decision record §1) |
| Clinic suspended/terminated enforcement | M | decision record §2 |
| Backup / restore rehearsal, downtime procedure, monitoring | M | Phase 4 package |
| Inpatient (beds, admission, transfers, packages) | M | Phase 5, after the outpatient pilot |
| Payroll | out of scope | deferred by owner |

## 3. Execution order

**Outpatient pilot (this release)**
1. Phase 1: run every gate on this checkout and record results (`docs/PILOT_VALIDATION.md`).
2. Phase 2a: cashier role, refund grants and a payment ledger: collections by method, partial refunds, and
   charged/paid/refunded/outstanding.
3. Phase 2b: walk-in arrivals: patient number, identity search with confirmation, one-transaction registration
   with itemized charges, live queue, talon, doctor walk-in queue, and midnight carry-over.
4. Phase 2c: immediate referral history access without accept/start.
5. Phase 2d: corrections: wrong patient, wrong service or duplicate entry go through void and re-register,
   audited, never a rewrite.
6. Phase 3:
   - lab orders billed through the visit's charges;
   - lab collection booking on the shared booking engine (booking ≠ lab order ≠ specimen ≠ queue ticket);
   - printable labels and reports.
7. Phase 4: pilot package: configuration checks, migration plan, backup/restore, onboarding, downtime,
   monitoring and rollback.

**After the pilot (full replacement):** inpatient operations (Phase 5); device connections (Phase 6); MyID/OneID
and SMS once contracts exist; cross-clinic history.

## 4. Inputs needed from the clinic (work continues around them)

- Pilot departments, staff list and roles. Name the acceptance contact.
- Service catalogue with current prices, and doctor–service assignments and hours.
- Rules for discounts, partial payment, payment exceptions and refunds beyond the decided roles.
- Whether payment is required before the queue ticket, before consultation, or neither.
- Lab: approved report layout, label printer model, and the critical-result procedure.
- External contracts: MyID/OneID, SMS gateway, fiscal receipt/terminal provider.
