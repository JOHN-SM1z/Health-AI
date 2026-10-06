# Product decision: a clinic operating system built around arrivals

Accepted product direction from the owner's three days of customer development, 2026-10-05. This document supersedes booking-first product descriptions and the laboratory-first implementation sequence. Updated 2026-10-06: payroll is deferred; laboratory devices are integrated and validated incrementally. It does not claim that every capability below is already implemented.

## The operating model

The clinic works continuously; individual doctors and departments have their own shifts. A patient usually arrives without an appointment. Reception identifies them once, confirms identity, adds services, and issues a queue ticket. Cashiers collect against an itemized bill. Doctors see their own queue and authorized patient history. A referral directs the patient to another doctor and makes the relevant history readable immediately. It does not require accept/start/approve administration. A receiving doctor writes their own note; previous authorship stays intact.

Clinic-specific settings choose walk-in, scheduled or mixed operation. Never hard-code 09:00–17:00 as the clinic opening time; MRI/MSCT and inpatient care may operate overnight. Ticket order is arrival order within the configured queue, not a promise of an exact consultation time. Urgent clinical decisions remain human decisions.

## Essential workspaces

| Workspace | Everyday work | What completion means |
|---|---|---|
| Reception | Search by patient number/name/phone; confirm identity; register arrival; itemized services; ticket and routing | No duplicate patient entry for a return visit; no invented appointment time |
| Service kassa | Itemized charges, cash/terminal receipts, balances, refunds, shift totals | Money is recorded once; cash and terminal reconciliation are explicit |
| Inpatient kassa | Package bill, deposits/partial payments, balance, refunds | A stay's bill is distinct from an outpatient visit; no assumed daily billing rule |
| Doctors | Today's queue, history, clinician-authored notes, prescription printout, simple referral | Authorized receiving doctors see historical records; nobody rewrites another author's note |
| Inpatient care | Occupied/free beds, admission, ward/ICU transfers, discharge, tablet history | Search shows where a patient is now; two admissions cannot occupy one bed |
| Laboratory | Ordered tests, collection, processing, verified release, print/download | Partial orders and ready results are explicit; no promise of instant or AI-interpreted results |
| Management | Collected cash, receivables, refunds, expenses and doctor workload | Monthly totals reconcile; collected money is not mislabeled profit or earned revenue |
| Communications | Department directory, hours/prices/preparation information, human handoff, ready-result alerts | Contact channels reduce reception interruptions and report actual delivery status |

## Simplifications

- Make arrival registration/live queue the primary reception screen; move scheduled booking/calendar into optional clinic configuration.
- Keep one patient identity, one source of prices, one billing history and attributed clinical history.
- Referrals need patient, receiving doctor and a short purpose. A note/context is optional; there is no mandatory acceptance or consultation-start ceremony. Revocation remains necessary for mistaken referrals. Old statuses remain readable for compatibility.
- Keep separate registration and cashier permissions even when a small clinic assigns both to one staff member.
- Separate administrative routing from clinical priority. Do not automatically triage patients or deduct staff wages for routing mistakes.
- Remove generic AI/lab-provider expansion from the critical path. Do not build a speculative MedPlus/eHealth/Mehmon integration. Documented adapters or reviewed exports can come later.
- Clinical history and staff-entered prescriptions are authorized; AI diagnosis, prescribing and clinical summaries are not.
- A payment warning may guide an elective workflow. Reading historical records must not be hidden behind payment; any configured clinical-work gate needs an authorized audited exception.
- Printing an internal payment acknowledgement is not claiming a fiscal receipt or card-terminal integration. Two physical receipts on card transactions do not mean two payments.

## Money definitions and policy inputs

Maintain itemized quoted charges and their price snapshots. Record cash/terminal settlement and refund transactions; never trust a browser's paid flag. Support partial settlement and authorized discounts without rewriting original charges. Expenses must have category, date, actor, approval and an audit trail. Keep amounts in the clinic currency with exact decimal arithmetic.

Payroll, employee compensation formulas, accruals and payouts are outside the current release. The clinic retains its existing payroll process. Doctor workload shows visits/services and waiting times; it is not a clinical quality score or wage calculation. Do not implement automatic penalties. A future payroll module requires a separate scope decision and actual clinic formulas.

Inpatient package prices do not automatically increase with nights stayed. Configure package inclusions, additional charges and early-discharge/refund policy explicitly. Preserve transactions across transfers and corrections.

## Evidence and measurement

The observations are exploratory, not a representative time-and-motion study. Preserve registration, paper-history creation, call duration and waiting time as separate measurements; do not add them without evidence they occur sequentially for the same patient. The two interviewed doctors have low volume; findings do not represent the busiest doctors. The reported 60% coverage is the manager's estimate. Calls, patient arrivals and unfinished lab orders need measured baselines before promising savings.

Track registration completion time, queue wait, cashier wait, duplicate-identity corrections, wrong-service corrections, unfinished orders, unmatched cash/terminal totals, missed inquiries and time spent preparing the monthly expense report. Display data freshness and downtime clearly. Never show a queued/offline write as saved; uncertain payment retries must be idempotent.

## Replacement release gates

The current target is operational replacement for private clinics, with payroll explicitly excluded. Verify reception + kassa + inpatient location + clinical history + laboratory order/result delivery + monthly expenses together before retiring the corresponding existing tools. Keep the existing payroll process; do not claim complete Excel replacement. Import/reconcile identities and balances with previews; perform a clinic-led parallel reconciliation and a rollback rehearsal. External government systems remain external until actual interfaces and obligations are confirmed. No production migration or deployment is authorized by this code revision.


## Automation and analyzer rollout

Automate repeated data entry, routing, charge calculation, specimen tracking, device result ingestion and delivery after authorized release. Clinical decisions, result verification and unresolved exceptions remain with qualified staff. Measure coverage per workflow and per connected device; do not promise unattended clinical care or universal device compatibility.

Build one laboratory order/specimen/result core, then add reusable adapters and clinic-specific mappings. Validate each analyzer installation and software version before enabling it. Existing vendor middleware may provide a shared connection; inspect it before proposing a separate connector for every machine. See [the device integration plan](labs/DEVICE_INTEGRATION_PLAN.md).
