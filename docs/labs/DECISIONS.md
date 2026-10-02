# Laboratory module — locked decisions

Status: **decided by the owner (2026-10-01)**, answering the open questions of
`PHASE_1_AUDIT.md` §13. This file is the authority for Phases 2–14. Statements about Uzbekistan's
Personal Data Law below are the **owner's understanding, recorded as given — they were not verified by
the engineering assistant and must be confirmed by counsel before anything depends on them.** No
compliance claim is made anywhere in this repository.

## D1 — Branch base

The lab module is built from the head of PR #13 (`claude/longitudinal-on-retention`) on
`feat/lab-system`. It does not wait for #10 or #13 to merge.

```
#10 → #13 → feat/lab-system
(#10 merges → #13 retargets to main → feat/lab-system rebases)
```

`feat/lab-system` is never merged to `main`, and never deployed, before #13's dependency is settled.

## D2 — Payments

* **Extend the existing payments domain; no `lab_payments` table.** Lab orders become a second billable
  entity next to appointments, without breaking existing appointment payments (backward compatible,
  one migration with the consumer review of Phase 5).
* The generalisation is a *billable-entity relationship*, not lab-specific columns scattered on
  `payments`. (Implementation in Phase 5: nullable `appointment_id` / `lab_order_id` with a
  "exactly one" check and per-owner uniqueness is the intended minimal form; the review of every
  `payments → appointments` consumer is part of that phase's Definition of Done.)
* **A minimal payment-confirmation receipt is built now:** clinic, patient, payment id, date/time,
  items, amount, currency, payment status, related visit/lab order. It is **not** a fiscal/legal
  receipt and must never be labelled as one. Fiscalisation is a later integration.

## D3 — Patient access to results; Telegram notification

* A patient sees **only verified/finalised** results — never drafts, partially entered values, internal
  lab comments, the verification workflow or internal audit metadata. They see test name, collection
  date, parameter, value, unit, reference range, normal/low/high status and, later, a downloadable report.
* Access is through the authenticated Telegram Mini App / patient identity — never through values in a
  Telegram message.
* A Telegram "result ready" notification is sent **only** when the patient has a linked Telegram
  identity **and** the applicable consent/notification preference allows it. The text carries no
  values, no diagnosis, no interpretation, no test names beyond what the owner approves.
* New patient preferences: `data_processing_consent` and `telegram_result_notifications_enabled`
  (exact storage and wording to be designed in the phase that builds them, with the existing
  `consent_given` field of `patients` reviewed first).

## D4 — AI

* AI lab summaries are **assistive only**: summarise, compare trends, flag similar/repeated tests.
  Never diagnose, prescribe, order or cancel tests, or make treatment decisions.
* Input is the minimum structured data: test, parameter, value, unit, reference range, flag, previous
  values, dates. **No patient identifiers** (name, phone, Telegram id, passport, PINFL, address) and no
  full history.
* Implemented behind the existing `AiProvider` abstraction through a provider registry; **production is
  feature-flagged OFF** until the provider, data-processing arrangement and applicable cross-border/
  privacy requirements are explicitly approved. Initially: adapter + synthetic/test data only.

## D5 — Patient identity and import matching (supersedes the first version of this decision)

Receptionists collect **ID/passport series + number (e.g. `AB 1234567`)**, not PINFL, so identity is
built around that.

* The permanent anchor is the **Health AI patient UUID** — never a passport, phone or PINFL.
* `patients.date_of_birth` is added.
* **Document identity is a first-class, protected identifier** in a separate table
  (`patient_identifiers`: type `passport` / `national_id` / `other`, series, number, normalised value,
  country, valid from/until, `is_current`, source). A patient can hold several over time; a changed
  document never creates a second patient. The value is protected (encrypted at rest, deterministic
  blind index for exact lookup, excluded from logs, audit payloads and AI prompts, RBAC-restricted,
  masked in UI with an audited reveal).
* **PINFL is optional and later** — supported by the same table (`type = pinfl`) but never required.
* **No passport/ID images** in the MVP.
* **Legacy patient ids are kept**: `patient_external_identifiers (patient_id, source_system,
  external_patient_id, imported_at)`.
* **Import matching never merges silently.** Strong matches (e.g. exact document + DOB, or exact
  document + phone) are proposed as `exact`; weaker combinations are `probable`/`possible`;
  name alone is never a match. Ambiguous cases go to a manual reconciliation workflow; the importer
  attaches history to the patient UUID only after a match is accepted. Raw import identifiers that are
  not retained as `patient_identifiers` are purged after reconciliation.
* Open (needs a decision before the identity phase): key management for the encryption key and the
  blind-index key (where held, rotation, who can decrypt), and which roles may reveal a full document
  number.

## What this changes in the plan

* **Order** (supersedes the table in `PHASE_1_AUDIT.md` §14): 2 domain/DB → 3 role + configuration →
  4 doctor ordering → 6 result entry/verification → 7 longitudinal view + documents → **identity layer
  (new, before 9)** → 5 payments + receipt + sample collection → 11 dashboards → 9 merge tool + import →
  10 external adapter → 8 patient delivery (D3) → 12 AI (D4) → 13 review → 14 readiness.
* The identity layer is **not** needed by Phase 2 and is not part of it.

## `AGENTS.md` changes these decisions will require (proposed wording — applied only in the phase PR
that needs each, and reported explicitly there)

1. Phase 8 (patient results): *"Clinical text is never shown to operational staff, logs, audit rows,
   analytics or the patient-facing bot. A patient may view their own **verified** laboratory results
   through the authenticated Mini App; Telegram messages never contain results."*
2. Phase 12 (AI): *"AI must not read or summarise clinical text, except the feature-flagged laboratory
   trend summary, which receives only de-identified structured laboratory values and never runs in
   production until the provider and data-processing route are approved by the owner."*
3. Identity phase: *"Document identifiers (passport/ID/PINFL) are stored only in `patient_identifiers`,
   encrypted with a blind index; never in logs, audit, analytics or AI input."*

## Phase 5 notes (2026-10-02)

* Phase 5 was built before phases 6, 7 and the identity layer, at the owner's request ("phase 5"). The agreed order is otherwise unchanged.
* Payments: option B of the audit (polymorphic `payments`), as decided in D2. The receipt is the minimal payment confirmation described in D2 and is never labelled fiscal.
* Open (not assumed in code): fixed-price panels are billed at the panel price only when the whole panel is on the order; partial payments and order cancellation (with its refund consequences) are not built; lab revenue is reported beside, not inside, the existing appointment-based finance figures.

## D6-D9 — decisions of 2026-10-02 (owner), applied in the phase-6 amendment

* **D6 — Critical-value alerts: DEFERRED.** "Critical lab alerts — deferred until validated with doctors and clinical managers."
  For the MVP the product stores → verifies → shows the result normally. No alert, notification workflow, acknowledgement or escalation
  chain is built, and none of the earlier draft rules (5/10/15-minute targets, escalation order) is implemented. What exists is only
  what was already there: critical bounds are laboratory configuration (never hard-coded), the database stores a `critical_low` /
  `critical_high` flag beside the value, and nothing happens automatically because of it (no diagnosis, treatment, prescription or
  test cancellation). *The decision text contained both a detailed alert state machine and, at its end, "do not implement critical-result
  alerts in the MVP"; the later, explicit instruction was followed.* Which results are critical, who is told and how urgently is to be
  decided after clinical interviews.
* **D7 — Orphaned drafts.** A draft never becomes permanently inaccessible. If its holder is no longer an ACTIVE laboratory user
  (role removed, account banned or deleted), another laboratory user may take it over; the original author and creation time are kept,
  the new holder and time are recorded in an append-only event table and audited. Drafts are never hard-deleted: discarding is an
  audited abandonment (`cancelled`, by whom, when, why, whose draft). Owner/admin/manager may abandon an ORPHANED draft; they may not
  take it over, because that would mean writing a clinical value and results are not theirs under the current RBAC ("where permitted by
  RBAC"). A cancelled draft stays reconstructable and can never be finalised.
* **D8 — Parameter completeness.** For the MVP every ACTIVE parameter of an active test is mandatory for finalisation; there is no
  optional-per-parameter concept and none is inferred. The server (never only the UI) refuses a submission with a missing parameter, and
  distinguishes "missing" from legitimate values: zero, negative numbers, configured choices such as "not detected", free text, and
  values with a comparator (`<`, `<=`, `>`, `>=`), which are stored as a bound and never compared with the range.
* **D9 — Doctor visibility boundary.** Doctors have no access to results during entry/verification. Doctor-facing visibility begins in
  Phase 7 and must reuse the existing longitudinal access model (`doctor_patient_access()` / `canDoctorAccessPatientClinicalData()`) -
  no parallel laboratory access model. Only finalised (verified) results are ever visible to doctors; a draft, a submitted-but-unverified
  result and an abandoned one are never shown as a result - not even by status (the doctor's order list says "no result yet" for all of them).
