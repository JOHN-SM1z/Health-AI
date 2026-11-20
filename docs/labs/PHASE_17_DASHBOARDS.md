# Laboratory Module — Phase 17 Lab Dashboards

Status: **implemented and tested locally; not deployed.**

## On the existing architecture

- **UI:** the existing admin UI kit (`PageHeader`, `Card`, `StatCard`, `ABadge`, `ATable`, `AEmpty`, `AError`, `LoadingRow`) and the analytics page's bar style. No new visual system and no chart library.
- **Analytics:** the lab aggregator `aggregateLabOrders()` sits next to `aggregateAppointments()` in `src/lib/analytics` and follows its rules:
  - a pure function over rows;
  - revenue is recognised only when the work was delivered and paid;
  - a refund drops out automatically;
  - buckets by clinic-local day, ISO week and month (reusing `weekKeyFromDayKey` and `monthKeyFromDayKey`).
- **Shared period:** the period parameters (`range`, or `from`/`to` in the clinic's timezone) moved into `src/lib/analytics/range.ts`. The existing analytics route and the new lab route both use it.
- **Permissions:** the existing role checks, unchanged:
  - `queue.read` for the work view;
  - `requireLinkedDoctor` + `doctor_patient_access()` for doctors;
  - the analytics roles (owner, admin, manager) for management;
  - `canViewPaymentDynamics` (owner, admin) for money.

## Dashboards

| Who | Where | Shows |
|---|---|---|
| Lab staff (and every `queue.read` role through the API) | **Laboratoriya → Ko‘rsatkichlar** (`/lab/dashboard`) | Active orders; open tests by stage, each with its longest wait; tests verified today and in the last 7 days; open tests past the test's target turnaround; open work by department. **Status only:** no patients, no values, no money. |
| Doctor | **Shifokor paneli → Laboratoriya** (`/doctor/lab`) | **My lab orders** (30 days); **pending results** (tests I ordered, not yet verified); **recent patient results** (verified, 30 days, with how many values fall outside the range); **values outside the configured range**, critical first; **comparable tests** (the same test done before for the same person, with the earlier date, linking to the patient's trend). |
| Manager | **Boshqaruv → Laboratoriya tahlili** (`/admin/lab-analytics`) | Test volume (by test, department, day, status and source); current workload; turnaround (median and 90th percentile, order → verified and collection → verified, on time / late against each test's target, per test); cancelled orders with reasons; repeat-test patterns. **The money section is closed.** |
| Owner, administrator | the same page | Everything the manager sees, plus **laboratory revenue**: recognised (delivered), paid but in progress, paid for cancelled tests (to refund), refunded, unpaid, pending, average paid order; revenue **by test**, **by department** (lab category) and over time (day / week / month). |

Every page has the four states: **loading**, **empty** (per section), **error**, and **permission** ("Bu sahifani ko‘rish uchun ruxsat yo‘q" on a 401/403, e.g. a receptionist typing the address). The management link appears only for owner, admin and manager. Lab and doctor pages refresh every minute; each has a refresh button.

## Rules

### Revenue comes from payment records, never the catalog
The source is the lab order's payment (`payments.lab_order_id`, Phase 6).
- **Recognised revenue:** a test's share of a **paid** payment, once the test is **verified** — the lab equivalent of "completed and paid".
- **Allocation:** the paid amount is split over the tests it paid for by the prices **stored on the order** (`price_snapshot`, which already holds a panel's allocated share).
  - Tests cancelled *before* payment were never billed and get no share.
  - If the stored prices do not add up to the amount paid, the shares are scaled, so the figures always add up to the money received.
- **Paid money is split three ways that always sum to the paid total:** delivered, in progress, and to refund.
- **Catalog prices are not used.** Changing a catalog price later changes nothing; this is tested.
- **Failed attempts** count in no total, as for appointments.

### Who sees money
Money follows the existing payment roles (owner, admin). A manager's response has `finance: null`; the test checks that no money field or amount appears anywhere in it.

### Doctors see only their patients
- Every patient on the doctor's page passes `doctor_patient_access()` (own patient, or an active, unexpired referral). This is checked **in the database for the whole set** by a new helper, `lab_doctor_accessible_patients()`, on every request.
- When a referral is revoked, its patient disappears at once, even from the doctor's own past orders.
- Never clinic-wide.

### Values and audit
- Values appear only on the doctor's page, for those patients, as **placement against the configured range**. There is no interpretation and no alerting; critical-result alerts remain deferred.
- Every result shown to a doctor is **audited**: `lab_result_viewed`, via `doctor_dashboard`, ids only, strict.

### Management and lab views carry no patient data or values
- These views never select a value, flag, comment, document, clinical text or a patient's name or identifiers. A source guard test (`dashboard-isolation.test.ts`) enforces this.
- Patients appear only as an opaque per-person key (the canonical record after a merge) used to count repeats. That key is never returned.

### What is counted
- Historical imports (`external_import`) are not clinic activity and are left out of every figure.
- Each open test is counted in exactly one stage:
  - **awaiting collection** — ordered or ready for collection;
  - **collected, not started**;
  - **awaiting entry** — in the lab, no result started;
  - **in progress** — a draft result, or the test is at an external lab;
  - **awaiting verification**.
- **Turnaround** ends at the test's first verification. A later correction does not move it.
- **Repeats:** the same person and the same test within 30 days, including an order placed just before the period starts.

## Pieces

| | |
|---|---|
| `20261005000020_lab_dashboards.sql` | `lab_doctor_accessible_patients(clinic, doctor, patient_ids[])` (security invoker, service role only, at most 5000 ids, active doctor of the clinic); indexes on orders by date, orders by ordering doctor, and current verified results by time |
| `src/lib/analytics/lab.ts` | `aggregateLabOrders()`, `allocatePayment()`, `durationStats()` (pure) |
| `src/lib/analytics/range.ts` | the shared period parser (the existing analytics route now uses it too) |
| `src/lib/labs/management-analytics.ts` | rows for the aggregator: orders, tests, statuses, times, payments and canonical patient keys only |
| `src/lib/labs/workload.ts` | the current work by stage |
| `src/lib/labs/doctor-dashboard.ts` | the doctor's view, access-filtered and audited |
| `src/lib/labs/paged.ts` | page-by-page reads (the API returns at most 1000 rows per request) |
| Routes | `GET /api/lab/dashboard` (`queue.read`), `GET /api/doctor/lab/dashboard` (linked doctor), `GET /api/admin/analytics/lab` (owner/admin/manager; money for owner/admin) |
| UI | `src/components/lab/dashboard-ui.tsx` (data loading, states, bars), `workload-panel.tsx`; pages `/lab/dashboard`, `/doctor/lab`, `/admin/lab-analytics`; navigation links |

## Tests

| Suite | Covers |
|---|---|
| `src/lib/analytics/lab.test.ts` (10) | Revenue at the paid amount, never the catalog price. The three-way split adds up to the amount paid. Tests cancelled before payment are not billed. Scaling. Unpaid, pending, failed and refunded payments are never revenue. Clinic-local day, week and month buckets. Volume, cancellations and reasons. Turnaround median, 90th percentile and on time / late. Repeats, including the look-back window. No patient key in the output. |
| `src/app/api/lab/lab-dashboards.test.ts` (8) | Real database and routes. **Lab staff:** exact stage counts, completed counts, departments, no names, values or money; the other work-queue roles; another clinic sees only its own work; doctors 403, anonymous 401. **Doctor:** own orders and pending tests; only own patients' results; the value outside the range; the comparable earlier result; audit rows; an active referral adds a patient and revoking it removes them at once; non-doctors, unlinked doctors and another clinic 403. **Owner and admin:** revenue 1000 from the payment after the catalog price changed to 99 999; in progress 1500; unpaid 5000; revenue by test and department. **Manager:** volume, cancellations, turnaround, repeats and workload; `finance: null`; no amounts, names or values. **Others:** receptionist, lab and doctor 403; anonymous 401; a reversed custom period 400; an empty period. |
| `src/lib/labs/dashboard-isolation.test.ts` (5) | The management and workload readers never reference values, flags, comments, documents, clinical text or patient identity |
| `e2e/lab-dashboards.mjs` (10) | Browser. **APIs:** need a session. **Lab staff:** the work by stage, no names or values. **Doctor (phone):** sees the value outside the range with placement wording only, and the entry opens the patient. **Manager:** sees volume, and the money section is closed. **Owner:** sees revenue by department from the payment. **Receptionist:** has no link, and the address shows the permission state. |

Also fixed: `e2e/lab-import.mjs` checked an imported date-only row against a fixed UTC instant. The demo seed chooses the clinic's timezone by the time of day, so the check failed in the afternoon (UTC). It now compares noon in the clinic's timezone.

Local run after a clean `supabase db reset`:
- `npm test`: **973/973** across 102 files (twice).
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, patient merge 14/14, lab external 13/13, lab notifications 7/7, **lab dashboards 10/10**, HTTP red team 55/55.
- Lint, typecheck and build pass; `full-db-setup.sql` regenerated.

## Not built / decisions

- **Per-person staff throughput** (results entered or verified per technician) is not shown. It is easy to add from existing columns, but it is staff-performance monitoring and should be a clinic decision.
- **Revenue for managers:** hidden, following the existing payment roles. Showing it is a one-line change to `canViewPaymentDynamics` if the clinic wants that.
- **Revenue timing:** revenue is attributed to the day the order was placed, matching how appointment revenue uses the visit day. Attributing it to the payment day would be a reporting choice for the owner.
- **Critical-result alerts:** still deferred. The doctor's page lists critical values first but sends no alert.
- **Department** means the test's current lab category. Categories are not snapshotted on orders.
