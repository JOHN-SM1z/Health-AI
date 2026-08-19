# Tasks

## Active

## Waiting On

## Someday

- [ ] **Click / Payme payment adapters** - signature verification, idempotent webhooks, merchant credentials; only `manual` payment is production-usable
- [ ] **Production Telegram setup** - real bot tokens via `/admin/settings` and `CRON_SECRET` env before go-live
- [ ] **Production deploy (Phase 14)** - docs/go-live-checklist.md, docs/manual-qa-checklist.md, docs/deployment.md, docs/rollback.md ready; actual release + rollback drill not performed

## Done

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