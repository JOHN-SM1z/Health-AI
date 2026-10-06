# Clinical governance review

2026-09-28. Base: `origin/claude/clinical-records-governance`, `a77a4aa`.

The repeated brief was identical to the previous attachment. After fetching the repository, this newer implementation was found. It is the base of this review; the earlier local implementation (`7023f6a`) remains separate. Do not apply both alternative `20261001000001` migrations.

## Audit before changes

1. **Architecture:** appointments remain consultations; typed clinical_records hold notes, diagnoses, assessments, prescriptions, lab orders/results and follow-up/history. No parallel clinical schema is needed.
2. **Ownership:** explicit doctor, login, clinic, patient and consultation attribution. Composite FKs, clinical validation and the doctor re-link guard preserve authorship.
3. **Editing/deletion:** immutable rows with version/root_record_id and a unique correction chain; only the same doctor/login can append a correction. Stale versions are rejected. Normal reads filter current versions before pagination; history is separate.
4. **Referral:** existing doctor_patient_access scope admits only relevant consultations/referring-doctor records; the recipient creates their own consultation. Expiry/revocation and unrelated financial/operational exclusions are already implemented.
5. **RLS/RBAC:** linked-doctor server guard plus tenant scope and database policies/triggers. Signed-in users cannot directly read clinical tables or mutate them. A service-only view supports audited reads. Idempotency replay precedes current authorization and does not filter the original login.
6. **Audit:** transactional clinical/referral mutation events, strict workspace/history/referral read events, denied correction/history attempts. Current workspace access logs omit own record IDs, making exact reconstruction of their read set incomplete.
7. **Deletion/privacy:** four patient FKs no longer cascade, but communications still cascade from patient deletion, payments from appointment deletion, and clinic deletion can erase the whole audit/clinical history. Retention rules exist but no executor or legal periods are assumed. Privacy describes clinical storage, corrections and separate retention; opening wording still describes all collection as booking-only.
8. **Changes required:** authorize before replay and bind replay to login; preserve independent retention across remaining destructive parent paths; include all released record IDs in read audits; exercise actual UI edit/save/history/conflict behavior and real SQL locally. Retain the current schema/workflows instead of merging the older alternative implementation.

No deployed database connection is configured; this audit describes source and migrations, not a live schema. Live Supabase/Auth/PostgREST and authenticated browser verification remain separate gates.

## Additional brief: referral and longitudinal history — audit before changes

The subsequent brief changes the access policy: a referral is a care handoff; its acceptance cannot gate history or treatment. A later doctor assigned a legitimate visit must see the same patient's prior clinical history. Clinic membership alone must still grant nothing.

- Reuse `patients.id`, receptionist patient search/booking, `appointments`, `referrals`, `clinical_records` and their existing authorship/version fields. No duplicate patient or parallel referral schema.
- Replace the narrow author-based history arrays in `doctor_patient_access` with the patient's historical authors/consultations, only after a valid same-clinic care relationship. Exclude cancelled/no-show-only assignments; keep actual authored care as a relationship.
- Pending, accepted and in-progress unexpired referrals establish that relationship immediately. Referral closure removes referral-only access, but does not revoke an independent assigned visit or actual care relationship.
- Consultation start currently links accepted referrals only; make the receiving doctor's start acknowledge and link a pending handoff in the existing transaction/state machine.
- Patient workspace can show past referrals as read-only clinical history to later treating doctors; referral inbox/actions remain participant-specific. Add a specialty/department filter using the existing doctor catalog.
- Update the project rules and privacy wording explicitly to match this user-authorized change; keep the same doctor AND login correction rule and clinical isolation from operational staff, patients and AI.

## Existing project-rule changes

Upstream commit `a77a4aa` changed AGENTS.md: it explicitly bound corrections to the same doctor AND login, required new assessments for other doctors, prohibited patient erasure cascades into retained domains, and prevented re-linking a doctor with another login's clinical records. This review additionally updates AGENTS.md, explicitly authorized by the subsequent longitudinal-history brief: pending referrals, assigned visits and authored care release same-clinic longitudinal history, and parent deletion cannot silently erase other retained domains. CLAUDE.md is unchanged.

## Implemented result

- **One patient identity and history:** existing receptionist lookup and appointments remain the source of treatment assignment. The same patient ID carries past consultations and current clinical record versions to a future Doctor C. No new patient, clinical record or referral table was introduced.
- **Care access:** `doctor_patient_access` requires an active linked doctor with the clinic's doctor role and a same-clinic assigned visit, authored care, or pending/accepted/in-progress unexpired incoming referral. No-show/cancelled-only assignments do not count. Every legitimate relationship opens the patient's longitudinal consultations and clinical history. Clinic membership alone and cross-clinic requests remain insufficient.
- **Referral workflow:** a pending handoff releases history immediately. Reception may schedule its follow-up before acknowledgement. Starting the consultation as the receiving doctor acknowledges and links the handoff transactionally. Acceptance/status buttons remain care tracking. Referral-only access ends on closure or expiry; independent care continues. Historical referrals appear read-only in the patient workspace for subsequent treating doctors; participant actions retain their existing ownership checks.
- **Doctor interface:** specialty/department filtering reuses the doctor catalog. Existing incoming/outgoing referral pages, consultation timeline, author/date labels, current/historical categories, current-only normal views, and read-only correction history remain in use. Pending-referral blocking copy is removed.
- **Governance:** corrections still require the original doctor AND login, append a version and preserve prior text. A colleague records an independent assessment in their own consultation. Authorization now precedes idempotency replay, and replay lookup includes the original login. Audit records include every released current record ID and distinguish direct care from referral-only access, without clinical content.
- **Independent retention:** patient deletion cannot cascade communications; appointment deletion cannot cascade payments; clinic deletion cannot cascade the clinical/referral/booking/payment/communication/audit domains or their retention policy. Existing per-category policy configuration remains empty by default, with no new deletion executor or assumed legal retention period. Local fixture cleanup explicitly removes synthetic domains, rather than relying on production erasure cascades.
- **Policy wording:** AGENTS.md and the privacy page now describe the requested longitudinal care policy. Clinical text remains excluded from operational staff, patients, the bot, AI, analytics and logs. CLAUDE.md was not changed.

## Verification

| Check | Result |
|---|---|
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm test` | 343 passed, 413 skipped; 43 suites passed, 34 skipped |
| `npm run build` | Passed, optimized Next.js build |
| `git diff --check` | Passed |
| Full setup script | Regenerated from all 50 migrations |

31 added tests run without an external Supabase instance:

| Layer | Coverage |
|---|---|
| Embedded PostgreSQL: 15 tests | All actual migrations; author/login/version enforcement; pending referral full history; pending follow-up scheduling and doctor start; independent B assessment; future C visit on the same patient; unrelated/cross-clinic/inactive/non-doctor denials; expiry and revoked/cancelled/no-show-only denials; immutable audit/version state; operational/anonymous clinical isolation; parent deletion protection and explicit fixture cleanup |
| Server boundary: 11 tests | Forged foreign-author correction; session provenance; stale/concurrent-conflict mapping; appointment/type immutability; current filtering before limits; invisible history denial; mandatory audit failure; authorization before replay; login-bound replay; direct-care history audit |
| Real client components: 5 tests | Edit/save/current-only display and read-only old versions; future treating-doctor provenance without foreign edit controls; 409 draft preservation and retry on the current version; start from pending referral without accept; department-filtered referral creation using the existing consultation |

The existing integration assertions and browser referral workflow were updated for the new access policy. They are **not claimed as executed**. The 413 skipped tests require local Supabase/PostgreSQL/Auth/PostgREST; there is no configured/running instance here. Embedded PostgreSQL uses small stand-ins for Supabase Auth and Storage schemas and does not replace those end-to-end checks. The browser workflow additionally needs the seeded authenticated app. Concurrent HTTP requests against PostgREST and live visual/mobile QA remain release gates.

## Delivery and migration notes

Work is on local branch `clinical-governance-review`, based on `a77a4aa`. Nothing was pushed or deployed. This branch keeps the upstream `20261001000001_clinical_record_governance.sql` and adds:

1. `20261001000002_longitudinal_care_access.sql`
2. `20261001000003_independent_retention.sql`

Apply migrations to the intended test/staging database before testing the updated app. Do not combine the alternative earlier local `7023f6a` migration with this branch. Retention changes intentionally make generic parent deletion fail while retained child data remains; review any external erasure tooling before release. No actual patient records or external accounts were touched.
