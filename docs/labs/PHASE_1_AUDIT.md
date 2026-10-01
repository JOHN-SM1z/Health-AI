# Laboratory module — Phase 1 audit

Audit only. No table, migration, API or UI was created or changed; the only file added is this one.
Everything below is read from the repository at the commit named in §1; where something was not
verified it says so (§12).

## 1. Base branch — decide this before Phase 2

The Lab specification assumes Health AI already has *versioned doctor-owned clinical records,
longitudinal history, referrals, retention rules and full-history access*. In the repository that is
true only on an **unmerged stack**:

| Branch / PR | Migrations | What it adds |
| --- | --- | --- |
| `origin/main` | 47 (last `20260930000006`) | referrals, `clinical_records` (v1, append-only, corrections by new record), booking engine, tenant-integrity hardening |
| PR #10 `claude/clinical-records-governance` (open) | 48 | author-only versioned records (`version`, `root_record_id`), `retention_policies`, patient deletion never cascades into clinical data |
| PR #13 `claude/longitudinal-on-retention` (open, draft; supersedes #11's longitudinal part) | 55 (last `20261002000005`) | `doctor_patient_access()` full-history decision, department referrals, retention `RESTRICT` FKs, patient-creation audit, phone normalization, referral warnings |

This audit was run on **PR #13's head (`019711c`)** because it is the only tree in which the Lab
spec's assumptions about clinical access hold. The worktree that was handed over (`musing-benz`) was
30 commits behind `main` and on a base that has none of it. **Consequence: the Lab module must be built
on top of #13 (or on `main` after #10 and #13 are merged).** Building on today's `main` would mean
re-deriving the access model the Lab phases rely on. Production has applied migrations only up to
`20260930000006` (read from its migration list), so every migration in #10/#13 is also still unapplied there.

## 2. Premises of the Lab prompt that do not match the codebase

| Prompt says Health AI "already has" | Reality (evidence) | Consequence for the Lab plan |
| --- | --- | --- |
| clinic configuration / "Configurable Clinic OS" | There is no configuration layer. `clinics` has name/timezone/currency/hours; per-clinic key/value settings exist only as `app_settings (clinic_id, key, value jsonb)` (`20260813000007`) behind `/api/admin/settings` | Lab configuration (tests, panels, policies) is new. Policy flags (e.g. payment-before-collection, verification on/off) can use `app_settings` with a validated schema, but anything relational (tests, parameters) needs real tables |
| Kassa | No Kassa module. `src/app/admin/finance/page.tsx` ("Moliya") is a cash-flow *view* over `payments`; payments are created by the booking engine | See §6 — the Lab↔payment integration is a real schema decision, not a reuse |
| queue | No queue entity, number, screen or live tracking anywhere (grep: no `queue_*`) | Out of Lab scope; do not assume it in Lab phases |
| payments attached to appointments/services | `payments.appointment_id uuid NOT NULL`, `unique (appointment_id)` (`20260813000005`) — exactly one payment per appointment, FK `on delete cascade` (later `RESTRICT`) | A lab order has no appointment; it cannot own a payment row today |
| digital receipts | None (grep: no receipt) | Phase 5's "reuse the existing receipt architecture" has nothing to reuse |
| secure file storage | One private bucket, `voice-messages`, with voice-specific retention (`src/lib/voice/retention.ts`); no document storage and no signed-URL helper for clinical files | A lab-document bucket + access path is new work that should copy the voice pattern's *privacy* (private, server-mediated), not its retention |
| patient identity: ID/passport/PINFL/DOB | `patients` has **none** of these. Identity = name, phone (+ `phone_normalized`), verified Telegram id | Phase 9's matching by passport/PINFL/date of birth cannot be built without adding sensitive identifier columns (own privacy/retention/encryption decisions) |
| patient merge | Does not exist (open item in `TASKS.md`) | Must precede bulk lab import (the spec already says so) |
| doctor-owned clinical records usable for lab results | `clinical_records.author_doctor_id NOT NULL`, composite FK to the author's *own consultation* | A lab technician cannot author a `clinical_records` row — see §4 |
| notifications for results | `notification_job_type` has 6 values, all booking/chat-shaped; jobs link to `appointment_id`/`conversation_id` only | A result notification needs a new job type and a link to a lab entity |
| patients view results in Telegram | The Mini App has only booking/confirmation/my-appointments/privacy/help pages; and **`AGENTS.md` (this branch) forbids showing clinical text to patients or the patient-facing bot** | Phase 8 is blocked by a rule, not by code — §8 |
| AI summarizes lab data | **`AGENTS.md` forbids AI reading/writing/summarising clinical text** | Phase 12 is blocked by a rule — §8 |

## 3. Existing architecture relevant to labs (answers to the 14 audit questions)

1. **Laboratory entities that already exist.** None as tables/services/UI. The only trace is two
   values of `clinical_record_type`, `lab_order` and `lab_result` (`20260928000001`), both
   *doctor-written free-text* records (`summary` ≤ 300 chars, `details` ≤ 4000), with a "Laboratoriya"
   tab in the doctor workspace (`src/app/doctor/patients/[id]/page.tsx`, `TABS`) and labels in
   `src/lib/clinical-records/categories.ts`. These stay: they are the doctor's own note ("I ordered /
   I interpret"), not the laboratory's system of record.
2. **Can `specialties` serve as lab departments?** **No — reject it.** `specialties` are the *clinical*
   departments of doctors and services; they drive doctor catalogs, public booking lists and, since
   #13, **department referral targets** (a department with no doctor is refused with
   `department_unavailable`). Lab sections (Blood, Urine, Biochemistry, Hormones…) have no doctors;
   adding them as specialties would pollute those lists and the referral rules. Use a small
   clinic-owned lab category (see §5). This answers "is a separate LabDepartment necessary" — a
   *category* is, a "department" entity is not.
3. **Doctor attribution of clinical records.** `clinical_records` carries `author_doctor_id` and
   `created_by` (login), a composite FK to the author's own appointment with the patient, `version`/
   `root_record_id` lineage, and triggers that make rows append-only; only the same doctor record **and**
   login corrects a record (`20261001000001`). The doctor-record guard `doctors_keep_record_authors()`
   prevents re-linking a doctor with records to another login.
4. **How doctors access longitudinal history.** One decision, `public.doctor_patient_access()` (RLS,
   `SECURITY DEFINER`, service-role-only) mirrored by `canDoctorAccessPatientClinicalData()`
   (`src/lib/clinical-access/access.ts`): a treating relationship (appointment neither cancelled nor
   no-show, or an authored record) or an open referral → `full_history`. Clinical tables have **no
   signed-in SELECT**; reads go through the server which authorizes and audits
   (`clinical_record_viewed`, `unauthorized_clinical_access_attempt`). Lab data must be read the same
   way — and the decision function must not be weakened or forked.
5. **Payments.** `payments` (status enum `unpaid|pending|paid|failed|refunded|manual_review`, provider
   `manual|click|…`), transitions only server-side in `src/lib/payments/status.ts`
   (`LEGAL_TRANSITIONS`, idempotent, audited as `payment_status_changed`); amounts come from the booking
   engine; a browser can never mark paid; only `manual` is production-usable. Consumers that assume
   `appointment_id`: dashboard, analytics, finance page, `me/appointments`, `clinical-access/workspace.ts`
   (doctor sees only the status of their own visit's payment), Click webhook.
6. **Secure files.** Only the `voice-messages` private bucket (service-role access + staff policies in
   `20260813000011`/`17`). No clinical-document storage exists.
7. **Telegram notifications.** `notification_jobs` (atomic claim, retries, `idempotency_key`,
   `enqueueNotificationJob`, `processor.ts`) — appointment/conversation-shaped.
8. **Patient identity resolution.** Patients are not auth users: Telegram Mini App `initData` is verified
   server-side (`src/lib/telegram/init-data.ts`; `resolvePatientFromInitData` in `src/lib/patients/identity.ts`), website bookings are
   unverified and create separate records (`getOrCreateWebPatient`); `patient_created`/`patient_deleted`
   are audited (#13).
9. **Is a lab role needed?** Yes. `staff_role` = `owner, admin, manager, receptionist, doctor`. A
   laboratory technician must enter results and handle samples without any admin, finance or clinical
   history access, which none of these express. Detail and the cost of adding an enum value in §7.
10. **Audit extension.** `audit_events` is append-only, tenant-checked, ids-only by convention
    (`recordAudit`, DB triggers `audit_track_changes`, `referrals_audit`, `clinical_records_audit`).
    New names needed (§9). The generic `audit_track_changes` stores `to_jsonb(row)` — **a lab-result
    table must NOT use it** (it would copy result values into the audit trail).
11. **Reuse list.** Reuse: `patients`, `doctors`, `appointments` (consultation link), `profiles`/
    `staff_roles` + `requireRoles`/`requireLinkedDoctor`, `doctor_patient_access()`, `app_settings`,
    `audit_events`/`recordAudit`, `notification_jobs`, `payments` + `transitionPaymentStatus` (with
    a schema extension, §6), the composite-FK pattern (`unique (id, clinic_id)`, 20260930000006),
    `retention_policies`, admin UI kit (`PageHeader, Card, StatCard, AButton, AInput, ASelect,
    ATextArea, ABadge, ATable, AEmpty, AError, AModal, LoadingRow`), the doctor patient tab layout.
    Reject: `specialties` as lab departments; `clinical_records` as the result store; `services` as
    the lab test catalog (no parameters, sample type or turnaround; bookable-slot semantics).
12. **Components for Lab UI.** The admin UI kit above (`src/components/admin/ui.tsx`); the doctor
    workspace page and `clinical-record-form.tsx`/`record-history.tsx` patterns; the admin
    list/modal pattern (e.g. `src/app/admin/specialties/page.tsx`).
13. **New entities that are actually necessary.** §5.
14. **Spec assumptions incompatible with the code.** §2, plus §8 (two rule conflicts).

## 4. Why lab results cannot live in `clinical_records`

`clinical_records` is *doctor-authored by construction*: `author_doctor_id NOT NULL`, composite FK to the
author's **own consultation with that patient** (`clinical_records_consultation_fkey`), corrections only
by the same doctor+login. A laboratory result is entered by lab staff, often for an order whose ordering
doctor is someone else, and verified by a third person. Forcing it into `clinical_records` would either
fake doctor authorship (a safety and audit violation) or require loosening the author/consultation
constraints that protect every doctor's records. **Lab results need their own table with their own
author model, versioned the same way, readable through the same access decision** (§5, §7).

## 5. Proposed lab architecture (minimum model)

Principles: every clinic-owned row has `clinic_id` and **composite same-clinic FKs** (add
`unique (id, clinic_id)` where a lab table is referenced); no `on delete cascade` into lab data
(retention, as for clinical data); statuses kept separate; no price/amount/status/author accepted from
the client.

| Entity | Needed? | Notes |
| --- | --- | --- |
| `lab_categories` | yes (small) | clinic-configurable sections (Blood, Urine, …); replaces the rejected "LabDepartment" |
| `lab_tests` | yes | code (unique per clinic), name, category, price (authoritative), sample type, preparation text, turnaround, `active`. `active=false` → cannot be newly ordered; history stays |
| `lab_test_parameters` | yes | per test: code, name, unit, `data_type` (numeric/text/choice), display order. **Reference ranges are data, not constants** (`lab_reference_ranges`: parameter, optional sex/age band, low/high, critical low/high — bounds only when the clinic configured them) |
| `lab_panels` + `lab_panel_tests` | yes (thin) | a named set of tests, price either sum or explicit (decide in Phase 2) |
| `lab_orders` | yes | clinic, patient, ordering doctor, consultation (`appointment_id`, composite FK like `clinical_records`), optional referral, priority, notes, **order status** only; `creation_key` for idempotent retries |
| `lab_order_items` | yes | order × test (or panel expansion), **price snapshot at order time**, per-item status |
| `lab_samples` | yes | order item(s), sample type, collected_at/by, **sample status** only; uniqueness to stop duplicate collection |
| `lab_results` | yes | order item, entered_by (profile), **result status**, structured values as rows in `lab_result_values` (parameter, value, unit, **reference range snapshot used**, computed flag normal/low/high/critical — "outside configured reference range", never a disease name) |
| `lab_result_versions` | yes | append-only lineage: a correction is a new version (author = corrector, previous version kept), `version`, `corrects_*`, same discipline as `clinical_record_versions` |
| `lab_result_verifications` | merge into versions | **verification status** is a property of a version (verified_by, verified_at); one verifier per version; separate column set, not a separate table, unless the clinic needs multi-step approval |
| `lab_result_attachments` | yes | document metadata; the bytes live in a new private bucket (§10) |

Rejected as separate things: `LabSample` per parameter (sample is per tube/specimen), a second patient
or doctor table, a second audit table, a second payment table.

The five concepts the spec insists on keeping apart — **order status, payment status, sample status,
result status, verification status** — map to five different columns on four different tables
(`lab_orders`, `payments`, `lab_samples`, `lab_results`, `lab_result_versions`). None may be derived by
trusting another from the client.

## 6. Payments: the one real schema decision

A lab order is not an appointment, but the payment engine is appointment-bound
(`payments.appointment_id NOT NULL UNIQUE`). Options:

* **A. A `lab_order_payments` table** — fastest, but it is a *second payment engine*: it would need its
  own transitions, audit, Click/Payme path, receipts and finance integration. Rejected (the spec forbids
  it, and so does the maintenance cost).
* **B. Make `payments` polymorphic (recommended).** `appointment_id` nullable + `lab_order_id`
  nullable, `check (num_nonnulls(appointment_id, lab_order_id) = 1)`, partial unique index per owner,
  composite same-clinic FK to `lab_orders`. `transitionPaymentStatus`/`LEGAL_TRANSITIONS`/audit stay
  the one engine (it already accepts `paymentId`). **Cost: every consumer that joins
  `payments → appointments` must be reviewed** (dashboard, analytics, finance, `me/appointments`,
  `workspace.ts`, Click webhook, `delete-appointments` test helper) so lab revenue is not silently dropped
  from, or double-counted in, the finance views.
* **C. Create an appointment per lab order** — reuses everything but drags in doctor slots, working
  hours and the overlap constraint, which labs do not have. Rejected.

The amount is read from `lab_order_items.price_snapshot` (server-side, from `lab_tests`/`lab_panels`),
never from the request. Whether payment is required before collection is a clinic policy
(`app_settings` key, validated), not a hard-coded rule; collection checks the policy against the
**authoritative `payments.status`**. Receipts do not exist (§2): Phase 5 either builds a minimal receipt
record on top of `payments` or drops the receipt requirement — decide explicitly.

## 7. Permissions and the lab role

New enum value `lab_staff` on `staff_role` (`alter type … add value` — runs outside a transaction block
in older Postgres; use the same guarded pattern as `20260818000023`). **Cost of adding a role** (all
must be done in Phase 3): the hard-coded role lists in `requireRoles` call sites, `ADMIN_WORKSPACE_ROLES`/
`adminWorkspaceRedirect` (a lab user would otherwise be redirected away or see failing links), the RLS
helpers that take role arrays (`is_clinic_staff(clinic, roles)`), the staff-management UI/API (owner adds
roles), `staff-context` tests. Verification: recommended as a **permission on the result version**
(`verified_by` must hold `lab_staff` and, when the clinic enables a separate verifier, differ from
`entered_by`) rather than a second role, unless the clinic needs one — to be confirmed in Phase 3.

| Actor | Config (tests/prices) | Orders | Samples/results | Verify | Read results | Finance |
| --- | --- | --- | --- | --- | --- | --- |
| owner / admin / manager | edit | read ops | no | no | **no** (operational staff never read clinical text; counts only) | owner/admin per `canViewPaymentDynamics` |
| receptionist | no | collects payment/arrival only | no | no | **no** | payment actions only |
| doctor | read catalog | create (own consultation / authorized patient) | no | no | via `doctor_patient_access()` only | status of own visit's payment only |
| lab_staff | read | read needed fields | enter, collect | if enabled | their worklist only | none |
| patient | — | — | — | — | **blocked until the decision in §8** | — |

Lab result **values are clinical text**: operational roles (owner/manager included) see operational
aggregates (volumes, turnaround, pending counts) but never the values. This follows `AGENTS.md`.

## 8. Two conflicts with `AGENTS.md` the owner must resolve before Phases 8 and 12

1. **Patient access to results (Phase 8).** `AGENTS.md`: *never show clinical text to … patients … or the
   patient-facing bot.* Lab values are clinical text. Options: (a) keep the rule — Telegram says only
   "a result is ready"; the patient receives the result at the clinic or from the doctor; (b) amend the
   rule to allow an authenticated, audited patient view with a release policy (immediate / after doctor
   release / per test type). Either needs the owner's explicit decision and legal review; **no code in
   Phase 8 until then**. A notification without values is possible under (a), but even its existence
   reveals that a test happened — also part of the decision.
2. **AI lab summaries (Phase 12).** `AGENTS.md`: *AI must never write, read, or summarise clinical
   text.* Phase 12 contradicts it. It needs an explicit rule change, a provider/data-handling decision
   (what structured data may leave the system, retention at the provider, consent wording), and the
   deterministic equivalent (trend table, "similar test N days ago") should ship first — it needs no AI.
   The same rule also bars AI from the duplicate-test notice: that notice must be rule-based.

Neither conflict is resolved here. No legal requirement is assumed.

## 9. Audit events (new names, ids only)

`lab_order_created`, `lab_order_cancelled`, `lab_sample_collected`, `lab_result_entered`,
`lab_result_verified`, `lab_result_version_created`, `lab_result_viewed` (workspace read, ids of
results released), `lab_document_viewed`, `lab_import_batch_*`, plus `unauthorized_lab_access_attempt`
(matching `unauthorized_clinical_access_attempt`). **Never** parameter values, units with values, notes
or file names in `old_values`/`new_values`/`metadata`. Lab tables need a purpose-built audit trigger,
not `audit_track_changes`. Add the lab data categories to `retention_data_category` — no retention
period is assumed; the table stays empty until the clinic's confirmed policy.

## 10. Documents

New private bucket (e.g. `lab-documents`), no public URLs, no direct client access: the server verifies
clinic + patient + `doctor_patient_access()` + document↔result relationship, then streams or issues a
very short-lived signed URL; every access audited. Upload validation (type allowlist, size limit, magic-
byte check, malware scan decision), object key not derived from patient data. The retention behaviour of
`voice-messages` (`purged_at`) must **not** be copied: lab documents are part of the clinical record.

## 11. Migration strategy

* Incremental migrations after `20261002000005`, never editing history; each with a documented reversal
  (house convention) and added to `supabase/full-db-setup.sql` (`npm run db:full-setup`; CI fails if stale).
* Order: lab role value (own migration) → catalog tables → orders/items → samples → results/versions/
  verification + triggers + audit → attachments + bucket → payments polymorphism (own migration, with the
  consumer review) → notification job type/link (only if §8.1 allows) → retention categories.
* Every migration rehearsed with `scripts/rehearse-upgrade.sh` on production's last applied version
  (`docs/local-staging.md`); table rewrites (e.g. `payments` constraint changes) timed at volume.
* Tests accompany every migration: RLS matrix, cross-clinic composite-FK refusal, append-only, retention
  `RESTRICT`, role matrix (the existing DB suites are the template: `clinical-access`, `clinical-records`,
  `tenant-integrity`, `role-authorization`).

## 12. Security concerns and risks

1. **Audit trail leakage** via `audit_track_changes` on lab tables (§3.10) — highest-risk easy mistake.
2. **Role addition regressions** (§7): a new staff role touches redirects, guards, RLS role arrays.
3. **Polymorphic payments** can silently change finance numbers (§6).
4. **Result values are clinical text**: logs, error messages, analytics and the notification payload must
   never carry them; analytics must be aggregate-only.
5. **Clinical access**: lab reads must reuse `doctor_patient_access()`; a "convenience" policy that lets
   any doctor of the clinic read results would break the model (same-clinic ≠ relationship).
6. **No identity fields for import matching** (§2) and no merge tool: bulk import before both exist
   produces unmergeable duplicates.
7. **Idempotency/races**: concurrent sample collection, double verification, stale-version correction,
   double order submit — need DB-level guards (unique keys, compare-and-swap), as the booking engine and
   `start_consultation` do; keep the lock order discipline (parent before child, no shared→exclusive
   upgrades).
8. **Reference ranges** applied at entry must be snapshotted on the result; later edits of a range must
   never re-flag historical results.
9. **Retention/erasure**: no cascade deletes from patient/clinic/appointment into lab data; no executor
   exists and none is assumed.
10. **RLS performance**: the existing `patients`/`appointments` policies cost ~1 ms/row for tokens that
    match few rows (measured, logged in `TASKS.md`); lab tables must not copy that policy shape — reads
    are server-mediated, policies are a backstop.
11. **External lab / PDF text** is untrusted input (prompt-injection and parser attacks) even before AI.

## 13. Unresolved questions (need an owner decision)

1. Base branch: build on #13 (recommended) or wait for #10/#13 to merge? (§1)
2. Payments: polymorphic `payments` (B) — accept the finance-consumer review cost? Receipts: build a
   minimal one or defer? (§6)
3. Patient access to results and the Telegram notification (§8.1).
4. AI summaries: allowed at all, with which data and provider? (§8.2)
5. Which identifiers may be stored for import matching (passport/PINFL/DOB), under what protection and
   retention? (§2)
6. Separate verifier role/permission or a per-clinic "verification on/off" setting only? (§7)
7. Does the clinic's lab sit inside the clinic (shared patients — assumed here) or is it an external lab
   that only sends results? (changes Phases 5, 10)
8. Reference-range scope: sex/age bands needed at launch? (patients have no date of birth/sex column)
9. Which language(s) for test names/units (existing UI is Uzbek; catalog translations?).

## 14. Recommended sequence for the remaining phases (adjusted from the spec)

| Order | Phase | Adjustment |
| --- | --- | --- |
| 0 | decisions §13 (1–5 at least) + merge/rehearse #13 | prerequisite, not a Lab phase |
| 1 | **2 — domain + DB** | catalog/orders/samples/results/versions/attachments; **no payments change yet**; own audit trigger; composite FKs; retention `RESTRICT` |
| 2 | **3 — role + configuration** | `lab_staff` migration + all guard/redirect/RLS role-array updates first; then config UI on `app_settings` + catalog tables |
| 3 | **4 — doctor ordering** | after 2–3; duplicate notice is rule-based (no AI) |
| 4 | **6 — result entry, verification, versioning** *(pulled before 5)* | labs can operate with "payment outside the system" while the payments decision is open |
| 5 | **7 — longitudinal view + documents** | server-mediated reads via `doctor_patient_access()`; new private bucket |
| 6 | **5 — Kassa/payments + sample collection** *(moved later)* | needs decision §6; polymorphic `payments` migration with the consumer review and finance regression tests; sample collection can ship earlier, payment-gating later |
| 7 | **11 — operational dashboards** (aggregate-only) | after payments are authoritative for lab |
| 8 | **9 — merge tool, then import** | merge first; identifier columns only after §13.5 |
| 9 | **10 — external adapter + mock provider** | only against verified documentation; never assume MedPlus has an API |
| 10 | **8 — patient delivery** | **only after §8.1 is decided** |
| 11 | **12 — AI assistance** | **only after §8.2 is decided and `AGENTS.md` is changed by the owner** |
| 12 | **13 — adversarial review**, **14 — E2E + readiness** | as specified; run the review after every two phases, not only at the end |

## 15. What was and was not verified

* Read: all migrations by name; the schema files listed in §3; `src/lib` modules for payments,
  notifications, clinical access/records, auth, AI/safety, telegram init-data; the doctor workspace and
  admin page lists; `database.types.ts` for `patients`.
* **Not run:** tests, typecheck, lint, build (`node_modules` is not installed in this worktree and this
  phase changes no code). The migration/RLS statements above are from reading the SQL, not from executing
  it in this session (they were executed in the earlier PR #13 staging rehearsal, which this audit relies on).
* **Not verified:** the live production schema beyond its migration list; anything about MedPlus or any
  external laboratory (no documentation was available — none is assumed).
* No legal or compliance claim is made; retention periods, patient-access rules and AI data handling are
  decisions for the owner and counsel (§8, §13).
