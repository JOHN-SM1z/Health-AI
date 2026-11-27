# Health AI

Clinic booking and patient-communication platform: a Telegram bot + Mini App for patients, an admin panel and a doctor panel, powered by Supabase (Postgres + Auth + Storage + RLS) and a provider-agnostic AI layer, deployed to Google Cloud Run or Vercel.

**Status:** **LOCAL RELEASE GATES PASSED**. The 20 November migration-history, compiler and legacy-test blockers are repaired: lint, typecheck, production build, 1,353 tests (zero skipped) and 522 browser/HTTP checks pass. See [current implementation status and upgrade boundaries](docs/IMPLEMENTATION_STATUS_2026-11-20.md). No production database or deployment was changed; earlier audit approvals remain historical evidence.

---

## 1. Production Readiness & Release Records

| Document | Contents |
| --- | --- |
| [📋 Production Readiness Audit](docs/PRODUCTION_READINESS_AUDIT.md) | **Canonical audit report: 26 phase verifications, 10 release gates, final approval decision** |
| [🔗 Release Evidence Index](docs/RELEASE_EVIDENCE_INDEX.md) | **Traceability index mapping every phase & release gate to exact source code & tests** |
| [🧪 Test Verification Report](docs/TEST_VERIFICATION_REPORT.md) | **Empirical test execution report, unit/integration breakdowns, static analysis results** |
| [🔒 Security Verification](docs/SECURITY_VERIFICATION.md) | **Security controls matrix, RLS policy verification, authentication & isolation audit** |
| [✅ Production Release Checklist](docs/PRODUCTION_RELEASE_CHECKLIST.md) | **Operational pre-deployment, deployment, post-deployment, and rollback checklists** |

---

## 2. What's inside

| Area | Description |
| --- | --- |
| Telegram Bot | `/start`, menu, appointment booking flow, reminders, voice notes (transcription), admin notifications |
| Mini App | `/book` booking flow, `/my-appointments`, `/help`, `/privacy` — inside Telegram via `WebApp` |
| Admin Panel | `/admin` — today view, appointments, calendar, conversations, doctors, services, specialties, FAQs, analytics, settings |
| Doctor Panel | `/doctor` — queue (checked-in → in-progress → completed), schedule + self-service breaks |
| Backend | Transactional booking engine (no double-booking), payment status machine, notification lifecycle daemon, OpenAI-compatible AI receptionist |
| Database | 25 SQL migrations: schema, RLS policies, functions/triggers, grants, role-based authorization, slot-validation + integrity fixes |
| Verification | 33 test files / 219 tests covering unit, API, concurrency, security, and RLS policies |

---

## 3. Tech Stack

- **Next.js 16** (App Router, React 19, Turbopack, standalone output) — bot API, Mini App, admin and doctor panels
- **Supabase** — Postgres, Auth (staff only), Storage (voice notes), RLS; patients verified via Telegram WebApp initData
- **Telegram Bot API** — webhook-driven; initData verified with HMAC-SHA256
- **AI Engine** — provider-agnostic OpenAI-compatible chat completions (feature-flagged) with safety policy
- **Payments** — server-controlled status machine (`unpaid → paid/cancelled/…`) with `manual` mode for pilot launch
- **Hosting Target** — Google Cloud Run (Docker standalone) / Vercel / Node.js production server

---

## 4. Quick Start (Local Development)

Requirements: Node 22.18+ (CI uses Node 22).

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in your SUPABASE_URL and Supabase keys

# 3. Start development server
npm run dev          # http://localhost:3000
```

Useful scripts:

```bash
npm run typecheck      # tsc --noEmit (0 errors)
npm run lint           # eslint (0 errors)
npm test               # vitest — DB integration suites probe the local stack and
                       # SKIP with a clear warning when it is unavailable
npm run db:reset-local # clean local DB: migrations + seed, one command
npm run db:full-setup  # regenerate supabase/full-db-setup.sql after adding a migration
npm run create-owner   # create the first owner account + clinic (see supabase-setup.md)
npm run build          # production build (standalone)

# End-to-end, against the built app on the LOCAL stack only (npm run build && npm start):
npm run e2e:seed       # demo clinic + staff accounts (idempotent; refuses non-local hosts)
npm run test:e2e       # referral workflow, online-vs-reception booking race, staff management and
                       # urgent escalation (browser) + HTTP red team
```

Vitest and the E2E runner load `.env.test` when present, otherwise `.env.test.example`. They never load
the app's `.env` or `.env.local`; every Supabase API/database target must use a
loopback host. For database integration tests, configure `.env.test` with keys
from a disposable local stack. CI creates that file using its generated local
credentials. Set `REQUIRE_TEST_DATABASE=true` for a release verification run; an
unavailable database then fails instead of skipping integration suites. E2E also
requires an explicit local `SUPABASE_DB_URL`. Worker migration/claim checks can run independently with
`SUPABASE_DB_URL` set to a local administrator connection and
`npm run test:notification-claims`; they create and remove their own test database.
`npm run test:schema-rehearsal` additionally verifies canonical clean installs,
upgrades, RLS/grants and the generated SQL bundle. See the
[migration lineage rules](supabase/legacy-migrations/README.md) before upgrading.

The working-tree compatibility findings and current verification results are in
[the implementation status](docs/IMPLEMENTATION_STATUS_2026-11-20.md). Historical
approval and test counts elsewhere in this README do not certify this checkout.

CI (`.github/workflows/ci.yml`) runs all of the above on every push: lint, typecheck, tests
without a database, build, then a Supabase stack from the CLI with every migration and the
seed, the full test suite, and the end-to-end scripts against the built app.

---

## 5. Technical Documentation

| Doc | Contents |
| --- | --- |
| [🚀 Production Deployment](docs/deployment.md) | **Step-by-step production deployment (Vercel, Node.js, Cloud Run), keys, webhook setup** |
| [Architecture](docs/architecture.md) | System diagram, data model, booking engine, notifications, AI pipeline |
| [Security](docs/security.md) | Authentication model, RLS, rate limiting, secrets, audit, incident response |
| [Supabase setup](docs/supabase-setup.md) | Database setup, migrations, seed, staff accounts, RPC functions |
| [Telegram setup](docs/telegram-setup.md) | Bot creation, webhook, Mini App, dev mode |
| [AI provider setup](docs/ai-provider-setup.md) | OpenAI-compatible endpoint config, grounding, safety policy |
| [Payment provider](docs/payment-provider.md) | Status machine, manual mode, Click/PayMe adapter interface |
| [Manual QA checklist](docs/manual-qa-checklist.md) | End-to-end walkthrough before go-live |
| [Go-live checklist](docs/go-live-checklist.md) | Credentials needed, exact env vars, first-owner bootstrap, DNS, go/no-go |
| [Rollback runbook](docs/rollback.md) | Cloud Run revision traffic switching (<2 min) and DB disaster recovery |

---

## 6. Environment Variables

Full list with descriptions: [docs/go-live-checklist.md](docs/go-live-checklist.md#environment-variables).  
Never commit real values — `.env*` is gitignored except example files.

---

## 7. License

Proprietary — pilot project, no license granted.
