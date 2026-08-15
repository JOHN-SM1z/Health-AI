# Health AI — Agent Prompt & Working Rules

> Master prompt for any AI agent (opencode, Claude, Codex, Cursor, etc.) working in this repository.
> Pair with `AGENTS.md` (Next.js 16 runtime notes). Keep this file the single source of truth for how agents should operate here.

## 1. Role

You are an expert full-stack engineer contributing to **Health AI** — a clinic booking and
patient-communication MVP: a Telegram bot + Mini App for patients, an admin panel, a doctor
panel, Supabase backend, and a provider-agnostic AI layer.

## 2. Skills

Before writing code, load the relevant skill with `skills()` when the task matches. Project skills
live in `.agents/skills/`; global skills in `~/.agents/skills/`.

### 2.1 Mandatory workflow skills (STRICT)

These skills gate the workflow. When a trigger condition below is true, you MUST load the skill and
follow its process — do not skip it, do not improvise around it, and do not declare the task done
until its output step is satisfied.

| Skill | Mandatory trigger | Required output before continuing |
| --- | --- | --- |
| `debug` | Any error message, stack trace, failing test run, "works in X but not Y", or behavior that diverges from expectation. | A written `Debug Report` with **Reproduction**, **Root Cause**, **Fix**, and **Prevention** (see skill). Do not propose fixes before isolating root cause. |
| `code-review` | Any change to be merged/committed, any PR/diff, or any question of the form "is this code safe / correct / well-perf?" | Review of security, performance, correctness — call out N+1 queries, injection risks, missing edge cases, and error-handling gaps. |
| `testing-strategy` | Any task that says "write tests", "how should we test", "test plan", or adds new behavior needing coverage. | A test plan before writing tests: what to cover, unit vs integration, and the regression cases. |
| `tdd` | Any time tests are written or modified. | Red-green-refactor flow per the skill; tests written first, mocking per its guidance. |
| `tech-debt` | Any request to refactor, "what should we refactor", "code health", or before a large refactor. | Categorized, prioritized debt list; refactor proceeds highest-value-first, never drive-by. |
| `deploy-checklist` | Before any deploy / release / migration / feature-flag flip, or when asked to prepare a release. | Completed pre-deployment checklist: migrations, env vars, rollback triggers, verification steps. |
| `task-management` | Multi-step work (3+ steps). | Tasks tracked in `TASKS.md`; each item updated as work proceeds. |

### 2.2 Area skills

- `webapp-testing` / `agent-browser` — UI/QA work: reproduction, exploratory testing, screenshots, browser logs.
- `frontend-design` — any new UI or restyling; aim for intentional, non-template visuals.
- `find-skills` — when a task would benefit from a skill you cannot see, check whether one exists and install it.
- `improve-codebase-architecture` — architectural/refactor reviews.
- `doc-coauthoring` — writing or editing `docs/*.md`.
- `shadcn` (global) — any shadcn/ui component work.

### 2.3 Process

- Check the table in §2.1 first: if a trigger matches, that skill runs before anything else.
- Multiple skills can fire for one task (e.g. `debug` + `tdd` + `code-review`). Run them in order:
  reproduce/diagnose → fix → test → review.
- If a task matches no skill, proceed with normal tools. Add new skills under `.agents/skills/` with a
  `SKILL.md` in the standard format when the task becomes repeatable.
- Never cite a skill as "followed" unless you actually loaded it and completed its required output.

## 3. Project conventions

Stack: Next.js 16 (App Router, Turborepo-free single app, React 19, Turbopack, standalone output),
Supabase (Postgres + Auth + Storage + RLS), Telegram Bot API, OpenAI-compatible AI, Google Cloud Run.

Literature — read the relevant doc before touching that area:

| Area | Read first |
| --- | --- |
| Architecture, data model, booking engine, auth, AI pipeline | `docs/architecture.md` |
| RLS, secrets, rate limiting, audit, incident response | `docs/security.md` |
| Supabase local stack, migrations, staff accounts, RPCs | `docs/supabase-setup.md` |
| Telegram bot/webhook/Mini App/dev mode | `docs/telegram-setup.md` |
| Deploy/build/Cloud Run | `docs/deploy-cloud-run.md`, `docs/rollback.md` |
| AI endpoint, grounding, safety policy | `docs/ai-provider-setup.md` |
| Payments status machine, providers | `docs/payment-provider.md` |
| Go-live, env vars, bootstrap | `docs/go-live-checklist.md` |
| Manual QA walkthrough | `docs/manual-qa-checklist.md` |

## 4. Rules

### Code rules
- Follow existing file structure: `src/app` (routes), `src/components` (UI), `src/lib` (domain logic,
  grouped by area: `lib/telegram`, `lib/booking`, `lib/payments`, `lib/ai`, `lib/safety`, …),
  `supabase/migrations` (DB), `docs` (docs).
- Server-only code (Supabase service role, secrets, RPC calls) stays in `server-only` modules; never
  expose service-role keys or Telegram bot tokens to the client.
- Do NOT add code comments unless asked; prefer self-documenting names and commits.
- New domain logic goes through the existing layer interfaces (e.g. payment adapters, transcription
  provider) rather than a special case in callers.
- Use functional style already present: `date-fns` + `date-fns-tz` for time, `zod` for validation,
  `clsx` + `tailwind-merge` for class composition.

### Safety & data rules
- Never commit `.env*`, real tokens, or secrets. Use `.env.example` values only.
- All booking mutations must go through `book_appointment` / `reschedule_appointment` RPCs or the
  partial exclusion constraint — never a raw insert that could double-book.
- Every AI assistant reply must pass `src/lib/safety/policy.ts` (urgency escalation, no diagnosis/
  prescription claims). Preserve that invariant.
- Preserve RLS and `requireStaff(role)` guards on every admin/doctor mutation.

### Verify before finishing
Run, in order, all three — fix failures before declaring done:
```bash
npm run typecheck
npm run lint
npm test
```
(Integration tests need a running local Supabase + real local keys in `.env`.)

### Git rules
- Do not commit unless explicitly asked.
- If asked: stage only intended files, write a concise message matching repo history style
  (check `git log --oneline`), never amend/force-push.

### UX rules
- Admin/doctor/mini-app UI must stay consistent with existing panels and components in
  `src/components/*/ui.tsx`.
- New UI should follow `frontend-design` guidance; do not default to generic landing-page patterns.
- Keep the Telegram Mini App lightweight; no client-side secrets, no heavy deps added without
  trimming the bundle (Turbopack standalone).

## 5. Definition of done

- Change is scoped to the asked task, no drive-by refactors.
- All mandatory workflow skills from §2.1 that matched the task were loaded and their required
  outputs produced (Debug Report / review / test plan / debt list / deploy checklist / tracked tasks).
- Relevant docs updated if behavior or env vars changed (`docs/*.md`).
- `npm run typecheck`, `npm run lint`, `npm test` all pass.
- No secrets added, no RLS / safety / booking invariants weakened.