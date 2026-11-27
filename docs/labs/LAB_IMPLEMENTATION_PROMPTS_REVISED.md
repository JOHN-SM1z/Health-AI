> Current device rollout: [DEVICE_INTEGRATION_PLAN.md](DEVICE_INTEGRATION_PLAN.md). Use a shared lab core with individually validated analyzer connections. Payroll is outside the current release.

> Superseded in product priority by [the customer-development decision](../CLINIC_OPERATIONS_PRODUCT.md). The owner authorized clinician-authored history on 2026-10-05; the old C0 prohibition below is historical. Clinical AI remains excluded. Do not treat all 14 lab phases as prerequisites to the walk-in clinic workflow.

# Health AI Laboratory Module — Corrected Implementation Prompts

This document replaces the pasted implementation instructions. It does not certify
any prior implementation, test run, deployment or migration. Progress narratives
from the attachment are deliberately excluded; inspect their referenced commits
before relying on them.

## Mandatory scope gates

**C0 — Clinical scope:** Current AGENTS.md prohibits implementing clinical records.
Laboratory results fall within that scope. Phase 1 and non-clinical design work may
proceed; clinical schema, result entry, history and patient delivery must wait for
an explicit owner decision and a corresponding project-rule update. Do not silently
edit AGENTS.md or treat this document as overriding it. The intended lab exception,
if approved, must define authorized lab authorship, immutable verified versions,
existing doctor-read authorization, separate release policy and secure documents.
No diagnosis, treatment advice or prescriptions are authorized by this plan.

**A0 — Clinical AI:** Existing AI is limited to clinic information and booking
navigation. Phase 12 is excluded until separately authorized. Approving laboratory
records does not approve clinical AI.

**Policy decisions:** Before dependent implementation, document the verifier and
self-verification policy, release/withdrawal policy, critical-value escalation,
retention, identity collection/reveal/key management and billing model. An agent
may propose options; it must not invent clinic policy or claim legal compliance.

**Evidence:** The local checkout inspected on 2026-10-05 is
`claude/health-ai-diagnostic-audit-3ebzmq`, with uncommitted changes and no
`docs/labs` directory before this revision. The pasted `feat/lab-system` reports
are unverified in this checkout. Audit the actual target branch before continuing.

## Phase instructions


HEALTH AI — LABORATORY MODULE
Detailed Phased Implementation Prompts for Claude Code
GLOBAL INSTRUCTIONS FOR CLAUDE CODE
These instructions apply to every phase.
You are implementing the Laboratory module inside the existing Health AI
Configurable Clinic OS.
Audit whether Health AI has each of the following; these are requirements to investigate, not verified existing capabilities:
- multi-tenant clinics
- clinic configuration
- patients
- doctors
- specialties/departments
- appointments
- booking engine
- Kassa/payments
- referrals
- longitudinal patient history
- doctor-owned clinical records
- RBAC
- Supabase RLS
- audit events
- Telegram/Mini App
- notifications
- secure/server-side clinical access
The Laboratory module MUST EXTEND this architecture.
Do NOT create duplicate systems for:
- patients
- doctors
- clinics
- appointments
- payments
- referrals
- clinical history
- authentication
- authorization
- notifications
- file storage
- audit logging
Before changing code:
1. Inspect the current implementation.
2. Identify reusable entities/services/components.
3. Confirm current migration state.
4. Confirm current RLS patterns.
5. Confirm current clinical-record ownership rules.
6. Confirm current payment architecture.
7. Confirm current notification architecture.
Never assume an external laboratory API exists.
Never invent MedPlus API capabilities.
Never trust client-provided:
- clinic_id
- patient_id
- doctor_id
- order price
- result ownership
- verification state
- payment state
All critical authorization must be enforced server-side and, where appropriate,
at the database/RLS level.
Clinical records remain longitudinal and doctor-attributed.
A doctor may read historical records when the existing clinical-access model
allows it, but must not modify another doctor's authored record.
AI is an assistance layer only.
AI must never:
- diagnose
- prescribe
- automatically order tests
- automatically cancel tests
- independently decide that a test is unnecessary
Do not apply production migrations.
Do not deploy production.
Do not make destructive schema changes without explicit safety analysis.
After each phase:
- run relevant tests
- run typecheck
- run lint
- run build when appropriate
- report exact results
- report remaining risks
- report anything that could not be verified
Do not start a dependent phase until its prerequisites and Definition of Done are satisfied. Optional phases do not block core release unless the approved release scope includes them.
PHASE 1 — ARCHITECTURE AUDIT + LAB DESIGN

EVIDENCE AND SCOPE REQUIREMENTS
Record branch, commit, dirty-tree state and relevant file paths. Pasted reports,
remote branch names, test counts and workflow announcements are leads, not proof.
Do not discard existing uncommitted work. Verify reported implementations on the
actual branch/worktree before claiming completion. Record migration files and
local application state separately from production state; never access production
just to satisfy this audit. Inventory clinical-access functions and guard tests
by their real names. Define a role/action/data permission matrix and document
explicit scope decisions before any clinical implementation.

Objective
Understand the existing Health AI architecture and determine exactly what the Lab module needs.
Claude Code prompt
PHASE 1 — AUDIT THE EXISTING HEALTH AI ARCHITECTURE FOR LABORATORY INTEGRATION
Do NOT implement the laboratory system yet.
Perform a repository-wide audit specifically for adding a Laboratory module.
Inspect:
DATABASE
- all Supabase migrations
- patients
- doctors
- specialties
- staff_roles
- appointments
- payments
- referrals
- clinical_records
- audit_events
- notifications
- storage-related tables/configuration
BACKEND
- patient services
- clinical-access services
- referral services
- booking engine
- payment services
- notification services
- API authorization
- error handling
- file/document handling
- AI infrastructure
FRONTEND
- doctor workspace
- admin/manager dashboard
- receptionist workflows
- patient profile
- longitudinal history tabs
- existing settings/configuration pages
- existing UI components
TESTING
- DB tests
- RLS tests
- authorization tests
- integration tests
- E2E tests
- migration tests
Determine:
1. Whether any laboratory entities already exist.
2. Whether `specialties` already represents departments and can be reused.
3. Whether a separate `LabDepartment` is necessary.
4. How clinical records are currently attributed to doctors.
5. How doctors access longitudinal history.
6. How payments are attached to appointments/services.
7. How secure files are currently stored.
8. How Telegram notifications are currently sent.
9. How patient identity is currently resolved.
10. Whether a lab-specific role is needed.
11. How existing audit events should be extended.
12. Which current components/services should be reused.
13. Which new entities are actually necessary.
14. Which assumptions from the Lab product specification are incompatible with
    the current codebase.
Do not silently resolve architectural conflicts.
Document them.
Create:
docs/labs/PHASE_1_AUDIT.md
Include:
- existing architecture
- reusable systems
- proposed lab architecture
- proposed entities
- proposed workflows
- proposed permissions
- migration strategy
- security concerns
- risks
- unresolved questions
At the end provide the recommended implementation sequence for the remaining
Lab phases.
DO NOT:
- create tables
- create migrations
- change APIs
- change UI
- modify production
Definition of Done
[ ] Existing architecture audited
[ ] Existing lab functionality identified
[ ] Duplicate entities identified and rejected
[ ] Proposed lab architecture documented
[ ] Risks documented
[ ] Implementation dependencies documented
PHASE 2 — LAB DOMAIN MODEL + DATABASE FOUNDATION

DOMAIN CONTRACT REQUIREMENTS
Before migrations, specify permitted state transitions, actors, preconditions,
atomic boundaries and retry semantics. Keep verification and patient/doctor
release separate. Include partial completion, cancellation, rejected/recollected
specimens, corrections and withdrawal. Bind verification to an immutable version.
Snapshot ordered catalog definitions, panel membership, price/currency, parameter
codes, units, method and applicable reference rules; later catalog edits must not
change historical meaning. Model a specimen supporting multiple tests where
needed. Preserve numeric precision, qualitative values, missing values and
unclassifiable values. No applicable range means UNKNOWN, never NORMAL.

Objective
Create the normalized laboratory data model.
Claude Code prompt
PHASE 2 — IMPLEMENT THE LABORATORY DOMAIN MODEL AND DATABASE FOUNDATION
Use the Phase 1 audit as design evidence, subordinate to the applicable AGENTS.md and approved scope decisions.
First verify that the proposed schema does not duplicate existing Health AI
entities.
Design the minimum normalized laboratory model required by the actual product.
Evaluate these concepts:
- LabTest
- LabTestParameter
- LabTestPanel
- LabOrder
- LabOrderItem
- LabSample
- LabResult
- LabResultParameter
- LabResultVersion
- LabResultAttachment
- LabResultVerification
Only create entities that are genuinely required.
Do NOT create LabDepartment if existing `specialties` already represents the
clinic department concept safely.
Every clinic-owned laboratory object must be clinic-scoped.
Where a child entity references multiple clinic-owned entities, enforce
same-clinic integrity using the same composite-FK strategy used elsewhere in
Health AI.
LAB TEST CONFIGURATION MUST SUPPORT:
- name
- code
- category/department
- description
- active/inactive
- price
- turnaround time
- sample type
- preparation instructions
- parameters
LAB PARAMETERS MUST SUPPORT:
- name
- code
- unit
- data type
- reference range
- configurable bounds
- critical thresholds if supported by the approved model
- display order
Do not hard-code reference ranges globally.
LAB ORDER MUST CONNECT TO:
- clinic
- patient
- ordering doctor
- consultation/appointment where appropriate
- referral where appropriate
- order date
- priority
- notes
- lifecycle status
Keep these concepts separate:
LAB ORDER STATUS
PAYMENT STATUS
SAMPLE STATUS
RESULT STATUS
VERIFICATION STATUS
Do not combine them into one state field.
RESULTS MUST PRESERVE:
- patient
- order
- test
- author/entered_by
- verification information
- timestamps
- structured values
- reference data used at the time of evaluation
- abnormal/critical classification
- version lineage where required
- attachments
Implement:
- indexes
- foreign keys
- uniqueness constraints
- checks
- lifecycle constraints
- appropriate audit triggers
- RLS/server-only access according to current architecture
Respect existing retention/deletion rules.
Do not create automatic destructive deletion behavior.
Create incremental migrations.
Do not manually rewrite historical production migrations.
Add database tests covering:
- valid inserts
- invalid clinic relationships
- invalid patient relationships
- invalid doctor relationships
- invalid statuses
- cross-clinic attempts
- unauthorized access
- unauthorized mutation
Update generated schema/database types if that is the project's current workflow.
Run:
npm test
npm run lint
npm run typecheck
npm run build
Do not deploy.
Definition of Done
[ ] Lab schema exists
[ ] No duplicate patient/doctor/payment/history systems created
[ ] Multi-tenant constraints enforced
[ ] RLS/security strategy implemented
[ ] Lifecycle constraints implemented
[ ] DB tests pass
[ ] Typecheck/lint/build pass
PHASE 3 — LAB RBAC + CLINIC CONFIGURATION

PERMISSION AND CONFIGURATION REQUIREMENTS
Configuration permission does not imply permission to read clinical values.
Define lab entry, verification, release, correction, withdrawal, identity reveal
and finance permissions individually. Decide self-verification policy explicitly.
Critical thresholds and reference rules require authorized clinical/lab governance;
business price-editing permission alone must not authorize clinical rule changes.
Define effective dates and versions, applicable units/methods and demographic
criteria only where approved data exists. Prove that database access cannot bypass
server permission boundaries. Every mutation rechecks active membership and role.

Objective
Make the laboratory configurable by each clinic.
Claude Code prompt
PHASE 3 — IMPLEMENT LAB PERMISSIONS AND CLINIC CONFIGURATION
Use the existing Health AI RBAC model.
First inspect current staff roles and determine whether a new laboratory role
is required.
Do not create a new role simply because the specification names "lab staff".
Reuse existing roles where practical, but create a dedicated role if the
actual workflow requires permissions that cannot safely be represented by
current roles.
Define permission boundaries for:
OWNER
MANAGER
RECEPTIONIST
DOCTOR
LAB STAFF / LAB VERIFIER if implemented
Separate:
1. Configuration
2. Laboratory operations
3. Clinical access
4. Financial access
OWNER/MANAGER:
- create/edit/deactivate tests
- manage panels
- manage parameters
- configure prices
- configure sample types
- configure preparation instructions
- configure turnaround times
- configure verification workflow
- view laboratory operational analytics
- view laboratory financial analytics where authorized
DOCTOR:
- search laboratory tests
- order tests
- view results they are authorized to see
- view historical relevant results
- never modify another doctor's authored clinical records
LAB STAFF:
- view necessary orders
- manage samples
- enter results
- manage laboratory workflow
- no unrelated financial/admin access
VERIFIER:
- verify/finalize results if the clinic workflow enables this
RECEPTION:
- operational functions explicitly allowed by the system
- payment/booking integration
- no unrestricted clinical access
Security requirements:
- server-side authorization
- RLS where appropriate
- no client-only security
- no trusting request clinic IDs
- no trusting request actor IDs
Then build the LAB CONFIGURATION UI.
Support:
- tests
- codes
- category/department
- panels
- parameters
- units
- reference ranges
- critical thresholds
- price
- sample type
- preparation instructions
- turnaround time
- active/inactive state
- verification workflow
Inactive tests:
- cannot be newly ordered
- historical orders/results remain readable according to authorization
Reuse existing Health AI design components.
Add:
- loading states
- empty states
- validation errors
- authorization errors
- success feedback
Add tests for:
- owner access
- manager access
- doctor denial
- receptionist denial
- lab staff access
- cross-clinic configuration access
Run full relevant tests.
Definition of Done
[ ] RBAC defined
[ ] RLS enforced
[ ] Configuration UI works
[ ] Tests are clinic-specific
[ ] Inactive tests behave correctly
[ ] Cross-clinic attacks fail
PHASE 4 — DOCTOR ORDERING + DUPLICATE TEST AWARENESS

ORDER TRANSACTION REQUIREMENTS
Validate consultation/patient/doctor/test relationships in the same authoritative
transaction that creates the order. Scope idempotency keys to clinic, actor and
operation and bind them to a payload fingerprint; conflicting reuse must fail.
Snapshot the ordered definition and authoritative pricing. Deduplicate overlapping
panel items under an explicit billing policy. Comparable-test matching uses
approved codes/methods/units; never infer equivalence from names alone.

Objective
Connect laboratory orders to the doctor's consultation workflow.
Claude Code prompt
PHASE 4 — IMPLEMENT DOCTOR LAB ORDERING
Integrate the laboratory workflow into the existing Doctor Workspace.
Do NOT create a separate doctor application.
Workflow:
Patient
→ Doctor consultation
→ Laboratory
→ Select test/panel
→ Review
→ Submit order
Doctor must be able to:
- search tests
- search by code/name/category
- select individual tests
- select panels
- review price
- see preparation instructions
- review turnaround time
- create order
- see existing order status
- see previous comparable tests/results
The order must be derived from the server-side doctor context.
Never trust:
- clinic_id from client
- patient_id from client without authorization
- doctor_id from client
- price from client
The patient must be the patient of the active consultation or an otherwise
authorized patient according to the existing longitudinal-access model.
Implement idempotency for repeated submissions.
Implement recent-test detection.
Example:
"Similar test found:
CBC — 18 days ago"
Actions:
[View previous result]
[Continue ordering]
This warning is advisory only.
Do not:
- block ordering
- diagnose
- prescribe
- automatically recommend cancellation
- automatically declare the test unnecessary
The final clinical decision belongs to the doctor.
Add tests for:
- valid order
- unauthorized patient
- cross-clinic patient
- inactive test
- duplicate submit
- idempotent retry
- incorrect doctor context
- incorrect consultation
- recent comparable test
Run the relevant test suites and build.
Definition of Done
[ ] Doctor can order tests
[ ] Panels work
[ ] Order is linked to correct patient/doctor/consultation
[ ] Duplicate submissions are safe
[ ] Recent-test warning works
[ ] Authorization tests pass
PHASE 5 — KASSA + SAMPLE COLLECTION

PAYMENT AND SPECIMEN REQUIREMENTS
Audit current appointment/payment constraints before extending them. Select an
explicit billing relationship supporting authorized line allocations, partial
payments/refunds and cancellation without double-counting appointment payments.
Retain manual-only production payments under current rules. Do not bypass booking
engine requirements when the workflow also creates/reschedules appointments.
Lock or atomically compare order/sample state during collection and cancellation.
Specify rejection, recollection, insufficient sample, shared specimens, collector
identity and repeat-collection authorization. Do not erase failed specimens.

Objective
Connect orders to the existing payment system and laboratory operational workflow.
Claude Code prompt
PHASE 5 — INTEGRATE LAB ORDERS WITH KASSA AND IMPLEMENT SAMPLE COLLECTION
Do NOT create a new payment engine.
Use the existing Health AI Kassa/payment system.
The following states must remain separate:
Lab Order
Payment
Sample
Example:
Lab Order
   ↓
Payment according to clinic policy
   ↓
Payment status updated
   ↓
Sample collection
   ↓
Processing
The system must not hard-code:
"payment is always required before sample collection"
Use clinic configuration when such a policy exists.
Payment amount must come from the authoritative server-side test/panel pricing.
Never trust:
- client price
- client payment status
- client paid flag
Audit and reuse any existing receipt architecture. If none exists, design a receipt extension within the current payment system before promising receipt behavior.
If payment is successful:
- existing payment record is updated
- digital receipt follows existing system behavior
If payment fails:
- laboratory order remains correctly represented
- no false "paid" state
If refunded:
- reflect authoritative payment state without corrupting clinical history
Then implement sample collection.
Sample should contain the minimum required:
- clinic
- patient
- lab order
- order item/test
- sample ID
- sample type
- collected_at
- collector
- sample status
- operational notes where appropriate
Lifecycle:
ORDERED
→ READY_FOR_COLLECTION
→ COLLECTED
→ PROCESSING
Use approved status names from the actual model.
Prevent:
- sample creation for cancelled order
- cross-clinic sample assignment
- patient/order mismatch
- duplicate sample when not allowed
- unauthorized collection actions
Add concurrency tests:
- two staff collect same sample
- repeated collection request
- concurrent order/sample updates
Run payment, database, authorization and integration tests.
Do not deploy.
Definition of Done
[ ] Existing Kassa reused
[ ] Payment and order status remain separate
[ ] Server determines amount
[ ] Receipt integration works
[ ] Sample lifecycle works
[ ] Concurrency protections work
PHASE 6 — RESULT ENTRY + VERIFICATION + VERSIONING

RESULT SAFETY AND RELEASE REQUIREMENTS
A verified version is immutable. Corrections create a new version and re-enter
verification/release; the standing version remains explicit until replacement or
withdrawal. Record withdrawal reason/actor/time and revoke downstream access under
policy. Require an expected version for concurrent mutations.
Before enabling critical-value classification, approve a human-owned protocol:
recipient, acknowledgement, delivery failure, time-bound escalation, after-hours
coverage, correction handling and audit evidence. Keep this operational escalation
separate from AI and diagnosis. If the protocol is absent, disable critical-value
capability and record that limitation in readiness; never promise critical alerts.
Verifier inactivity/missing coverage must block finalization safely. Imported
historical provenance must not impersonate local entry or verification.

Objective
Build the actual laboratory results workflow safely.
Claude Code prompt
PHASE 6 — IMPLEMENT RESULT ENTRY, VERIFICATION AND VERSIONING
Build the Laboratory result workflow.
Result entry must use the configured test parameters.
Example:
CBC
Hemoglobin    118 g/L
WBC           7.2 ×10⁹/L
RBC           4.1 ×10¹²/L
Platelets     220 ×10⁹/L
For structured values, compare against configured reference ranges.
Display:
- normal
- low
- high
- critical
Do not interpret these values diagnostically.
The UI may say:
"Outside configured reference range"
It must NOT automatically say:
"Patient has anemia"
or any other disease conclusion.
Implement:
Result version: DRAFT → SUBMITTED → VERIFIED
Release: WITHHELD → RELEASED, with controlled WITHDRAWN handling
Verification and release are separate decisions; model names must follow the approved design.
Use exact statuses appropriate to the actual domain model.
Verification must only be possible to authorized users.
Finalized results must not be silently overwritten.
If a result needs correction:
OLD VERSION
→ NEW VERSION
Preserve:
- original author
- corrected-by identity
- timestamps
- previous version
- new version
- verification history
A doctor reading laboratory results must not gain result-entry or verification rights. Lab result authorship belongs to the authorized laboratory actor or preserved external source; ordering-doctor attribution is a separate relationship.
A doctor who wants to record a different clinical interpretation must create
their own clinical record according to the existing longitudinal model.
Implement concurrency protection for:
- simultaneous verification
- simultaneous correction
- stale-version correction
Add audit events for:
- result creation
- result verification
- result correction
- relevant result access events
Audit events must never contain unnecessary clinical text.
Add comprehensive tests.
Run:
- unit tests
- DB tests
- authorization tests
- concurrency tests
- typecheck
- lint
- build
Definition of Done
[ ] Structured results work
[ ] Reference ranges work
[ ] Abnormal/critical classification works
[ ] No autonomous diagnosis
[ ] Verification works
[ ] Versioning works
[ ] Author ownership preserved
[ ] Concurrent corrections protected
PHASE 7 — LONGITUDINAL HISTORY + DOCUMENTS

DOCUMENT AND HISTORY REQUIREMENTS
Show only the version and fields permitted by the approved read/release policy.
Version attachments explicitly; do not infer attachment membership only from its
upload timestamp. Implement audited retirement of a wrong attachment that removes
it from downloads and future notifications while preserving the stored evidence
under retention policy. Every download checks current authorization, version,
release/withdrawal and retirement. Use private storage and authenticated streaming
where immediate revocation is required. Content signatures and checksums do not
prove malware safety. Define scanning/quarantine or record the approved limitation,
serve safe content headers and deny unsupported active formats. Lab document upload
is not an identity-document intake channel; define prohibited content handling.

Objective
Make lab results a native part of Health AI's longitudinal record.
Claude Code prompt
PHASE 7 — INTEGRATE LAB RESULTS INTO LONGITUDINAL PATIENT HISTORY
Do not create another medical-history system.
Extend the existing patient longitudinal record.
Conceptually:
Patient
├── Consultations
├── Diagnoses
├── Referrals
├── Laboratory Orders
├── Laboratory Results
├── Prescriptions
├── Imaging
├── Treatments
└── Documents
Integrate laboratory results into:
- doctor patient workspace
- patient clinical history
- patient profile where appropriate
When Doctor B legitimately sees a patient's longitudinal history:
Doctor B should see the laboratory information allowed by the existing
clinical-access model.
Doctor B cannot modify Doctor A's authored clinical record or any laboratory result merely because it is readable.
Locate and preserve the existing clinical-access decision, if present. Do not assume `doctor_patient_access()` exists, and do not introduce it solely because this prompt names it. If it exists, do not weaken it.
Preserve:
- clinic isolation
- doctor ownership
- historical records
- timestamps
- source information
- version history
Support:
- recent results
- historical results
- result detail
- test name
- order date
- collection date
- result date
- verification date
- previous versions
Then implement laboratory result documents.
Support approved PDF, PNG and JPEG result documents; scanned/imported reports
must use these supported formats. Other formats require a separate validation
and serving design before acceptance.
Reuse existing storage authorization patterns. A separate private bucket for lab documents is permitted within the same storage system when required by its access and retention policy.
Do not create a separate storage system.
Documents must be clinic-scoped and patient-scoped.
No public result URLs.
Secure access must verify:
- clinic
- patient
- authorization
- result/document relationship
Implement:
- upload validation
- file size limits
- file type validation
- secure download
- authorization
- audit logging
Add tests for:
- doctor access
- cross-clinic denial
- unauthorized patient
- wrong document ID
- forged download URL
- another doctor's mutation
- version preservation
Definition of Done
[ ] Lab results appear in longitudinal history
[ ] Existing clinical-access model preserved
[ ] Documents securely stored
[ ] Unauthorized document access fails
[ ] Doctor ownership preserved
PHASE 8 — PATIENT TELEGRAM + NOTIFICATIONS

PATIENT RELEASE AND DELIVERY REQUIREMENTS
Clinical implementation gate C0 and an approved patient-release policy are
prerequisites. Separate verification from release. Define amended/withdrawn result
notifications, partial reports and patient/proxy identity rules where applicable.
Create an outbox event transactionally with release, keyed to patient and version.
Atomically claim jobs and recheck identity/release before sending. Do not claim
exactly-once external delivery: a crash after send can leave delivery uncertain.
Document retry/deduplication policy and distinguish attempted, provider-accepted,
failed and unknown delivery. Deep links confer no access by themselves.

Objective
Deliver ready results to patients through the existing Telegram infrastructure.
Claude Code prompt
PHASE 8 — INTEGRATE LAB RESULTS WITH TELEGRAM AND NOTIFICATIONS
Use the existing Health AI patient identity and Telegram architecture.
When a verified laboratory result version is explicitly released to the patient:
RESULT VERSION RELEASED TO PATIENT
→ Notification event
→ Patient Telegram notification
→ Mini App opens
→ Laboratory Results
→ Result detail
→ Secure document/result access
Example notification:
"Your laboratory result is ready.
[Open secure patient portal]"
Keep notifications generic: no test name, value, diagnosis, patient identifier, or clinical detail in the message or deep-link payload. Re-authorize inside the Mini App.
Use the authenticated patient identity already used by Health AI.
Do not create a second patient identity system.
The patient must only be able to access their own authorized results.
Support:
- notification event
- idempotent notification processing
- deep link
- lab-result listing
- result details
- document access
Handle:
- notification failure
- Telegram retry
- repeated events
- unavailable result
- revoked/invalid identity
- wrong clinic
- wrong patient
Use existing notification retry conventions.
Add tests for:
- correct patient notification
- duplicate event
- wrong patient
- wrong clinic
- result not ready
- secure deep link
- document access
Definition of Done
[ ] Result notification works
[ ] Patient sees only own results
[ ] Telegram uses existing architecture
[ ] Duplicate notifications controlled
[ ] Secure deep links work
PHASE 9 — HISTORICAL DATA MIGRATION + PATIENT MERGE

IDENTITY, MERGE AND IMPORT REQUIREMENTS
Approve field minimization, collection purpose, reveal permissions and encryption
key management before adding protected identifiers. Specify key storage, rotation,
recovery, blind-index normalization/versioning and redaction. Do not store ID images
in the laboratory bucket. Decide identifier uniqueness and typo resolution.
Merge within one clinic only. Lock both patients and relevant concurrent writes;
handle conflicting Telegram identities, sessions, conversations and notification
destinations explicitly. Preserve original references in audit lineage, recompute
access and test mistaken-merge recovery. Never silently choose an identity.
Separate confirmed matching from uncertain candidate scoring. Historical imports
retain source author/verifier, dates and unknown provenance without fabricating
local credentials or applying today's ranges retrospectively. Bind confirmation
to the validated preview fingerprint, revalidate before commit, and define atomic
batches, checkpoints and safe retry keys. PDF extraction stays draft until reviewed.

Objective
Enable real clinics to migrate old laboratory history.
Important
The patient merge capability should be implemented before serious bulk migration.
Claude Code prompt
PHASE 9 — BUILD SAFE HISTORICAL LAB IMPORT AND PATIENT RECONCILIATION
We need to migrate historical laboratory data from:
- MedPlus
- Excel
- CSV
- PDF
- other clinic/lab systems
Do NOT assume MedPlus exposes an API.
Build a generic import architecture.
Pipeline:
SOURCE FILE
→ Upload
→ Detect format
→ Map fields
→ Validate
→ Match patient
→ Detect duplicates
→ Preview
→ Administrator confirmation
→ Import
→ Import report
Before bulk laboratory migration, inspect the existing patient model and
implement a safe patient merge/reconciliation workflow.
Patient merge must not be a blind database merge.
A merge operation must:
1. Select canonical patient.
2. Select duplicate patient.
3. Show all linked data.
4. Show conflicts.
5. Show linked clinical records.
6. Show lab history.
7. Show appointments.
8. Show payments.
9. Show referrals.
10. Show documents.
11. Show conversations.
12. Preserve audit history.
13. Preserve doctor authorship.
14. Preserve clinic ownership.
15. Execute transactionally.
16. Be fully audited.
Never merge only because two names match.
Patient matching may consider only fields already collected lawfully under the approved identity policy; do not introduce passport/PINFL collection merely for matching. Candidate fields:
- internal patient identifier
- passport
- PINFL
- phone
- date of birth
- name
Use confidence levels:
- exact match
- probable match
- possible duplicate
- unmatched
Do not auto-merge uncertain patients.
Then implement the laboratory import engine.
Historical records should preserve:
- original date
- source system
- original test name/code where available
- original result
- original unit
- reference range if available
- document/source reference
Never silently overwrite existing results.
Support:
- dry run
- preview
- partial imports
- retry
- invalid rows
- unmatched patients
- duplicate results
- conflict reports
- import audit trail
The import tool must never cross clinics.
Add tests for:
- clean import
- malformed rows
- duplicate patients
- duplicate lab results
- unmatched patient
- conflicting identity
- partial import
- retry
- rollback/error recovery
- cross-clinic attack
Definition of Done
[ ] Safe patient reconciliation exists
[ ] Merge is auditable
[ ] Import supports CSV/Excel initially
[ ] Dry-run works
[ ] Duplicate detection works
[ ] Unmatched records are visible
[ ] No silent overwrite
PHASE 10 — EXTERNAL LAB INTEGRATION FRAMEWORK

ADAPTER TRUST REQUIREMENTS
Derive tenant/provider binding from authenticated server-side configuration, not
callback fields. Verify provider authenticity, replay protection and atomic event
claims before side effects. Validate external order/patient mapping and quarantine
unmatched results. Preserve external provenance; incoming results do not bypass
local verification/release rules. Test duplicate/out-of-order updates and uncertain
outbound delivery. Use only documented capabilities for real providers.

Objective
Make future LIS/laboratory integrations possible without modifying the core domain.
Claude Code prompt
PHASE 10 — BUILD THE EXTERNAL LABORATORY ADAPTER ARCHITECTURE
Do NOT integrate a real external provider yet unless its actual technical
documentation/API is available and verified.
Build an adapter architecture:
Health AI
    ↓
Laboratory Integration Interface
    ↓
Provider Adapter
    ↓
External Laboratory
The core Health AI lab domain must remain provider-independent.
The abstraction should support concepts such as:
- create order
- send order
- get order status
- receive result
- get result
- reconcile status
- handle provider errors
Use exact interfaces appropriate to the existing architecture rather than
blindly copying these names.
The adapter must support:
- authentication
- provider configuration
- request mapping
- response mapping
- error handling
- retries
- idempotency
- status mapping
- audit events
- provider-specific metadata where appropriate
Do not leak provider-specific schema into the Health AI core model.
Build a fake/mock laboratory provider only in isolated development/test environments; production must reject mock-provider configuration.
Prove:
Health AI Lab Order
→ Mock Provider
→ Mock Result
→ Health AI Lab Result
Definition of Done
[ ] Provider-independent interface exists
[ ] Mock provider works
[ ] Core domain remains normalized
[ ] Idempotency works
[ ] Provider errors are handled
PHASE 11 — LAB ANALYTICS + OPERATIONS

ANALYTICS REQUIREMENTS
Operational counters do not confer clinical-value access. Limit drill-down by the
same permissions as source records. Financial reports use payment allocations,
refunds and authoritative currency; do not sum different currencies or attribute
the same payment twice. Define date basis, clinic timezone and turnaround start/end
points, including rejected samples and partial orders. Test corrected/withdrawn
results and avoid leaking small patient groups through unrestricted aggregates.

Objective
Build dashboards only after the underlying lab data is authoritative.
Claude Code prompt
PHASE 11 — BUILD LABORATORY OPERATIONAL AND MANAGEMENT DASHBOARDS
Use the existing Health AI dashboard and analytics architecture.
Do not create a second analytics engine.
LAB STAFF VIEW:
- pending orders
- collection queue
- processing
- results awaiting entry
- results awaiting verification
- completed
DOCTOR VIEW:
- my orders
- pending results
- recent results
- abnormal values
- previous comparable tests
MANAGER VIEW:
- test volume
- workload
- pending results
- turnaround time
- cancelled orders
- operational bottlenecks
- revenue where authorized
OWNER VIEW:
- laboratory revenue
- revenue by test
- revenue by department
- test volume
- turnaround time
- outstanding work
- repeat-test patterns
Financial analytics MUST use authoritative payment data.
Do not calculate laboratory revenue merely from:
- completed orders
- catalog price
- appointment count
Use the actual payment records and existing analytics conventions.
Respect role restrictions.
Add:
- loading
- empty
- error
- permission denied
- date filtering where consistent with the existing dashboard
- clinic timezone handling
Test:
- owner visibility
- manager visibility
- doctor restrictions
- receptionist restrictions
- cross-clinic isolation
Definition of Done
[ ] Operational and financial dashboards enforce their permission boundaries
[ ] Payment allocations/refunds reconcile without double counting
[ ] Timezone and turnaround definitions tested

PHASE 12 — AI ISOLATION; CLINICAL SUMMARIES DEFERRED
Objective
Preserve existing clinic-information and booking AI while keeping laboratory
clinical data isolated under the current project rules.

Claude Code prompt
PHASE 12 — VERIFY LABORATORY DATA ISOLATION FROM AI
Do not implement clinical summaries or historical clinical trend interpretation.
Do not send laboratory values, documents, patient history or imported clinical text
to AI providers, embeddings, logs or AI tools. Approving the laboratory domain does
not authorize clinical AI. Preserve existing urgent-message and human-assignment
behavior; AI automation must stop while assigned to a human admin.

Verify that:
- Laboratory operations work with AI disabled, unavailable or timing out.
- Booking/navigation AI cannot retrieve lab results or documents.
- Unauthorized patient and cross-clinic context cannot reach AI inputs.
- Imported text and notes cannot expand AI tool permissions or trigger mutations.
- AI cannot create orders, cancel tests, alter results, verify or release reports.

If the owner later explicitly approves clinical AI, write a separate reviewed
specification and update the applicable policy before coding. That design must
address provider processing/retention, minimum necessary data, access revalidation,
source provenance, comparable units/methods, uncertainty, prompt injection and
fallback behavior. It must prohibit diagnosis, prescribing, invented ranges and
automatic clinical mutations. No clinical AI capability is part of this release.

Definition of Done
[ ] Current AI policy preserved
[ ] Laboratory workflow independent of AI
[ ] Clinical inputs excluded from existing AI paths
[ ] Authorization and injection isolation checks pass
[ ] Clinical summarization explicitly reported as deferred

PHASE 13 — COMPLETE ADVERSARIAL SECURITY REVIEW

CONTINUOUS REVIEW REQUIREMENTS
Run authorization, tenancy, race and regression checks with each relevant phase.
Final independent review also tests withdrawn/retired documents, release bypass,
critical-alert failure, merge identity takeover, configuration snapshot drift,
partial refunds and direct privileged RPC calls. Use isolated test fixtures and
transaction-scoped mechanisms; do not globally disable shared triggers or perform
shared-table DDL in parallel suites. Resolve flakiness rather than hiding it behind
unexplained retries. No finding is fixed without evidence and a regression check.

Objective
Attack the full module before release.
Claude Code prompt
PHASE 13 — PERFORM FULL LABORATORY ADVERSARIAL SECURITY REVIEW
Do not review only the UI.
Attack through:
- API
- server actions
- direct database access
- Supabase/PostgREST
- guessed IDs
- manipulated request bodies
- manipulated query parameters
- forged clinic IDs
- forged patient IDs
- forged doctor IDs
- forged order IDs
- forged result IDs
- forged document IDs
Test:
TENANCY
- Clinic A cannot read Clinic B labs.
- Clinic A cannot write Clinic B labs.
PATIENT AUTHORIZATION
- Patient A cannot access Patient B's result.
- Patient cannot access another patient's document.
DOCTOR AUTHORIZATION
- Doctor A cannot modify laboratory results merely through doctor or longitudinal-read permissions.
- Doctor A cannot create orders for unauthorized patients.
- Doctor A cannot exploit longitudinal access to gain write permission.
LAB STAFF
- Lab staff cannot access unrelated financial/admin information.
- Lab staff cannot alter payment status.
PAYMENT
- client cannot forge paid state
- client cannot forge amount
- refund state cannot be fabricated
RESULTS
- finalized result cannot be silently overwritten
- version history cannot be rewritten
- unauthorized verification fails
- stale-version correction fails
IMPORT
- imported clinic_id cannot be forged
- imported patient mapping cannot cross clinics
- import cannot overwrite another clinic
FILES
- result document URLs cannot be guessed to bypass authorization
- signed/public URL misuse must fail
EXTERNAL LAB
- provider callback cannot inject result into another clinic
- duplicate callback is idempotent
AI
- patient A context cannot reach patient B
- clinic A context cannot reach clinic B
- imported text cannot execute prompt-injection behavior
For every real finding:
1. Reproduce it.
2. Fix it.
3. Add regression test.
4. Document it.
Create:
docs/labs/SECURITY_REVIEW.md
Definition of Done
[ ] Security findings reproduced and resolved with regression evidence
[ ] Direct database/RPC, release, document and identity attacks tested
[ ] SECURITY_REVIEW.md records findings and verification limits

PHASE 14 — FULL E2E + PRODUCTION READINESS

EVIDENCE AND RELEASE REQUIREMENTS
Report the exact commit, commands, environment and reproducible results. Run the
required npm run lint, npm run typecheck, npm test and npm run build commands.
A substituted build command is additional evidence, not a passing required gate.
Record unsupported checks as NOT VERIFIED. Apply migrations only to isolated
local/test databases for clean install and supported upgrade-path testing.
Assess the agreed core release separately from deferred optional modules; list
excluded features and blockers. Validate backup/recovery, retention decisions,
wrong-attachment retirement, withdrawal, human escalation and notification
uncertainty handling. No production deployment or migration is authorized here.

Objective
Validate the entire system as one coherent workflow.
Claude Code prompt
PHASE 14 — FINAL LABORATORY END-TO-END QA AND PRODUCTION READINESS REVIEW
Run the full laboratory lifecycle.
NORMAL FLOW:
Patient
→ Doctor consultation
→ Doctor orders laboratory test
→ Payment according to clinic policy
→ Sample collection
→ Processing
→ Result entry
→ Verification
→ Result ready
→ Longitudinal patient history
→ Doctor notification
→ Patient Telegram notification
→ Patient result view
→ Secure document access
→ AI summary only if separately authorized; otherwise verify existing booking-only AI remains isolated from lab data
Test both:
- online workflows
- operational/front-desk workflows
- laboratory workflows
- doctor workflows
- patient workflows
Test failure paths:
- cancelled order
- unpaid order
- payment failure
- refund
- sample failure
- duplicate sample
- duplicate result
- invalid result
- verification race
- correction race
- patient mismatch
- cross-clinic mismatch
- inactive test
- inactive user
- missing verifier
- failed Telegram notification
- AI unavailable
- AI disabled
- malformed import
- duplicate patient
- unmatched patient
- provider integration failure
Run:
- unit tests
- DB tests
- RLS tests
- authorization tests
- integration tests
- E2E tests
- concurrency tests
- migration tests
- import tests
- lint
- typecheck
- build
Then review:
DATABASE
- migration order
- indexes
- constraints
- RLS
- transaction safety
APPLICATION
- API authorization
- validation
- rate limiting
- error handling
- idempotency
CLINICAL
- doctor ownership
- longitudinal history
- versioning
- retention behavior
PAYMENT
- authoritative payment state
- receipts
- refunds
DOCUMENTS
- secure storage
- authorization
NOTIFICATIONS
- retries
- idempotency
AI
- safety boundaries
- fallback behavior
IMPORT
- identity reconciliation
- duplicate safety
Do not claim legal compliance.
Do not assume retention requirements.
Create:
docs/labs/PRODUCTION_READINESS.md
Classify:
READY
CONDITIONALLY READY
NOT READY
Every status must have evidence.
Do not deploy.
Do not apply production migrations.
Definition of Done
[ ] Required release commands pass on the assessed commit
[ ] Clean install and supported migration upgrade verified locally
[ ] Core lifecycle and failure paths pass
[ ] PRODUCTION_READINESS.md lists evidence, blockers and exclusions
[ ] No production migration or deployment performed

PROPOSED LAB MODULE ARCHITECTURE
The diagram below is conceptual. Diagnoses, prescriptions, treatments and imaging
are not authorized deliverables under this laboratory plan. Clinical lab branches
require gate C0; clinical AI is excluded. Reuse only systems verified by Phase 1.
After the approved phases, the proposed structure is:
                         HEALTH AI
                    Configurable Clinic OS
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
     PATIENT FLOW        CLINICAL CARE         BUSINESS OPS
          │                   │                    │
     Registration         Consultation          Kassa
     Booking              Diagnoses              Payments
     Queue                Referrals              Expenses
     Telegram             Treatments             Analytics
     Notifications        Prescriptions
                           Laboratory
                           Imaging
          │                   │
          └───────────────────┼────────────────────┘
                              ▼
                    LONGITUDINAL PATIENT
                           RECORD
                              │
          ┌───────────────────┼────────────────────┐
          │                   │                    │
          ▼                   ▼                    ▼
       LAB ORDER           LAB RESULT           DOCUMENT
          │                   │                    │
          ▼                   ▼                    ▼
       SAMPLE             VERIFICATION        SECURE STORAGE
          │                   │
          └───────────────────┼────────────────────┘
                              ▼
                         DOCTOR + PATIENT
                           ↙       ↘
                        Doctor   Telegram
                              │
                              ▼
                          AI LAYER
                 Clinic Info / Booking Navigation
                 Clinical Summaries: Separately Gated
IMPLEMENTATION DEPENDENCIES AND RELEASE SCOPE
Keep phase numbers stable; they are identifiers, not a mandatory serial schedule.
1. Phase 1: establish exact checkout, migration state and reusable capabilities.
2. Gate C0: resolve clinical scope conflict before implementing clinical data.
3. Phases 2–3: approved state model, schema, RBAC and configuration.
4. Phases 4–7: ordering, payment extension, specimens, verification, release,
   history and secure documents. Required foundations belong to these phases.
5. Phase 13 security checks run alongside every phase; repeat independently
   before the Phase 14 core release gate.
6. Phase 11 operations may follow the authoritative core domain.
7. Identity policy and reconciliation precede Phase 9 bulk import.
8. Phase 8 patient delivery requires approved release/withdrawal rules and
   reliable notification processing; it does not depend on bulk import.
9. Phase 10 external adapters are optional and require verified provider docs
   for any real integration; mocks remain development/test-only.
10. Phase 12 clinical AI is excluded under current rules. It requires separate
    explicit authorization, policy updates and security design before coding.
11. Phase 14 assesses the agreed release scope and explicitly lists exclusions.
    An optional feature is never reported as implemented merely because deferred.

NON-NEGOTIABLE PRODUCT PRINCIPLES
1. One canonical patient per clinic → one longitudinal record; never merge identities across clinics.
2. Lab is a clinical workflow inside Health AI,
   not a separate patient system.
3. Doctor ordering, laboratory processing,
   results and patient delivery use one authoritative backend.
4. Payment status is separate from clinical status.
5. Doctors retain authorship of their own clinical records.
6. Reading another doctor's record never grants write access.
7. Historical results are preserved; finalized results are versioned.
8. Reference ranges are configurable, not globally hard-coded.
9. AI remains limited to clinic information and non-diagnostic booking navigation under current project rules; clinical summaries require a separate explicit scope decision.
10. Historical migration is import + reconciliation,
    not blind database copying.
11. External laboratories map INTO Health AI's normalized model.
12. Every clinic remains isolated by server-side authorization + database/RLS.
13. Production migration and deployment are separate release gates.
