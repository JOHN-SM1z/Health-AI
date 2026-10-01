# Tasks

## Active

- [ ] **Laboratory module** (branch `feat/lab-system`, on top of PR #13) - phase 1 audit and locked decisions in `docs/labs/`; phase 2 (database model, `20261003000001`) done; next: phase 3 (lab role + configuration), then 4, 6, 7, identity layer, 5, 11, 9, 10, 8, 12, 13, 14 as ordered in `docs/labs/DECISIONS.md`

## Waiting On

## Someday

- [ ] **Click / Payme payment adapters** - signature verification, idempotent webhooks, merchant credentials; only `manual` payment is production-usable
- [ ] **Production Telegram setup** - real bot tokens via `/admin/settings` and `CRON_SECRET` env before go-live
- [ ] **Referral notifications outside the app** - the receiving doctor sees a count of waiting referrals on *Yo‘llanmalar* (in-app); Telegram/e-mail delivery would need doctor accounts linked to a Telegram chat or a mail provider
- [ ] **Clinical records legal review** - doctor-authored records (notes, diagnoses, prescriptions, lab results) exist and are no longer erased with the patient (a patient with records, referrals, bookings or payments cannot be deleted); confirm the retention period per data category (to be recorded in `retention_policies`, empty today), how a patient's deletion request is handled for each category, whether existing patients need new consent, and the `/privacy` §4–§7 wording
- [ ] **Retention / erasure job** - nothing reads `retention_policies` yet; build the review/anonymise job once the policy is confirmed. Parent deletion can no longer cascade into any retained domain (`ON DELETE RESTRICT`, `20261001000003`), so a clinic or patient with such rows cannot be deleted at all and an erasure request has no executing path yet. There is no anonymisation path for patient identity yet
- [ ] **Lab integration** - lab results are typed in by doctors; no laboratory system feeds them
- [ ] **Referral privacy wording review** - `/privacy` §3/§5 describe doctor-to-doctor referrals; needs owner/legal sign-off
- [ ] **Longitudinal access model - legal/compliance sign-off** - the model is implemented (see Done, 17) but not approved for production use: who may see a patient's whole clinical history in the clinic and for how long, the permanence of a treating relationship (an appointment that is neither cancelled nor a no-show, or a record the doctor wrote keeps the whole history open to that doctor, with no expiry and no way to withdraw it for one patient), and department-wide visibility of an untaken department referral (every active doctor of the department, except the one who raised it, sees the whole history — and the referral's reason and note — from the moment it is created) all need legal/compliance sign-off before production use. No legal requirement, retention period or consent rule is assumed in code or docs
- [ ] **Longitudinal-access privacy wording review** - the patient-facing wording in `/privacy` §3 and §5 (who sees the medical history, without asking another doctor, until when, referral reasons and notes as part of it, payment status only) needs legal review before it is relied on
- [ ] **RLS cost on `patients`/`appointments` for a user who has no access** - both read policies call a function per row (`is_clinic_staff(clinic_id, …)` and `doctor_can_read_patient(clinic_id, id)`, ~1 ms per row measured on 500k patients, the same at production's current schema as with this PR), so a direct query by a token that matches few rows (a tests-style "sees nothing" scan, a non-staff user) scans the whole table slowly. The app reads these tables for staff through a LIMIT-ed path and for doctors through the server, so it is not user-visible today; fix separately by rewriting the policies in initplan form (`(select …)`), then re-measure with `scripts/rehearse-upgrade.sh`
- [ ] **Patient merge tool (later; needed before the MedPlus/Excel patient import)** - duplicates that already exist (or arise: a Telegram patient is keyed by their verified Telegram identity, not by phone, and a website booking with the same phone but another name or an existing Telegram identity gets its own record) can only be told apart at the desk; there is no way to merge two records and their histories
- [ ] **Phone normalization: country of a number typed without + or 00** - an explicit `+`/`00` is international and kept as typed, and impossible lengths match nobody (`20261002000003`), but a number typed without either is read as an Uzbek national number (9 digits, or 10 with a leading 8 or 0, get `998`); a clinic in another country, or a foreign patient who types their number without `+`, needs a per-clinic default country (the generated column cannot read another table, so it means computing it in the booking paths)
- [ ] **Existing production audit rows keep the old clinical action names (decided: keep them unchanged, new records use the new names)** - `patient_clinical_record_viewed`, `patient_clinical_access_denied`, `clinical_record_access_denied`, `clinical_record_history_viewed`, `clinical_record_accessed_via_referral`, `clinical_record_corrected` and `referral_viewed` (detail); `audit_events` is append-only, so audit queries and reports spanning migration `20261002000001` must match both names (mapping in docs/security.md)
- [ ] **Referral form footnote contradicts the model** - `src/components/doctor/referral-dialog.tsx` (form step) says only the referring and receiving doctor see the reason and note, while they are part of the patient's history read by every doctor with access (its review step says so correctly); fix the wording
- [ ] **Reception panel hides the department of an untaken referral** - `src/app/admin/patients/page.tsx` shows "Shifokor" as the recipient of a department referral nobody has taken (the API returns the department, the page type does not use it)
- [ ] **Production deploy (Phase 14)** - docs/go-live-checklist.md, docs/manual-qa-checklist.md, docs/deployment.md, docs/rollback.md ready; actual release + rollback drill not performed

## Done

- [x] ~~18. Longitudinal history on top of independent retention; identity and referral follow-ups~~ (2026-10-01)
  - rebased onto the independent-retention migration of PR #11 (`20261001000003`): deleting a clinic, a patient with conversations or an appointment with a payment is refused while those rows exist; this branch's `doctor_patient_access()` (full history) stays the one access decision, adopting #11's no-show rule; #11's signed-in SELECT policy on `referrals` is dropped (clinical text is read only through the server); fixture cleanup helpers `src/test/cleanup-clinics.ts`, `src/test/delete-appointments.ts`
  - a no-show is not a treating relationship (the visit stays in the history); reception may book the follow-up of a *pending* referral to a named doctor
  - patient creation and deletion are audited in the database (`patient_created` / `patient_deleted`, with `patients.created_by` / `created_via`; ids and channel only)
  - phone normalization never matches two different people (`+`/`00` is international, 7–15 digits)
  - department referral: refused for a department with no receiving doctor (route 409 `department_unavailable` + database trigger); flagged to the referring doctor when the department empties later
  - locked behaviour: referral controls workflow, the booking controls the treating relationship — revoking/declining a referral never cancels its follow-up booking; reception gets a derived `REFERRAL_REVOKED` / `REFERRAL_DECLINED` warning (today list, appointments list, patient panel) and decides; *Ko‘rib chiqdim* dismisses it per booking (`referral_warning_reviewed_at/_by`, audited, `20261002000005`)
  - local staging: `docs/local-staging.md`, `scripts/rehearse-upgrade.sh` (production-state schema + 500k-patient volume + every pending migration timed + structural checks); no remote staging project
  - management overview of department referrals awaiting a doctor: dashboard count (owner/admin/manager) and `/admin/referrals-awaiting` (metadata only, with revoke)
  - not done, by decision: patient merge tool (later — especially needed for the MedPlus/Excel migration, where duplicate patients are likely); old audit rows keep their old action names (history is not rewritten; new records use the corrected names)
- [x] ~~17. Longitudinal patient history, department referrals and registration dedupe~~ (2026-09-30)
  - one access decision for RLS and server: a doctor with a treating relationship (an appointment that is neither cancelled nor a no-show, or a record they wrote, permanent) or an open referral (to them, or untaken to their department; from the moment it is created, no acceptance gate) sees the patient's whole history in the clinic — every doctor's visits and records; no per-appointment scope; referral-only access ends when the referral is declined, revoked or completed and at the latest at `expires_at` (`20261002000001`, `doctor_patient_access()` / `canDoctorAccessPatientClinicalData()`)
  - department referrals: `referred_to_specialty_id`, nullable `referred_to_doctor_id`, first acceptance takes it, nobody can decline it for the others, a doctor never receives the referral they raised, one open untaken referral per department; incoming list, badge and RLS backstop for the department's doctors
  - patient profile with tabs *Umumiy*, *Qabullar*, *Klinik tarix*, *Tashxislar*, *Laboratoriya*, *Retseptlar*, *Yo‘llanmalar*; every record attributed to its author, only the author corrects it; consultations accept a pending referral automatically
  - payments: the doctor payments read policy dropped; the server shows only the payment status of the doctor's own visit
  - registration dedupe: generated `patients.phone_normalized`, reception 409 `possible_duplicate` with candidates and `confirmNewPatient`, reception search by normalized phone, quick-booking duplicate panel, web booking by normalized phone, Mini App never overwrites an existing name or phone
  - audit names: `clinical_record_viewed`, `unauthorized_clinical_access_attempt`, `unauthorized_clinical_mutation_attempt`, `clinical_record_version_created`, `referral_opened` (mapping to the old names in docs/security.md)
  - tests: `src/lib/supabase/clinical-access.test.ts`, `department-referrals.test.ts`, `src/app/api/doctor/referrals/department.test.ts`, `src/app/api/doctor/patients/longitudinal-care.test.ts` (the acceptance journey), `src/app/api/admin/appointments/registration.test.ts`, `src/lib/patients/phone.test.ts`, red team rewritten for the model; docs (security, architecture, manual QA, Supabase setup) updated

- [x] ~~16. Audit of every phase — gaps fixed~~ (2026-09-27)
  - tenant integrity: every clinic-to-clinic foreign key composite (14 were id-only: cross-clinic working hours/time blocks, conversations, messages, reminders, payments…); `messages`/`voice_messages` insert policies compared a column with itself
  - patient communication (conversations, messages, voice messages, notification jobs) written by the server only; no staff uploads into the voice bucket; SECURITY DEFINER search_path/grants normalised; structural tests
  - website booking can no longer take over or rename an existing patient (phone-only match); a Telegram patient no longer gets a stranger's reminders
  - urgent wording: approved message even in held chats, conversation flagged for the clinic's staff (conversation center first, dashboard count), AI stops; voice transcriptions too
  - voice buttons bound to the pressing patient; callback queries answered; voice retention enforced by the scheduled job (`purged_at`)
  - compare-and-set on appointment status (admin, doctor, patient cancel) and payment transitions (race test); reactivation validated like a booking; patient cancels only a booking not yet started
  - production refuses weak `CRON_SECRET`/`TELEGRAM_WEBHOOK_SECRET`; public writes use the shared rate limit
  - clinic deletion works; reception double-click race (500) fixed
  - owner staff management (*Xodimlar*: add with one-time password, change role, remove), *Parolim* for every staff member, pending-referral badge for doctors
  - tests: tenant-integrity DB suite, payment race, website identity, cancel, reactivation, urgent escalation, retention (unit + DB), staff routes (real auth), E2E `e2e/staff-and-safety.mjs`, red team +4 REST forgery checks

- [x] ~~15. Unified booking engine & double-booking prevention~~ (2026-09-27)
  - invariant as a constraint: `EXCLUDE (clinic_id =, doctor_id =, [start,end) &&)` over active statuses; composite same-clinic foreign keys for doctor/patient/service
  - one booking service (`src/lib/booking/engine.ts` → `book_appointment()`) for the Mini App, bot deep link, website, reception, admin and the doctor's walk-in; clinic-scoped `reschedule_appointment()` with row lock
  - idempotency keys per booking attempt (unique per clinic; replay instead of a second appointment; no duplicate walk-in patient)
  - fixes: slots crossing local midnight passed the working-hours check; reception times read in the browser's timezone; Mini App availability ignored the clinic of the link; first doctor tap did nothing; confirm button stuck after a taken slot; overlap from the slot trigger reported as a server error
  - error contract `SLOT_UNAVAILABLE` / `INVALID_*` / `IDEMPOTENCY_KEY_REUSED` …; Mini App refreshes availability, reception sees it in the modal
  - tests: 2/5/10-way races (DB), online-vs-reception races both orders + 10-way mixed (real routes), duration overlap, idempotency, cancel/rebook, reschedule (occupied/self/concurrent), tenancy, midnight/DST; E2E `e2e/booking-channels.mjs`

- [x] ~~14. Clinical referrals (Phase 1)~~ (2026-09-27)
  - `referrals` table: same-clinic composite FKs, state machine trigger, RLS, redacted audit, follow-up appointment link
  - doctor portal `/doctor/referrals` (refer, accept/decline/complete/revoke, history after accept), reception booking of the follow-up, management revoke
  - `requireLinkedDoctor` guard, strict access logging, server-only doctor account linking
  - review-before-send dialog, idempotent creation (`creation_key`), server-side recipient check, pending referrals on the doctor dashboard
  - referral-based clinical access: `doctor_patient_access()` + doctor RLS policies, `canDoctorAccessPatientClinicalData`, `GET /api/doctor/patients/[id]`, security tests 1–10 at DB and API level
  - clinical workspace: `clinical_records` (immutable, provenance, RLS = consultation access), referred-patients section, patient workspace with own consultation vs previous records, walk-in/booked consultation start, revoked/expired states
  - hardening: voice storage for operational roles only, no direct doctor writes to appointments, inactive doctors denied at every layer, server/RLS parity for referral-linked appointments, rate limit; doctor patient page `/doctor/patients/[id]`
  - final integration: end-to-end workflow verified in the built app (A refers from the patient page → B accepts, reviews history, consults, documents, completes → A sees the outcome), phone/tablet checks, doctor portal navigation strip on phones
  - red-team audit: 20 attack vectors executed (API + direct REST/RPC + HTTP with real sessions); fixed F1 doctor routes admitting management accounts, F2 unchecked repeated/lapsed referral actions, F3 appointment-id existence disclosure, F4 PostgREST filter injection in reception search; regression suite `src/app/api/security/referral-redteam.test.ts`
  - lifecycle hardening: precise access table (receiver/referrer per state, all bounded by `expires_at` ≤ 180 days), completed ≠ permanent, cancelled bookings grant nothing, hourly expiry job `POST /api/referrals/expire`, clinical text server-only (no direct SELECT), audit trail with patient/referral columns, view/list/access audits, append-only tenant-checked `audit_events`; lifecycle test suites (DB + API) for every transition
  - clinical handoff: lifecycle `pending → accepted → in_progress → completed` (declined, revoked, expired), in progress set by the DB when the receiving doctor's consultation starts, completion only after it; record types for current assessment, laboratory order and follow-up plan; historical vs new diagnosis in the workspace; `consultation_started` audit; lifecycle stepper; end-to-end handoff tests
  - follow-up hardening: consultation start + referral link + `consultation_started` audit in one transaction (`start_consultation()`); appointments, patients and payments written by the server only (a manager's token could insert a payment marked paid over REST); clinical lookup rate limit shared across instances (`consume_rate_limit()`); `full-db-setup.sql` generated from the migrations with a drift test and runnable as one SQL-editor query; admin navigation on phones (and patients/conversations pages fit phone width); E2E workflow + HTTP red team committed under `e2e/` and run by CI (`.github/workflows/ci.yml`)
  - completeness: *Bemorlarim* patient list with search (`GET /api/doctor/patients`), corrections in the current consultation, clinical summary by record type, accept/complete referral from the workspace, records older than the visit window keep their consultation; `npm test` runs without `.env` files

- [x] ~~0. Audit~~ (2026-08-18)
  - `docs/architecture.md` + `docs/security.md`; threat model: cross-tenant, payment integrity, AI safety
- [x] ~~1. Database + Multi-tenancy~~ (2026-08-18)
  - migrations, RLS on every exposed table, `clinic_id` scoping, tenant-isolation tests (11)
- [x] ~~2. Roles + Authorization~~ (2026-08-18)
  - `requireRoles` guards, role-authorization tests (21), platform admin
- [x] ~~3. Clinic Telegram Integration~~ (2026-08-18)
  - webhook with secret-token, per-clinic bot tokens, Mini App initData verified clinic-bound, voice + consent flow
- [x] ~~4. Conversation Center~~ (2026-08-18)
  - `/admin/conversations` + routes; AI automation stops on human assignment
- [x] ~~5. Human Takeover~~ (2026-08-18)
  - CAS-held takeover, release/retry, 409 on stale ops, 10-way claim race test
- [x] ~~6. Patient CRM-lite~~ (2026-08-18)
  - `/admin/patients`: search, Telegram/consent filters, detail with appointments + conversations, cross-clinic isolation
- [x] ~~7. Booking + Lifecycle~~ (2026-08-18)
  - `book_appointment`/`reschedule_appointment` RPCs (advisory-lock serialized), overlap exclusion, status flow, cancel
- [x] ~~8. Owner/Manager Dashboard~~ (2026-08-18)
  - `/admin` today list, KPIs, quick booking; crash fixes (sort_order, hydration, envelope, roles)
- [x] ~~9. Analytics~~ (2026-08-18)
  - `/admin/analytics` from truthful DB source; real-DB integrity tests (revenue/cancel reasons/trend)
- [x] ~~10. Doctor Portal~~ (2026-08-18)
  - `/doctor` today's appointments + status flow (checked_in → in_progress → completed), `/doctor/schedule` breaks
- [x] ~~11. End-to-End Integration~~ (2026-08-18)
  - real-DB suites (booking races, claims, RLS), production browser pass (0 console errors), manual QA checklist
- [x] ~~12. Production Hardening~~ (2026-08-18)
  - fail-closed env guards (`CRON_SECRET`, dev-mode block), webhook size/flood guards, `next start` smoke test
- [x] ~~13. Red-Team / Adversarial Testing~~ (2026-08-18)
  - cross-tenant initData binding, prompt-leak guard, takeover CAS, cron auth, race tests; fixed all findings
  - committed `9c5bd8d`, pushed, `HEAD == origin/main`
- [x] ~~Final release gates~~ (2026-08-18)
  - typecheck, lint (0 problems), 197/197 tests, build, browser pass, secret scan