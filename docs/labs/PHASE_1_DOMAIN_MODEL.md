# Laboratory Module — Phase 1 Domain Model

Status: **design only** — no migrations or code in this phase. Builds on
`docs/labs/PHASE_0_AUDIT.md` and the owner decisions recorded there
(2026-10-05). Phase 2 implements this model; anything marked **Open** must be
settled before the affected table is migrated.

Deferred, not modelled: critical-result alerts (critical bounds may be
*configured and displayed*, but nothing alerts or escalates on them).

---

## 1. Principles

1. **Extend, don't duplicate.** Patients, doctors, staff, clinics,
   appointments (consultations), payments, notification jobs, audit events and
   Telegram identity are reused. No lab department, patient, doctor or payment
   engine is created.
2. **Separate lifecycles.** Order, order item (work position), sample, result
   (verification) and payment each have their own status; none is inferred
   from another column.
3. **Configuration is data.** Tests, parameters, units, reference ranges,
   prices, verification mode and payment policy are per-clinic rows/settings.
   No clinical interpretation is hard-coded; the app only reports a value's
   position relative to the *configured* range.
4. **Snapshots at the moment of truth.** An order item freezes the test name,
   code and price when ordered; a result value freezes the unit and the
   reference range used. Later catalog edits never rewrite history.
5. **Immutable history.** Verified results are never updated; corrections are
   new versions linked to the previous one.
6. **Minimum necessary access by role and purpose** (AGENTS.md): lab result
   tables are server-only; catalog and order/status data are readable by clinic
   staff; result values only by lab staff, authorized doctors and — once
   verified — the patient.
7. **Tenant integrity by construction.** Every table carries `clinic_id`; every
   reference is a composite FK `(x_id, clinic_id)` (plus `patient_id` where a
   row must belong to the same patient), following
   `20260930000006_tenant_integrity_hardening.sql`.

Enum convention (inspected): lifecycle/type fields are Postgres enums; new enum
values are added in a migration of their own (see
`20260928000001_clinical_handoff_types.sql`). Free-form configuration
(sample type, unit, method) is `text` with CHECK constraints so clinics are not
limited to a fixed vocabulary.

---

## 2. Changes to existing entities

### 2.1 `patients` — identity for lab work

| Column | Type | Rule |
|---|---|---|
| `date_of_birth` | `date` null | `<= current_date`, `>= 1900-01-01`. Required by the server before a lab order is created for the patient (not a DB NOT NULL — existing rows have none). |
| `sex` | `patient_sex` enum (`female`, `male`) **null** | Null means unknown/not recorded. Never defaulted or guessed. Used only for reference-range selection. |
| `document_number` | `text` null | Passport/ID card number, normalised upper-case, `^[A-Z0-9]{5,20}$`. |
| `pinfl` | `text` null | `^[0-9]{14}$`. Partial unique `(clinic_id, pinfl) where pinfl is not null`. |

**Open (O1):** whether `document_number` should also be unique per clinic.
Existing duplicate patients (no merge tool yet, Phase 14) could make a unique
index fail on rollout; Phase 2 adds a pre-flight check and only then the index.

### 2.2 `staff_role` — new value `lab`

- One new enum value `lab` ("Laboratoriya xodimi"), in its own migration.
- Weight in `ROLE_WEIGHT` is **0** (same as receptionist) so weight-based
  `requireStaff()` can never admit lab staff to admin or doctor surfaces. Lab
  routes use exact `requireRoles(...)`.
- `staff_roles` stays one role per person per clinic. Verification by a doctor
  does not need a second role (doctors may verify, §5.4).

### 2.3 `payments` — generalised subject (no second engine)

- `appointment_id` becomes nullable; add `lab_order_id uuid null`.
- `check (num_nonnulls(appointment_id, lab_order_id) = 1)`.
- Unique `(lab_order_id) where lab_order_id is not null`; composite FK
  `(lab_order_id, clinic_id, patient_id) → lab_orders (id, clinic_id, patient_id)`.
- Amount = sum of the order's non-cancelled item `price_snapshot`s, computed
  in the database when the payment row is created; never from the browser.
- Status machine, providers, `payments_block_direct_write`, audit trigger and
  `transitionPaymentStatus()` are reused unchanged.

### 2.4 `notification_jobs`

- New `notification_job_type` value `lab_result_ready` (own migration).
- Add `lab_order_id uuid null` with composite FK; check that a job has an
  appointment **or** a lab order. Processor gains a lab branch with a
  content-free template ("Laboratoriya natijangiz tayyor"). Built in Phase 16;
  the column/enum are added in Phase 2 so the schema is complete.

### 2.5 `app_settings` — lab configuration key `lab`

```json
{
  "verification_mode": "single_step" | "two_step",
  "payment_policy":    "before_collection" | "not_required",
  "release_to_patient": true
}
```

Validated server-side (zod) like the existing settings route. Defaults when
absent: `two_step`, `not_required`, `true`.

---

## 3. New entities

All tables: `clinic_id uuid not null references clinics on delete cascade`,
`created_at timestamptz default now()` (DB clock), RLS enabled, unique
`(id, clinic_id)` for composite FKs.

### 3.1 Configuration (catalog)

| Entity | Purpose | Key columns | Constraints |
|---|---|---|---|
| `lab_test_categories` | Clinic-defined grouping ("Qon tahlili", "Bioximiya"). Replaces the idea of a LabDepartment; **not** `specialties` (public catalog + AI navigation exposure, audit Q2). | `name`, `sort_order`, `active` | unique `(clinic_id, name)` |
| `lab_tests` | One orderable test. | `category_id` null, `code`, `name`, `sample_type` text, `preparation_text`, `turnaround_hours` int, `price numeric(12,2) >= 0`, `active`, `updated_at` | unique `(clinic_id, code)`, unique `(clinic_id, name)`; `code ~ '^[A-Za-z0-9._-]{1,32}$'` |
| `lab_test_parameters` | A measured field of a test (CBC → Hemoglobin, WBC…). A single-value test has one parameter. | `test_id`, `code`, `name`, `value_type lab_value_type`, `unit` text null, `decimals` smallint null, `choices` text[] null, `sort_order`, `active` | unique `(test_id, code)`; `choices` required iff `value_type = 'choice'`; `unit/decimals` only for numeric |
| `lab_reference_ranges` | Configurable normal (and optional critical) bounds per parameter and population. | `parameter_id`, `sex patient_sex` null (=any), `age_min_days` int null, `age_max_days` int null, `low`, `high`, `critical_low`, `critical_high` numeric null, `normal_text` null (expected value for text/choice/boolean), `method_label` text null, `active` | `low <= high`; `critical_low <= low`, `critical_high >= high` when set; age bounds ordered; at least one bound or `normal_text` |
| `lab_panels` | A named group of tests ordered together, with its own price. | `code`, `name`, `price numeric(12,2) >= 0`, `active` | unique `(clinic_id, code)` |
| `lab_panel_tests` | Panel membership. | `panel_id`, `test_id`, `sort_order` | PK `(panel_id, test_id)`; composite FKs with `clinic_id` |

`lab_value_type` = `numeric`, `text`, `boolean`, `choice`.

Range selection (server): among active ranges of the parameter, pick the most
specific one matching the patient's sex (or `null`) and age at **collection
time** (else order time). If the patient's sex is unknown, only `sex is null`
ranges apply; if DOB is unknown, only ranges without age bounds apply. If
nothing matches, the value is stored with flag `not_evaluated` — never guessed.
Overlapping active ranges for the same parameter/sex/age are rejected by a
validation trigger in Phase 4.

Catalog rows are never deleted once referenced; they are deactivated.
Inactive tests/panels cannot be newly ordered (server + trigger check);
history keeps working because items hold snapshots.

### 3.2 Ordering

**`lab_orders`** — one request for one patient.

| Column | Notes |
|---|---|
| `patient_id` | composite FK `(patient_id, clinic_id) → patients` |
| `source lab_order_source` | `consultation`, `walk_in`, `external_import` |
| `ordered_by uuid → profiles` | the staff member (any clinic role) — set by the server from the session |
| `ordering_doctor_id` null | set when the orderer is a linked doctor; composite FK to `doctors` |
| `appointment_id` null | consultation the order came from; composite FK `(appointment_id, clinic_id, patient_id) → appointments`. Required when `source = 'consultation'`. |
| `status lab_order_status` | `active`, `completed`, `cancelled` |
| `cancelled_at/by`, `cancel_reason` | reason ≤ 300 chars, operational wording only |
| `external_reference` null | provider/import id; unique `(clinic_id, source, external_reference)` |
| `creation_key uuid` null | idempotency: unique `(clinic_id, ordered_by, creation_key)` |
| `updated_at` | |

**`lab_order_items`** — one test in an order; the unit of lab work.

| Column | Notes |
|---|---|
| `order_id`, `patient_id` | composite FK `(order_id, clinic_id, patient_id) → lab_orders` |
| `test_id` | composite FK to `lab_tests` |
| `panel_id` null | the panel it was ordered through |
| `test_code_snapshot`, `test_name_snapshot`, `price_snapshot` | frozen at order time; panel items carry the panel price split rule chosen in Phase 5 (**Open O2**: allocate panel price to the first item vs. proportional) |
| `status lab_item_status` | see §4 |
| unique | `(order_id, test_id)` — a test once per order |

Ordering authorization (decision 2): any authenticated staff member of the
clinic, any active test. Server derives clinic, patient and orderer; validates
patient belongs to clinic and has a DOB; resolves prices from the catalog.

Recent-similar-test warning (Phase 5): server returns `test name + date` of
the patient's earlier items for the same test within a window; for orderers
without result access it never includes values.

### 3.3 Samples

**`lab_samples`** — a physical specimen.

| Column | Notes |
|---|---|
| `patient_id`, `order_id` | composite FK `(order_id, clinic_id, patient_id)` |
| `sample_code` | human/barcode id, unique `(clinic_id, sample_code)`, generated server-side |
| `sample_type` | from the tests it serves |
| `status lab_sample_status` | `collected`, `received`, `rejected` |
| `collected_at`, `collected_by` | DB clock / session |
| `rejected_at/by`, `reject_reason` | operational wording only |
| `notes` | ≤ 500 chars, operational only |

**`lab_sample_items`** — which order items a specimen serves (one tube can
serve several tests). PK `(sample_id, order_item_id)`, composite FKs, and a
trigger guaranteeing an order item has **at most one non-rejected sample** and
that the sample and item share order and patient.

### 3.4 Results, versions and verification

**`lab_results`** — one result version for one order item.

| Column | Notes |
|---|---|
| `order_item_id`, `patient_id` | composite FK `(order_item_id, clinic_id, patient_id)` |
| `version int` | 1, 2, … unique `(order_item_id, version)` |
| `supersedes_result_id` null | previous version; same item; unique where not null |
| `status lab_result_status` | `draft`, `submitted`, `verified`, `superseded` |
| `source lab_result_source` | `manual`, `import`, `external` |
| `entered_by`, `entered_at` | lab staff/doctor/importer; DB clock |
| `submitted_at/by` | |
| `verified_by`, `verified_at` | |
| `correction_reason` | required when `version > 1`, ≤ 300 chars |
| `lab_comment` | ≤ 1000 chars, lab-technical remark (lab data, not a doctor note) |
| `performed_at` | when the test was run; for imports the historical date |
| index | unique `(order_item_id) where status <> 'superseded'` — one current version |

**`lab_result_values`** — one parameter value of a result version.

| Column | Notes |
|---|---|
| `result_id`, `parameter_id` | unique `(result_id, parameter_id)` |
| `value_numeric` / `value_text` / `value_boolean` | exactly one, matching the parameter's `value_type` (choice values stored in `value_text`, must be in `choices`) |
| `unit_snapshot`, `range_low`, `range_high`, `range_text`, `critical_low`, `critical_high`, `reference_range_id` null | frozen range used |
| `flag lab_value_flag` | `normal`, `low`, `high`, `critical_low`, `critical_high`, `abnormal`, `not_evaluated` — computed by the server/trigger from the snapshot, never from the browser |

Mutability: values and the result row may change only while `draft`;
`submitted` → only verification fields; `verified` → frozen except the single
transition to `superseded` when a correction is verified (trigger-enforced,
like `clinical_records_validate()`).

### 3.5 Documents

**`lab_documents`** — file metadata; bytes live in a new private bucket
`lab-documents`, path `<clinic_id>/<lab_document_id>`.

Columns: `patient_id`, `order_id`, `result_id` null, `kind` (`report`,
`scan`, `image`, `import_source`), `mime_type` (allow-list), `size_bytes`
(limit set in Phase 11), `sha256`, `uploaded_by`, `withdrawn_at/by`,
`withdraw_reason`. Documents are never deleted through the app; a mistaken
upload is *withdrawn* (hidden from patient/doctor views, kept for audit).
Delivery only via server-issued short-lived signed URLs after authorization.

---

## 4. Lifecycles

```
ORDER (lab_orders.status)
  active ──► completed      (all items verified or cancelled, ≥1 verified)
     └────► cancelled       (only while no item is collected)

ITEM (lab_order_items.status) — the lab work position
  ordered ──► ready_for_collection ──► collected ──► processing ──► resulted ──► verified
     │              │                      │              │
     └──────────────┴──────────────────────┴──────────────┴──► cancelled
  ready_for_collection: entered automatically when the clinic payment policy
  is satisfied (payment_policy = not_required ⇒ immediately).
  A rejected sample returns the item to ready_for_collection.

SAMPLE (lab_samples.status)
  collected ──► received ──► (consumed by processing)
      └──────────┴──► rejected

RESULT VERSION (lab_results.status)
  draft ──► submitted ──► verified ──► superseded (only by a verified correction)
    single_step mode: submit and verify happen in one server action by the enterer
    two_step mode:    verifier ≠ enterer

PAYMENT (payments.status, existing machine, subject = lab_order)
  unpaid ──► pending ──► paid ──► refunded
                  └──► failed / manual_review
```

Correction: a new version (`draft`, `supersedes_result_id` = current verified
version, reason required). When it is verified, the previous version becomes
`superseded` in the same transaction. Readers always see the current version
plus the version history.

"Result ready" = item `verified` (and `release_to_patient` true for the
patient view). There is no separate `RESULT_READY` state.

Transitions are compare-and-swap in server-only SQL functions (pattern:
`start_consultation`), so two concurrent verifiers/collectors cannot both win.

---

## 5. Access model (RLS + server)

| Data | Owner/Manager/Admin | Receptionist | Lab | Doctor | Patient | AI |
|---|---|---|---|---|---|---|
| Catalog (tests, params, ranges, panels, prices) | read + configure (owner/admin/manager) | read | read | read | test names/prices/prep text via public catalog only if the clinic lists them (Phase 12) | — |
| Create order | ✓ | ✓ | ✓ | ✓ | — | — |
| Order/item/sample **status** | ✓ | ✓ | ✓ | ✓ (patients they can access + own orders) | own, via server | — |
| Samples (collect/reject) | — | — | ✓ | — | — | — |
| Result values (enter) | — | — | ✓ | ✓ (own orders) | — | — |
| Result values (read) | — | — | ✓ (lab work queue) | §5.3 | own **verified** only | structured values only, Phase 18 |
| Verify | — | — | ✓ | ✓ | — | — |
| Payment | existing payment roles | (Phase 6 decides Kassa roles) | — | — | own status | — |

### 5.1 Database layer

- Catalog tables: `SELECT` to `authenticated` where `is_clinic_staff(clinic_id)`; no write grants (writes via server routes, like `services`).
- `lab_orders`, `lab_order_items`, `lab_samples`, `lab_sample_items`: `SELECT` for clinic staff (status work queues); no write grants.
- `lab_results`, `lab_result_values`, `lab_documents`: **no grants to `authenticated`**; service role only, like `clinical_records` after `20260929000001`. RLS enabled anyway as a backstop.
- All mutations through server-only SQL functions / service-role routes after explicit authorization.

### 5.2 Server layer

New `src/lib/labs/access.ts` with explicit functions (`canEnterLabResult`,
`canReadLabResults`, `canVerifyLabResult`…), each scoping by the session's
clinic. Every result read is audited strictly (`lab_result_viewed`, ids only).

### 5.3 Doctor read scope — **proposal, Open O3**

A doctor sees the **verified** lab results of a patient when
`doctor_patient_access()` admits them (own patient, or active unexpired
referral), plus the status and values of orders they placed themselves.
Lab results are objective measurements, not another doctor's authored notes,
so access is patient-level within that existing decision rather than
per-appointment. Access still ends with the referral. Doctors cannot edit
results they did not enter, and write their interpretation as their own
`clinical_records` entry.

### 5.4 Verification — **proposal, Open O4**

Clinic setting `verification_mode`:
- `single_step`: the person who enters (lab staff or doctor) also verifies.
- `two_step` (default): a different lab staff member or a doctor verifies.

---

## 6. Audit

- Id-only triggers (pattern `clinical_records_audit`) on `lab_orders`,
  `lab_order_items`, `lab_samples`, `lab_results`, `lab_documents`:
  `lab_order_created/cancelled`, `lab_item_status_changed`,
  `lab_sample_collected/rejected`, `lab_result_entered/submitted/verified/corrected`,
  `lab_document_uploaded/withdrawn`. Values never enter `audit_events`.
- **Never** attach `audit_track_changes()` to result tables (it copies rows).
- Strict read audits from the server for result and document reads.
- Catalog changes: generic audit trigger is acceptable (configuration, not patient data).

---

## 7. Deletion and retention

- No retention period is defined (legal question still open, `TASKS.md`).
- Lab rows reference `patients` with **NO ACTION** (not cascade): a standalone
  patient deletion is blocked while lab history exists, instead of silently
  erasing it. Clinic erasure still works because lab tables also cascade from
  `clinics` within the same statement. No app path deletes patients today
  (only test cleanup).
- Catalog rows referenced by history cannot be deleted (NO ACTION); they are
  deactivated.
- Documents are withdrawn, not deleted, through the app.

---

## 8. ER diagram

```
clinics ──────────────────────────────────────────────────────────────┐
  │                                                                   │
  ├── lab_test_categories ─┐                                          │
  ├── lab_tests ◄──────────┘──┬── lab_test_parameters ── lab_reference_ranges
  │       ▲                    │
  ├── lab_panels ── lab_panel_tests ──► lab_tests
  │
  ├── patients (+date_of_birth, sex, document_number, pinfl)
  │      │
  │      ├──< lab_orders >── doctors (ordering_doctor_id, optional)
  │      │        │      >── appointments (consultation, optional)
  │      │        │      >── profiles (ordered_by)
  │      │        │
  │      │        ├──< lab_order_items >── lab_tests (snapshots)
  │      │        │         │
  │      │        │         ├──< lab_sample_items >── lab_samples
  │      │        │         └──< lab_results (versions) ──< lab_result_values >── lab_test_parameters
  │      │        │
  │      │        ├── payments (lab_order_id, existing engine)
  │      │        ├── notification_jobs (lab_order_id, lab_result_ready)
  │      │        └──< lab_documents (bucket lab-documents)
  │      │
  │      └──< clinical_records (doctor interpretation, unchanged)
  │
  ├── staff_roles (+ role 'lab')
  ├── app_settings (key 'lab')
  └── audit_events (id-only lab actions)
```

---

## 9. Indexes (beyond PK/unique)

- `lab_orders (clinic_id, patient_id, created_at desc)`, `(clinic_id, status, created_at)`
- `lab_order_items (clinic_id, status, created_at)` — work queues; `(clinic_id, patient_id, test_id, created_at desc)` — recent-similar-test lookup and trends
- `lab_samples (clinic_id, status, collected_at)`
- `lab_results (order_item_id)`, `(clinic_id, status) where status in ('draft','submitted')` — verification queue
- `lab_result_values (parameter_id)` via `(result_id, parameter_id)` unique; trend queries join through items
- `lab_documents (clinic_id, order_id)`

---

## 10. Phase 2 migration order

1. Enum values in their own migrations: `staff_role` `lab`; `notification_job_type` `lab_result_ready`.
2. New enums + `patients` columns (+ pre-flight for any unique index).
3. Catalog tables.
4. Orders, items, samples, sample items.
5. Results, values, documents (+ private bucket).
6. `payments` and `notification_jobs` subject extensions (pre-flight, booking-engine regression tests).
7. Validation/transition functions, audit triggers, RLS, grants.
8. Regenerate `full-db-setup.sql` and `database.types.ts`; extend `clinical-isolation.test.ts` FORBIDDEN list with lab result tables/modules.

---

## 11. Open questions

- **O1** Unique `document_number` per clinic (depends on existing duplicates).
- **O2** How a panel's price is split across its items for the payment total and refunds.
- **O3** Doctor read scope: patient-level within `doctor_patient_access()` (proposed) vs. per-appointment like `clinical_records`.
- **O4** Default verification mode (`two_step` proposed) and whether doctors may verify.
- **O5** Whether a receptionist who orders a test may see its result values (proposed: no — status only, per minimum-necessary).
- **O6** Payment policy default (`not_required` proposed, so no clinic is blocked by an unconfigured Kassa).
