# Tasks

## Active

## Waiting On

## Someday

- [ ] **Click / Payme payment adapters** - signature verification, idempotent webhooks, merchant credentials; only `manual` payment is production-usable
- [ ] **Production Telegram setup** - real bot tokens via `/admin/settings` and `CRON_SECRET` env before go-live
- [ ] **Referral notifications** - the receiving doctor is not notified (Telegram/e-mail) of a new referral; they see it under `/doctor/referrals`
- [ ] **Referral privacy wording review** - `/privacy` §3/§4 now describe doctor-to-doctor referrals; needs owner/legal sign-off
- [ ] **Clinic deletion blocked by audit trigger** - `audit_track_changes()` logs cascaded child deletes against the clinic being deleted → `audit_events_clinic_id_fkey` violation (pre-existing)
- [ ] **Production deploy (Phase 14)** - docs/go-live-checklist.md, docs/manual-qa-checklist.md, docs/deployment.md, docs/rollback.md ready; actual release + rollback drill not performed

## Done

- [x] ~~14. Clinical referrals (Phase 1)~~ (2026-09-27)
  - `referrals` table: same-clinic composite FKs, state machine trigger, RLS, redacted audit, follow-up appointment link
  - doctor portal `/doctor/referrals` (refer, accept/decline/complete/revoke, history after accept), reception booking of the follow-up, management revoke
  - `requireLinkedDoctor` guard, strict access logging, server-only doctor account linking
  - review-before-send dialog, idempotent creation (`creation_key`), server-side recipient check, pending referrals on the doctor dashboard
  - referral-based clinical access: `doctor_patient_access()` + doctor RLS policies, `canDoctorAccessPatientClinicalData`, `GET /api/doctor/patients/[id]`, security tests 1–10 at DB and API level
  - hardening: voice storage for operational roles only, no direct doctor writes to appointments, inactive doctors denied at every layer, server/RLS parity for referral-linked appointments, rate limit; doctor patient page `/doctor/patients/[id]`

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