<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Health AI Project Rules

## Non-negotiable safety

- This is a real clinic booking product. Prioritize patient safety, privacy, authorization, accurate appointment availability, and payment integrity over speed or UI polish.
- Never implement diagnosis, treatment advice, prescriptions, clinical records, or claims that AI output is medical advice.
- AI must only provide clinic information or non-diagnostic booking navigation. Urgent wording must trigger the approved urgent-care message and human-admin escalation.
- Never claim a booking, payment, transcription, notification, or Telegram delivery succeeded unless the backend verified it.

## Secrets and environments

- Never commit, print, log, or paste tokens, API keys, passwords, service-role keys, payment secrets, or patient data.
- Keep `.env.local`, `.env.production`, and other real environment files untracked.
- Production must fail closed when required secrets are missing or insecure defaults are used, especially `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET`.
- Do not enable Telegram development identity, mock payment, seed data, or debug behavior in production.

## Supabase and authorization

- Enable RLS on every exposed table. Enforce authorization in both database policies and server routes.
- Treat the Supabase service-role client as privileged: use it only in server-only code after explicit clinic/role/ownership authorization.
- Every tenant-owned query and mutation must scope by `clinic_id`.
- Never trust role, clinic ID, patient ID, payment status, or Telegram identity from the browser.
- `SECURITY DEFINER` functions must use a safe `search_path`, have the minimum grants, and verify caller authorization internally. Do not grant privileged RPCs broadly to `authenticated`.
- Add or update tests whenever modifying RLS, staff roles, RPCs, or tenant-scoped queries.

## Booking and payments

- All booking creation and rescheduling must use the database transactional booking engine; do not rely on frontend slot checks.
- Preserve database-level overlap protection for active appointments.
- Re-check availability server-side immediately before booking or rescheduling.
- Payment status is server-controlled. A browser request can never mark payment as `paid`.
- Only `manual` payment is production-usable until Click/Payme adapters, signature verification, idempotent webhooks, and merchant credentials are implemented.

## Telegram, voice, and notifications

- Verify Telegram Mini App `initData` server-side before resolving a patient.
- Reject Telegram webhooks without the expected `X-Telegram-Bot-Api-Secret-Token`.
- Webhook idempotency must be atomic: claim an update before side effects and safely release/retry failed claims.
- Pass every supported Telegram update type—including voice messages—into its dedicated handler.
- Voice files stay in private storage. Obtain explicit consent before downloading, transcribing, or sending audio to an AI provider.
- Notification jobs must be atomically claimed in the database before sending. Concurrent workers must never send the same reminder twice.
- AI automation must stop while a conversation is assigned to a human admin.

## Testing and release gates

Run these before any release:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```
