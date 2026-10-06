# Health AI

Clinic operations software centered on walk-in registration, live queues, services cashier, clinician-authored history and simple referrals. Scheduled booking is an optional clinic setting. AI is restricted to nonclinical information and navigation.

**Status: development revision, not production approved.** See the [phased pilot checklist](docs/PILOT_IMPLEMENTATION_CHECKLIST.md) and [latest validation](docs/PILOT_VALIDATION_2026-10-06.md) for current implementation and release blockers. The October database audit found authorization and integrity defects despite earlier approval claims. See [current product direction](docs/CLINIC_OPERATIONS_PRODUCT.md), [database findings](docs/DATABASE_AUDIT_2026-10-05.md), and [implementation and validation status](docs/OPERATIONS_REVISION_2026-10-06.md). Inpatient management, full billing and device-connected laboratory workflows remain before operational replacement. Payroll is deferred and stays in the clinic’s existing process. See the [device integration plan](docs/labs/DEVICE_INTEGRATION_PLAN.md).

---

## 1. Historical release records

These reports describe an earlier booking-focused version. They do not approve the current revision or override the October audit.

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
| Admin Panel | `/admin` registration/live queue, `/admin/cashier` services collection, patients, conversations, catalog and settings; scheduled calendar is optional |
| Doctor Panel | Own live queue, append-only patient history, printing, simple referrals and working hours |
| Backend | Transactional booking engine (no double-booking), payment status machine, notification lifecycle daemon, OpenAI-compatible AI receptionist |
| Database | Ordered migrations in `supabase/migrations/`; apply each file in its own transaction |
| Verification | Unit/API tests plus an isolated PostgreSQL replay and concurrency/security harness; see current validation report |

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

Requirements: Node 20+.

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
cp .env.test.example .env.test # loopback-only disposable test environment
npm test               # vitest — DB integration suites probe the local stack and
                       # SKIP with a clear warning when it is unavailable
npm run db:reset-local # clean local DB: migrations + seed, one command
npm run create-owner   # create the first owner account + clinic (see supabase-setup.md)
npm run build          # production build (standalone)
```

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