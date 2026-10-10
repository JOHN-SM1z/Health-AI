# Product decisions — retention, clinic termination, cross-clinic history, refunds

**Status:** decided by the product owner on 2026-10-07. Not yet implemented; see "Gap" under each decision.
**Scope note:** these are product and architecture requirements. Whether applicable law permits or requires
something different is a separate legal review. This document does not state or assume any legal retention
period, and nothing here is a claim of legal compliance.

## Decision summary

| Area | Decision |
|---|---|
| Clinical records retention | Indefinite |
| Lab results retention | Indefinite (orders, results, versions, related records) |
| Automatic deletion | None, no age-based deletion workflow |
| Patient request to delete clinical history | Not supported as a product workflow |
| Clinic subscription ends | Operational access disabled or restricted; records preserved |
| Patient moves from Clinic A to Clinic B | Prior Health AI history available to an **authorized treating doctor** at Clinic B |
| Historical clinical records | Read-only and versioned; original author and clinic preserved |
| AI lab summary | Doctor-facing only (initially) |
| Patient lab results | Patient sees own finalized/verified results only |
| Refunds | Core Payments module; full and partial |
| Who may refund | Owner: yes. Manager: yes. Cashier: only if a manager has authorized that cashier |

Not decided, and not to be hard-coded: every doctor at every Health AI clinic seeing every historical record.
Cross-clinic access goes only to a doctor with a legitimate treating relationship, keeping tenant boundaries
and auditability.

---

## 1. Indefinite retention of clinical and lab records

**Decision**
- Clinical records and all laboratory data (orders, results, versions, documents, import evidence) are kept
  indefinitely.
- There is no automatic deletion period and no patient-initiated deletion of clinical history.

**Current state**
- The application never deletes clinical or lab rows.
  - Clinical records are insert-only.
  - Lab results are versioned.
  - Documents are withdrawn, never deleted.
- Lab tables already refuse deletion of a patient that has lab orders: the foreign key restricts it
  (`lab-domain.test.ts`).
- No retention job touches clinical or lab data. The only scheduled purge is for voice messages; voice
  messages are not clinical records and keep their own stated retention.

**Gap**
- The **database still allows clinical history to be destroyed by a cascade**:
  - `clinical_records.clinic_id → clinics ON DELETE CASCADE`;
  - `clinical_records (patient_id, clinic_id) → patients ON DELETE CASCADE`;
  - `appointments`, `payments` and `conversations → patients ON DELETE CASCADE`.

  No application route issues these deletes, but a manual `delete from clinics` or `delete from patients`
  would silently erase history.

**Built (2026-10-08, `20261008000004_retention_guard`)**
- The database refuses `DELETE` and `TRUNCATE` of `clinics`, `patients`, `clinical_records` and `referrals`.
  - It uses guard triggers, errcode `42501`, hint `retention`.
  - With clinics and patients undeletable, none of the cascades above can run.
  - Lab data, visits, the kassa ledger and the audit trail were already protected.
- **Why not RESTRICT on each foreign key** (the original proposal): about 60 test suites clean up by deleting
  the clinic they create. RESTRICT would also not stop the `postgres` role.
- **Instead, one guard with an explicit test-database marker.** A row in `internal.retention_override` is
  seeded only in local and CI databases (`supabase/seed.sql`).
  - No migration inserts it.
  - The production setup file does not contain it.
  - No API role can read or write the `internal` schema.
  - Staging and production must keep it empty; the runbook checks this.
- **Tests:** `retention-guard.test.ts`. Each refusal is checked with the marker removed inside a rolled-back
  transaction, which is exactly the production behaviour.
- **What it does not stop:** the database owner can still disable triggers. The guard protects against the
  app, a leaked service key and accidental SQL.

## 2. Clinic subscription termination

**Decision**
- Terminating a subscription disables or restricts the clinic's operational access.
- Patient, clinical and lab records are never destroyed because a subscription ended.
- What former staff may still access is to be designed separately.

**Current state**
- `clinics.is_active` exists and the platform admin can toggle it (`/api/platform/clinics`).
- The flag is consulted in two places:
  - the database booking engine, which refuses new appointments for an inactive clinic;
  - picking the default clinic for patient-facing pages (`src/lib/clinics/context.ts`).
- Staff sign-in, the admin, doctor and lab workspaces, and the clinic's Telegram bot **do not check it**.
  So a deactivated clinic keeps its staff access.

**Proposed change**
- Add an explicit lifecycle: `active → suspended → terminated`, with a timestamp and the platform user
  who changed it.
- Staff of a non-active clinic are refused at the session layer.
- The clinic's bot tells patients the clinic is unavailable; booking is already refused by the database.
- Notification jobs for the clinic are not sent.
- Data is untouched.
- Post-termination read access for former staff stays out of scope until designed, as decided.

## 3. Patient history across clinics (Clinic A → Clinic B)

**Decision**
- A patient's Health AI history is not trapped in the clinic that created it.
- An authorized treating doctor at Clinic B can read relevant prior history from Clinic A, and can write
  new records in their own consultation.
- Doctor B can never modify Clinic A's records; corrections create new versions.
- Original authorship and clinic stay attached.
- Operational staff never gain cross-clinic clinical access.

**Current state (deliberately the opposite today)**
- Patients are per clinic: `patients.clinic_id`, with Telegram identity resolved per clinic bot.
- Doctor access is limited to the doctor's own clinic through `doctor_patient_access()` (RLS) and
  `canDoctorAccessPatientClinicalData()` (server): their own patient, or an active referral to them.
- Patient merges (`merge_patients()`) link records **within one clinic** only.
- `AGENTS.md` requires every tenant-owned query to scope by `clinic_id`.

**This is a change of the core security model.** It needs its own design phase before any code. In
particular:

1. **Patient identity across clinics.**
   - Clinic B's patient row must be linked to Clinic A's with certainty.
   - Phone or name matching is unsafe: a wrong link exposes one person's history to another person's
     doctor.
   - This depends on the open B2 decision (PINFL/passport), or on a patient-confirmed link, for example
     the patient approving it in Telegram.
2. **What a "legitimate treating relationship" at Clinic B is.**
   - Proposed: Doctor B has a current or recent appointment or consultation with that patient at Clinic B.
   - Access would be checked against the database clock on every read, like referral access today, and
     never permanent.
3. **Whether the patient must agree** before history crosses clinics, and whether they can see who read
   it. This is a product choice and part of the legal review.
4. **What "relevant" history means**, for example:
   - all clinical records and finalized lab results; or
   - a summary set (diagnoses, allergies, finalized labs) first.
5. **Audit.**
   - Every cross-clinic read is audited (ids only).
   - It is visible to Clinic A's owner and, if decided, to the patient.
6. **Former clinic terminated.** Clinic A's records stay readable to Clinic B's treating doctor even
   after Clinic A's subscription ends (follows from decisions 1 and 2).

**Proposed approach (for review, not built)**
- A platform-level `patient_identity` that links per-clinic patient rows, created only by a verified
  identifier or patient confirmation.
- A new `doctor_cross_clinic_access()` check alongside `doctor_patient_access()`, granting **read-only**
  access to linked records at other clinics while the treating relationship holds.
- The server reads cross-clinic records through a dedicated, audited path. Records render with their
  original author and clinic.
- `AGENTS.md` is updated to state the new rule in place of "never grant doctors access outside their
  clinic". It is updated together with the code, not before.

## 4. Refunds in the core Payments module

**Decision**
- Full and partial refunds, recorded with:
  - reason;
  - amount;
  - who authorized it;
  - who executed it;
  - when.
- Owner and manager may refund.
- A cashier may refund only if a manager has authorized that specific cashier. The system keeps who
  granted the permission and who executed each refund.

**Current state**
- A refund is a payment status change `paid → refunded`, on:
  - appointments: `/api/admin/appointments/[id]/payment`;
  - lab orders: `/api/admin/lab/orders/[id]/payment`.
- Allowed roles are **owner and admin**. A manager cannot refund today.
- Full refunds only: no amount, no reason field, no separate refund record. It is audited as a status
  change.
- There is no `cashier` role. Desk work uses `receptionist` (and `lab` for the lab desk).
- Only `manual` payment mode is production-usable. Provider refunds (Click/Payme) do not exist.

**Proposed change**
- A `refunds` table (append-only), linked to the payment, holding:
  - kind: full or partial;
  - amount, which must not exceed the paid amount minus earlier refunds;
  - reason;
  - `authorized_by`, `executed_by`, `created_at`.
- Payment status becomes `refunded` when fully refunded, or `partially_refunded` when not.
- A `refund_grants` table: manager or owner → named cashier, with `granted_by`, `granted_at`, `revoked_at`.
- The refund RPC checks the role or an active grant **inside the database**. The server checks it too.
- Receipts and analytics reflect the net amount.
- Every refund and every grant or revocation is audited (ids only).

---

## Follow-up answers (2026-10-07)

1. **Cashier.** A new `cashier` staff role. It is not the existing receptionist or lab role.
2. **Refund rights.**
   - Owner and manager only.
   - The `admin` role **loses** the refund right it has today.
   - A cashier refunds only with an active grant from a manager or owner.
3. **Cross-clinic identity.**
   - A verified ID (PINFL/passport) links the patient's records automatically.
   - Where no ID is available, or the match is uncertain, the patient confirms the link in Telegram.
   - **Never** link automatically on name or phone alone.
   - Ambiguous matches go to patient confirmation or manual reconciliation.
   - This settles the B2 decision: PINFL/passport is collected as a verified identifier.
4. **Consent for cross-clinic access.**
   - A correctly linked patient's relevant prior history is available automatically to a doctor with a
     **current treating relationship** at Clinic B. There is no per-access patient approval.
   - Every access is audited.
   - The doctor cannot modify Clinic A's records.
   - Access is limited to the appropriate clinical information.

Still to define in the cross-clinic design document:
- the exact "current treating relationship" rule, and how long it lasts;
- what counts as "appropriate clinical information".

## Identity at the desk and the Telegram queue (owner, 2026-10-08)

**Decisions**
1. **No physical ID check and no face step inside Health AI.** A patient in pain is never slowed down by
   identity.
2. **The walk-in flow.**
   - Reception types the passport/ID number (for example `AB1234567`) or JSHSHIR, and the date of birth as
     `dd.mm.yyyy`.
   - The patient's card opens.
   - Reception registers what the patient needs.
   - The patient pays at the kassa.
   - The patient follows the queue in the clinic's Telegram bot, with status updates.
3. **A returning patient without a document** is taken with "Hujjat yo‘q — davom etish".
4. **"Verified" means verified by MyID (or OneID) once it is integrated.**
   - An ID and DOB that anyone types in are a lookup key, not verification. Staff do not "verify" by looking
     at a document.
   - The automatic cross-clinic link (follow-up §3) therefore uses MyID-verified identifiers only. Until
     MyID, it uses the patient's confirmation in Telegram.
5. **The Telegram QR at the kassa follows that one visit's queue only.** That means the number, how many are
   ahead, and "you are called".
   - It does not link the Telegram account to the card. Records and lab results are not reachable through
     it, even if someone else scans it.
   - The patient scans a new QR for each visit until MyID links identity.

**What is built (`20261008000002`–`03`)**
- **Reception:**
  - passport or JSHSHIR + DOB opens exactly one card;
  - with no card, the new-patient form opens with both filled in;
  - a wrong DOB is reported and the card is not shown;
  - the previous mandatory "I checked the document" tick is removed.
- **Following the queue in Telegram:**
  - one-time links stored only as a hash, valid 24 hours, claimed once by one Telegram user;
  - `visit_followers` grants status updates for one visit;
  - "you are called" (`queue_called`) goes to the linked patient and every follower, delivered right after the
    call;
  - "🔄 Navbatim" answers with the live position.

**Not built**
- **The MyID adapter.** It needs the contract, API and test credentials. When it exists, it fills a
  first-time patient's name, JSHSHIR and sex at reception's no-card step, and records the verification.
- Whether MyID offers a lookup by passport + DOB without the person present (its web flow includes a face
  check) is for MyID/UZINFOCOM to confirm. Health AI does not query state registries on its own.
- **Unchanged:** the urgent-care message and admin escalation.

## Proposed order of work

1. Retention hardening (cascade → restrict, with tests). Small, no behaviour change for users.
2. Clinic lifecycle (suspend/terminate enforced at sign-in, bot and notifications).
3. Refunds (partial refunds, refund records, manager rights, cashier grants).
4. Patient identifiers (PINFL/passport, verified) and patient-confirmed linking.
5. Cross-clinic history: design document first (treating-relationship rule, scope of information), then
   implementation.
