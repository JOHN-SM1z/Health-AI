# Tasks

## Active

## Waiting On

## Someday

- [ ] **Click / Payme payment adapters** - signature verification, idempotent webhooks, merchant credentials; only `manual` payment is production-usable
- [ ] **Production Telegram setup** - real bot tokens via `/admin/settings` and `CRON_SECRET` env before go-live
- [ ] **Referral notifications outside the app** - the receiving doctor sees a count of waiting referrals on *Yo‘llanmalar* (in-app); Telegram/e-mail delivery would need doctor accounts linked to a Telegram chat or a mail provider
- [ ] **Clinical records legal review** - doctor-authored records (notes, diagnoses, prescriptions, lab results) now exist; confirm retention rules vs. the patient's deletion request (records are currently erased with the patient) and the privacy-page wording
- [ ] **Lab integration** - lab results are typed in by doctors; no laboratory system feeds them
- [ ] **Referral privacy wording review** - `/privacy` §3/§4 now describe doctor-to-doctor referrals; needs owner/legal sign-off
- [ ] **Production deploy (Phase 14)** - docs/go-live-checklist.md, docs/manual-qa-checklist.md, docs/deployment.md, docs/rollback.md ready; actual release + rollback drill not performed

## Done

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