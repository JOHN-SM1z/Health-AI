# Laboratory Module — Phase 3 Roles and Permissions

Status: **implemented and tested locally; not deployed.**

## Role decision

The existing roles could not carry lab work safely: receptionists must never
see result values (O5), and doctors' clinical access is per patient, not per
clinic. A new `staff_role` value **`lab`** ("Laboratoriya") is added
(`20261005000005_lab_staff_role.sql`). There is no separate verifier role:
verification is a capability of lab staff and doctors, and the database
already requires a second person (O4). `staff_roles` stays one role per person
per clinic.

## Capability model — `src/lib/labs/permissions.ts`

| Group | Capability | Roles |
|---|---|---|
| Configuration | `catalog.configure`, `settings.configure` | owner, manager, admin |
| Operational | `catalog.read`, `order.create`, `order.cancel` | every clinic role |
| | `order.status.read` | owner, manager, admin, receptionist, lab, doctor (doctor per patient) |
| | `sample.collect` | receptionist, lab |
| | `sample.process` | lab |
| Clinical | `result.enter`, `result.verify`, `result.read` | lab, doctor (doctor per patient) |
| Financial | `finance.view` | owner, admin (= existing `canViewPaymentDynamics`) |

Server enforcement:
- `requireLabCapability(capability)` (`src/lib/labs/guards.ts`) — clinic from
  the session, exact role names (never weight-based).
- `resolveLabResultAccess(staff, patientId)` — `lab` (clinic lab work),
  `doctor` (only when `doctor_patient_access()` admits: own patient or active
  referral — O3), otherwise `none` (owner/manager/admin/receptionist: status
  only — O5). Patient lookup is scoped to the session's clinic; fails closed.
- `lab` has role weight −1, so no weight-based guard (`requireStaff`,
  `hasRole`) ever admits it; existing admin, desk and doctor routes refuse lab
  staff (tested).

Database (`20261005000006_lab_role_access.sql`): RLS backstop policies let
lab staff read their clinic's orders, items, samples and sample links; result
tables keep RLS without policies. An audit of every existing policy found that
patients, appointments, payments, conversations, messages, voice, notification
jobs, analytics and audit all name their roles explicitly, so `lab` gains no
access there; lab staff, like every staff role, can read clinic reference data
(services, doctors, specialties, schedules, FAQs, staff names, clinic settings).

UI (convenience only): the owner can assign the lab role on the staff page;
lab staff land on a new `/lab` workspace (work queue arrives in Phase 7);
`/admin` sends lab-only sessions to `/lab`; `/lab` sends everyone else back.

## Tests

- `src/lib/labs/permissions.test.ts` — the decision table as requirements.
- `src/lib/labs/guards.test.ts` — anonymous / platform admin (401), wrong
  role (403), cross-clinic patient, doctor with and without a relationship,
  unlinked doctor, management roles never get values, fail-closed.
- `src/lib/auth/guards.test.ts`, `staff.test.ts` — lab staff refused by every
  existing management / desk / doctor guard; routed to `/lab`.
- `src/lib/supabase/lab-domain.test.ts` — lab staff run the work end to end
  with a second lab person verifying; another clinic's lab staff cannot verify;
  backstop visibility of the work queue (own clinic only, never result rows);
  no rows from patients, appointments, payments, conversations, messages,
  audit, analytics, notification jobs or voice; no direct writes; a result's
  author cannot be reassigned.

Local results: `npm test` 480 passed / 0 failed (287 REST-API cases skipped
locally, run in CI), lint, typecheck, build, `full-db-setup --check` clean.

Patient-facing access (patient A requesting patient B's result) is enforced
when the patient result routes exist (Phase 12); today no patient-facing code
can reference result tables (`clinical-isolation.test.ts`).
