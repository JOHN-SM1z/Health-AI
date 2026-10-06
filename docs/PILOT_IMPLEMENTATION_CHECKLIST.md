# Clinic pilot implementation checklist

Updated 2026-10-06. This checkout is a development candidate, not a production launch. Payroll is deferred.

| Phase | Current evidence / remaining work |
|---|---|
| 0: Baseline | Existing uncommitted clinic operations work preserved on `codex/clinic-operations-pilot`. Historical approval claims superseded. |
| 1: Verification | See [pilot validation](PILOT_VALIDATION_2026-10-06.md): complete application suite and synthetic authenticated browser journey executed. Live external delivery, device connections and clinic acceptance remain unverified. |
| 2: Outpatient | Registration, queue, single-service server-priced charge, manual collection/refund, notes and simple referrals implemented. Multi-item billing, discounts/partial payment policy, shift reconciliation and correction workflows still need implementation/acceptance. |
| 3: Laboratory | Doctor-scoped orders, named tests, explicit specimen type, accession identifiers, collection/receipt/processing/rejection, recollection and append-only manual result drafts implemented. No inferred reference ranges. Each order currently has one specimen type. |
| 3: Laboratory remaining | Test catalogue/service mappings, scan-tested barcode labels, lab-operator/verifier permissions, approved report, verification/release/amendment policy and private delivery remain. No device adapter or patient release enabled. |
| 4: Pilot | Clinic staff/catalogue/prices/policies, acceptance contact, restore/downtime/rollback rehearsal and controlled reconciliation required before real use. |
| 5: Inpatient | Admission, beds/transfers, rounds, packages, inpatient cashier and expenses remain. Do not retire inpatient MedPlus. |
| 6: Devices | Blocked on equipment inventory and manufacturer interface evidence. Generic workflow can progress independently. |

## Design and authorization

The laboratory workbench reuses the clinic's existing pine/sand palette, display headings and tabular utility typography. Its defining layout is a specimen-status column beside the ordered-test/result workspace. Status text and explicit actions carry meaning without relying on color. Patient identity stays above both columns. Narrow screens stack the sections.

Only active doctors with an existing authorized patient relationship can currently use this workbench. Management and reception roles receive no access to clinical lab content. This is not a substitute for a future explicitly configured laboratory operator role. All reads and mutations are checked by the same server-only database RPC. Exposed tables have RLS and no browser policies. Request-supplied clinic/author/release fields are rejected.

Order retries bind their payload. Specimen transitions use expected versions. Drafts use expected revisions and require reasons for corrections. Recollection creates a new accession and retains earlier specimens/results; prior-sample results cannot satisfy the replacement specimen. Audit events record actions and identifiers, not copied clinical values.

A draft is never advertised as verified, released or delivered. Release remains unavailable until the clinic supplies verifier and release policies. Lab orders do not create a financial charge yet; service catalogue mapping and itemized billing are unfinished.

## Clinic inputs still required

- Pilot departments, staff permissions and acceptance contact.
- Service/test catalogue, prices, specimen requirements and doctor assignments.
- Payment/refund/discount and exception rules.
- Authorized lab operators/verifiers, self-verification decision, release/withdrawal and critical-result procedure, approved report example.
- Inpatient package and refund rules for the subsequent phase.
- Device model, firmware, host-interface manual and middleware inventory when available.

No production data, migration or deployment is authorized by a GitHub push. The release remains subject to the above operational gates.
