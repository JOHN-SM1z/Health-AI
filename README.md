# Health AI

Clinic booking and patient-communication MVP pilot: a Telegram bot + Mini App for patients,
an admin panel and a doctor panel, powered by Supabase (Postgres + Auth + Storage + RLS)
and a provider-agnostic AI layer, deployed to Google Cloud Run.

**Status:** development complete, awaiting production credentials (Telegram bot, AI provider,
payment provider) — see [docs/go-live-checklist.md](docs/go-live-checklist.md).

## What's inside

| Area | Description |
| --- | --- |
| Telegram bot | `/start`, menu, appointment booking flow, reminders, voice notes (transcription), admin notifications |
| Mini App | `/book` booking flow, `/my-appointments`, `/help`, `/privacy` — inside Telegram via `WebApp` |
| Admin panel | `/admin` — today, appointments, calendar, conversations, doctors, services, specialties, FAQs, analytics, settings |
| Doctor panel | `/doctor` — queue (checked-in → in-progress → completed), schedule + self-service breaks |
| Backend | booking engine (no double-booking), payment status machine, notifications queue, OpenAI-compatible AI, Telegram webhook |
| Database | 21 migrations: schema, RLS policies, functions/triggers, grants, release-blocker hardening, slot-validation + integrity fixes; seed data for demo clinic |
| Tests | unit + integration against local Supabase (integration suites skip cleanly when the local stack is unavailable) |

## Stack

- **Next.js 16** (App Router, React 19, Turbopack, standalone output) — bot API, Mini App, admin and doctor panels
- **Supabase** — Postgres, Auth (staff only), Storage (voice notes), RLS; patients verified via Telegram WebApp initData
- **Telegram Bot API** — webhook-driven; initData verified with HMAC-SHA256
- **AI** — provider-agnostic OpenAI-compatible chat completions (feature-flagged)
- **Payments** — server-controlled status machine (`pending → paid/failed/…`) with `manual` mode for pilot launch
- **Hosting** — Vercel / Node.js standalone server / Cloud Run

## Quick start (local development)

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
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm test               # vitest — DB integration suites probe the local stack and
                       # SKIP with a clear warning when it is unavailable (never a
                       # misleading failure from a half-configured database)
npm run db:reset-local # clean local DB: migrations + seed, one command
npm run create-owner   # create the first owner account + clinic (see supabase-setup.md)
npm run build          # production build (standalone)
```

Telegram integration needs a real bot (set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL`);
for UI-only development set `ENABLE_TELEGRAM_DEV_MODE=true` (local only, never in production).
See [docs/telegram-setup.md](docs/telegram-setup.md).

## Documentation

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

## Environment variables

Full list with descriptions: [docs/go-live-checklist.md](docs/go-live-checklist.md#environment-variables).
Never commit real values — `.env*` is gitignored except the two example files.

## License

Proprietary — pilot project, no license granted.