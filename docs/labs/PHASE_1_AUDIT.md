# Laboratory module — Phase 1 audit

Status: **audit only** (no tables, migrations, APIs or UI were created or changed). Date: 2026-10-01.
Audited tree: branch `claude/labs-phase1-audit`, cut from `claude/longitudinal-on-retention`
(draft PR #13 — the longitudinal access model, independent retention, patient audit, phone rules).
**Every lab phase depends on PR #13 being reviewed and merged first**; the audit below describes that
tree, not `main` or production (production's last applied migration is `20260930000006`).

Method: read the migrations (55), `src/lib/**`, the doctor workspace, admin pages, notification and
Telegram code, the AI/safety modules and the tests; queried the local database (`supabase db reset`
state) for the real schema. Nothing was run against production. **Not verified:** any external lab or
MedPlus capability (none is assumed), legal/retention requirements (none assumed), real clinic data.

## 1. What the lab specification assumes vs. what exists

The global instructions say Health AI "already has" a list of systems. Reality, system by system:

| Assumed | Reality in the repo | Consequence |
| --- | --- | --- |
| Multi-tenant clinics | Yes. `clinic_id` everywhere, composite `(id, clinic_id)` FKs, tenant integrity tests | reuse as is |
| Clinic configuration | **Partial.** `clinics` has name/timezone/phone/address/currency/opening_hours/privacy_notice; `app_settings(clinic_id, key, value jsonb)` holds two keys (`reminder_hours`, `booking_notes`). No typed configuration system | lab settings can use `app_settings` but need typed validation (§4, C5) |
| Patients | Yes. **No date of birth, sex, passport or PINFL columns** — only name, phone (+ `phone_normalized`), Telegram identity, language, consent, notes, `created_by/via` | age/sex-specific reference ranges and Phase 9 matching by passport/PINFL/DOB are impossible today (C10) |
| Doctors, specialties | Yes. `specialties` already is the department concept (used by referrals, services, doctors) | **do not create `LabDepartment`** |
| Appointments + booking engine | Yes (`book_appointment`, overlap exclusion, statuses `pending…no_show`) | lab orders are not appointments |
| "Kassa"/payments | **Partial.** `payments` is **1:1 with an appointment** (`UNIQUE(appointment_id)`), statuses `unpaid/pending/paid/failed/refunded/manual_review`, providers `manual/click/payme/cash/card_terminal`; only `manual` is production-usable; a finance cash-flow page exists. **No receipts, no cash drawer/shift, no payment without an appointment** | a lab order cannot own a payment today (C4); "reuse the receipt architecture" is impossible — it does not exist |
| Queue | **Does not exist** (no queue table, no ticket numbers) | out of lab scope; do not assume |
| Referrals | Yes (doctor/department, longitudinal) | lab order may reference a referral |
| Longitudinal history | Yes: `public.doctor_patient_access()` ⇄ `canDoctorAccessPatientClinicalData()`; full history for a treating relationship or an open referral | must not be weakened |
| Doctor-owned clinical records | Yes: `clinical_records` (`author_doctor_id NOT NULL`, append-only versions), **types already include `lab_order` and `lab_result`** as free text (`summary`, `details`, `code`) written by a doctor | coexistence/conflict (C1, C13) |
| RBAC | Yes, but roles are `owner, manager, admin, receptionist, doctor`; **no lab role** | add a role or reuse (C7) |
| RLS | Yes (39 policies); clinical tables have **no signed-in SELECT**, reads go through the server and are audited | lab tables follow the same pattern |
| Audit events | Yes: `audit_events` append-only, tenant-checked, `recordAudit()` + triggers; ids/metadata only, never clinical text | extend with lab events |
| Telegram / Mini App | Yes (`src/lib/telegram`, Mini App routes `book`, `booking`, `help`, `my-appointments`, `privacy`) | patient identity = verified Telegram `initData` or phone-keyed records |
| Notifications | Yes: `notification_jobs` (atomic claim, retries, `idempotency_key`), types `booking_confirmation, reminder_24h, reminder_2h, cancellation, reschedule, human_takeover`; `appointment_id`/`conversation_id` nullable | needs a new job type + generic entity reference; templates must hold no clinical text (C8) |
| Secure file storage | **Partial.** One private bucket `voice-messages` (service role + staff read policy). No clinical-document storage | a lab-documents bucket must be designed (C9) |
| AI infrastructure | `src/lib/ai` (receptionist, knowledge, navigation, provider), `src/lib/safety/policy.ts` | **and an enforced guard test** `src/lib/ai/clinical-isolation.test.ts` (C2, C3) |

## 2. Answers to the 14 audit questions

1. **Lab entities already present?** No lab tables. Only `clinical_record_type` values `lab_order`, `lab_result`
   (doctor-written free text, optional `code`), the doctor workspace category *Tahlilga yo‘llanma / Tahlil natijasi*
   (`src/lib/clinical-records/categories.ts`) and the *Laboratoriya* tab.
2. **Can `specialties` be reused as departments?** Yes (clinic-scoped, `active`, already the department of
   referrals and services). Reject a separate `LabDepartment`; give `lab_tests` an optional `specialty_id` and a
   small category value.
3. **Is a separate `LabDepartment` necessary?** No.
4. **Clinical-record attribution:** `author_doctor_id` (doctor record) + `created_by` (login) + consultation
   (`appointment_id`), version/`root_record_id`, only the same doctor and login corrects. **A lab technician cannot be the
   author of a `clinical_records` row** (C1).
5. **Doctor access to longitudinal history:** only through `doctor_patient_access()`; treating relationship (appointment
   neither cancelled nor no-show, or authored record) or open referral. Lab data must use the same function.
6. **Payments ↔ appointments/services:** payment row per appointment (unique), amount from the service price, server-set
   status, `manual` provider only in production. No per-order payment.
7. **Secure files:** `voice-messages` private bucket only; deleted by a retention job (`purged_at`). No document model.
8. **Telegram notifications:** `notification_jobs` → processor claims atomically (`claim_due_notification_jobs`), sends,
   records `telegram_message_id`; templates in `src/lib/notifications`; patient needs `telegram_user_id`.
9. **Patient identity:** verified Telegram `initData` (`resolvePatientFromInitData`) or reception-registered patient;
   one record per patient (`phone_normalized` lookup, 409 `possible_duplicate`). **No merge tool yet.**
10. **Lab-specific role?** Yes, if lab staff must enter/verify results: nothing existing fits (C7, C11).
11. **Audit extension:** add `lab_order_created`, `lab_sample_collected`, `lab_result_entered`, `lab_result_verified`,
    `lab_result_corrected`, `lab_result_viewed` (ids/status only) following the clinical naming (`clinical_record_viewed`).
12. **Reusable:** clinics, patients (+ `phone` rules), doctors, specialties, referrals, `doctor_patient_access`, `staff_roles`
    + guards (`requireRoles`, `requireLinkedDoctor`), `audit_events`/`recordAudit`, `notification_jobs` + processor,
    Telegram identity, doctor workspace tabs, admin UI kit, fixture cleanup helpers, local-staging scripts.
13. **Genuinely new:** lab catalog (tests, parameters, ranges, panels), orders + items, samples, results + values +
    versions, result documents (+ storage), lab role, per-order payment link, a generic notification reference, lab config.
14. **Assumptions incompatible with the codebase:** see §4 (C1–C12) — chiefly: lab staff as result authors, results
    delivered to patients/AI, per-order payment + receipts, patient identity fields that do not exist, a clinic configuration
    system that is only key/value, and a lab-documents store.

## 3. Proposed laboratory architecture (for approval — nothing built)

Minimum entity set (every row `clinic_id`-scoped; every cross-entity FK composite `(id, clinic_id)`; every parent FK
`ON DELETE RESTRICT`; no cascading deletes into retained domains):

- **Configuration:** `lab_tests` (code, name, specialty_id?, category, sample type, price, turnaround, preparation, active),
  `lab_test_parameters` (code, name, unit, data type, display order, **configurable** reference bounds and critical
  thresholds; ranges possibly versioned per parameter, age/sex banding only once patients carry those fields),
  `lab_panels` + `lab_panel_tests`.
- **Workflow:** `lab_orders` (patient, ordering doctor, appointment/consultation, optional referral, priority, notes,
  `order_status`, `idempotency_key`), `lab_order_items` (order, test, **price snapshot** set by the server),
  `lab_samples` (item, sample id, type, collected_at/by, `sample_status`).
- **Results:** `lab_results` (item, `result_status`, entered_by, verified_by/at, versioning like `clinical_records`:
  `version`, `root_result_id`, `corrects_result_id`, append-only) + `lab_result_values` (parameter, value, unit,
  **the reference range/thresholds used at evaluation time**, flag normal/low/high/critical — computed server-side,
  descriptive only) + `lab_result_documents` (private storage reference).
- **Status separation:** `order_status`, `sample_status`, `result_status`, verification (fields on the result) and
  **payment status stays on `payments`** — never merged into one field.
- **Rejected as duplicates:** `LabDepartment`, a lab patient/doctor table, a lab payment engine, a lab history table
  outside the longitudinal model, a lab notification or audit system, a separate storage system.
- **Access:** lab tables have **no signed-in SELECT** (like `clinical_records`); all reads/writes go through the server,
  authorized per role, audited. Doctors reach results only through `doctor_patient_access()` (RLS backstop + server
  mirror); a doctor never writes another's result; a doctor's own interpretation is their own `clinical_records` row.
  Catalog/config tables may be readable by staff of the clinic.

Proposed permission matrix (to confirm in Phase 3): owner/manager — configure catalog, prices, workflow, lab analytics;
admin — as today; **lab** (new) — see orders to process, collect samples, enter results, verify only if the clinic
workflow enables a separate verifier; **doctor** — search tests, order for patients they may access, read results via
`doctor_patient_access()`; **receptionist** — payment/booking steps only, **no results**.

## 4. Conflicts and decisions — NOT silently resolved

**C1 — Lab-staff-entered results vs the doctor-authorship rule.** `AGENTS.md`: clinical text exists only where a doctor
writes it; `clinical_records.author_doctor_id` is NOT NULL. Lab values entered by a technician or imported from a lab
are structured clinical data with a non-doctor author. Options: (a) a separate lab domain with `entered_by`/`verified_by`
profiles and an explicit `AGENTS.md` amendment ("structured lab results may be authored by lab staff or a lab system;
readable only through `doctor_patient_access()`; never by operational staff"); (b) force lab results into
`clinical_records` under a doctor — **rejected** (false authorship). Recommendation: (a). **Needs the owner's decision
and exact rule wording before Phase 2.**

**C2 — Results to patients via Telegram vs rule + enforced test.** `AGENTS.md`: never show clinical text to patients or
the patient-facing bot; `src/lib/ai/clinical-isolation.test.ts` fails if Telegram/notification/Mini App code references
clinical modules. Phase 8's example message also names the test and date. Needs: a decision on patient access to their
own results (release policy: immediate / doctor-released), an authenticated Mini App view (verified `initData`), a message
that says only "a result is ready", and a deliberate, reviewed change to the rule and the guard test. **Blocks Phase 8.**

**C3 — AI summarization vs rule + enforced test.** `AGENTS.md`: AI never reads/writes/summarises clinical text; the same
guard test covers `src/lib/ai`. Phase 12 requires a recorded decision (what structured data may leave the system, which
provider/region, consent, audit, doctor-only display, no recommendations), legal/compliance review (nothing assumed here)
and a rule change by the owner. The lab workflow must work fully without it. **Blocks Phase 12.**

**C4 — Payment per lab order does not exist.** `payments.appointment_id NOT NULL UNIQUE`. Options: (a) relax to
`appointment_id` XOR `lab_order_id`, unique per order, same server-only write path (needs a migration safety analysis:
constraints, the direct-write guard, finance analytics that assume appointments); (b) one synthetic appointment per
order — **rejected** (corrupts scheduling/analytics). Recommendation: (a). **Receipts do not exist** and the clinic
"payment before sample" policy is not configurable today: both must be built first (receipts → config key in `app_settings`).

**C5 — "Clinic configuration" is key/value.** Lab settings (payment-before-collection, verification workflow on/off,
verifier role) can live in `app_settings` but need a typed, validated, audited schema; do not invent a parallel settings system.

**C6 — Test catalog vs `services`.** `services` carry price/duration/preparation and drive the booking engine. Lab tests
need parameters, sample types, panels and turnaround and are not bookable slots. Recommendation: a separate `lab_tests`
(single source of truth for the order price); do not overload `services`. An optional link for reporting can be added later.

**C7 — No lab role; enum change has reach.** `staff_role` is a Postgres enum used by RLS helpers, `requireRoles`, the
admin shell and management-role sets. Adding `lab` is a deliberate change with tests across guards/RLS; decide whether a
single `lab` role covers entry+verification (verification as a clinic-configurable separation of duties).

**C8 — Notification model.** `notification_jobs.type` is an enum and rows reference an appointment or conversation. A
result/doctor notification needs a new type and a generic entity reference; message templates must be provably free of
clinical text (add a test that fails when a template can carry a value or test name unless C2 allows it).

**C9 — No clinical document storage.** Only the private `voice-messages` bucket. Lab documents need a new private bucket,
path `clinic/patient/result`, no public URLs, short-lived signed URLs issued only after server authorization and audited,
size/type validation and malware/format checks; retention is **unknown** (no period assumed; `retention_policies` empty).

**C10 — Patient identity fields are missing.** Without date of birth, sex, passport/PINFL: no age/sex reference ranges and no
reliable Phase 9 matching. Collecting these is a privacy decision (new personal data, consent wording, legal review) and a
schema change to `patients`; until then matching can only use internal id, phone and name, and ranges are per-parameter.

**C11 — Lab staff vs "operational staff never see clinical text".** A lab role necessarily sees patient name and the tests
ordered/results. Decide explicitly whether lab staff are a clinical-adjacent role with their own narrow read path (orders
and results of their clinic, nothing from `clinical_records`, referrals, payments, conversations) and write that into the
rules; do not let the role inherit management or reception reads.

**C12 — Retention and tests.** All lab tables must be `ON DELETE RESTRICT`, appear in `FIXTURE_RETENTION_TABLES`
(`src/test/cleanup-clinics.ts`) and in a retention-category decision (no period assumed). The upgrade rehearsal
(`scripts/rehearse-upgrade.sh`) must be extended with lab volume before the production gate.

**C13 — Existing `lab_order`/`lab_result` records.** Doctors already type these as `clinical_records` and the *Laboratoriya*
tab shows them. They stay valid and readable. Decide whether new orders replace the doctor-typed `lab_order` (recommended:
yes, the structured order is the order; `lab_order` text remains for historical records) and how the tab merges both sources.

**C14 — Phase order has hidden prerequisites.** Phase 4 "recent comparable test" needs a stable test code (free-text
`code` today); Phase 5 needs receipts + per-order payments; Phase 8 needs C2; Phase 9 needs the patient merge tool and C10;
Phase 12 needs C3.

## 5. Security concerns to design for

Server-derived `clinic_id`/doctor/actor and server-set price/status everywhere; idempotent order creation; concurrency
(two collectors, double verification, stale-version correction — compare-and-set with lock order order → item → sample →
result); abnormal/critical flags are descriptive ("outside configured reference range"), never a diagnosis; audit rows hold
ids and statuses only (no values); file upload attack surface (type, size, polyglot files, formula injection in CSV/Excel);
signed-URL scope and expiry; prompt injection through imported text if AI is ever added; provider callbacks authenticated
per clinic and idempotent; cross-clinic composite FKs on every new table; the lab role must not reach payments, referrals,
clinical records or conversations; no clinical text in logs, analytics, notifications, the bot or screens.

## 6. Migration strategy

Incremental migrations after `20261002000005` (never edit applied ones): catalog → orders/items → samples → results/values/
versions → documents → role/policies → payment link. Each with a reversal header, composite same-clinic FKs, RESTRICT,
audit triggers, RLS (no signed-in SELECT on workflow/result tables), service-only functions with fixed `search_path` and minimal
grants, hand-maintained `database.types.ts`. Prove each on a fresh DB, then with `scripts/rehearse-upgrade.sh` at volume
against production's last applied migration, before any production step. The one risky existing-table change is
`payments` (C4) and the `staff_role` enum (C7): analyze locks and dependants first.

## 7. Risks

Rule conflicts (C1–C3) shipped by accident; false authorship; patient-facing leakage of clinical data; per-order payment
corrupting finance analytics; an enum change breaking guards; documents without a retention decision; patient identity
data collected without a privacy basis; import duplicates without a merge tool; scope creep (queue, receipts and Kassa are
separate products the lab prompts silently assume).

## 8. Unresolved questions (owner decisions)

1. C1: structured lab results authored by lab staff/lab systems — approve the rule amendment and wording?
2. C2: may patients see their own results (and under which release policy)? If yes: the Telegram wording and the guard-test change.
3. C3: is AI allowed to read structured lab data at all, and under what controls? (Lab module ships without AI regardless.)
4. C4: per-order payments by relaxing `payments.appointment_id` — approved? Who builds receipts first?
5. C7/C11: a single `lab` role with its narrow read path, and is a separate verifier required by clinic policy?
6. C10: do we collect date of birth / sex / passport / PINFL, with what consent and legal review?
7. C9: retention for lab documents and results (no period is assumed anywhere).
8. Which lab/LIS do the first clinics actually use, and is there a documented API (nothing about MedPlus is assumed)?

## 9. Recommended sequence (revised)

0. **Merge PR #13** (access model, retention, patient audit) and its production gate; branch labs from the result.
0b. **Decision record** answering §8 (rule wording drafted for approval; no `AGENTS.md` edit without the owner).
1. **Prerequisites that the lab prompts assume but the repo lacks:** receipts, per-order payment link (C4), generic notification
   reference (C8), private lab-documents bucket design (C9), clinic-config typing for lab settings (C5).
2. Phase 2 domain + DB (after C1/C7/C11 decided) → Phase 3 RBAC + configuration → Phase 4 ordering + advisory duplicate notice
   → Phase 5 payment + samples → Phase 6 results/verification/versioning → Phase 7 longitudinal view + documents.
3. Phase 9 only after the **patient merge tool** exists (and C10 decided); Phase 10 adapter with a mock provider first.
4. Phase 8 (patients) only after C2; Phase 12 (AI) only after C3; Phase 11 analytics once payment data is authoritative.
5. Phase 13 adversarial review and Phase 14 E2E/production gate last, including the volume upgrade rehearsal.

## Definition of Done (Phase 1)

- [x] Existing architecture audited
- [x] Existing lab functionality identified (doctor-typed `lab_order`/`lab_result` records only)
- [x] Duplicate entities identified and rejected
- [x] Proposed lab architecture documented
- [x] Risks documented
- [x] Implementation dependencies documented
- [ ] Owner decisions §8 (required before Phase 2)
