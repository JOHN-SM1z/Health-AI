# Pilot — online services (identity, booking, payment, SMS)

Operator guide for the services added on 2026-10-08 (decisions: `docs/decisions/2026-10-08-identity-online-booking-payments-sms.md`).
Everything is **off by default**; each switch below is safe to leave off.

## What the clinic gets

| Service | Patient sees | Staff see |
|---|---|---|
| Identity privacy (always on) | — | Name, phone, card number; an age in the lab and for doctors |
| Online identity | Passport/ID or JSHSHIR + date of birth → share Telegram phone (or SMS code) → their card's details | A linked card; identity conflicts as claims |
| Concern → doctor | Typed (or spoken) concern → suggested direction → confirm | The concern as the booking's note |
| Online payment | "Onlayn to‘lash va navbat olish" → number after payment | "Bugun onlayn to‘laganlar" → **Keldi**; refunds on **Moliya** |
| SMS | Number and "you are called" by SMS (no Telegram, agreed) | Consent checkbox at registration and on the patient card |
| Smartphone share | — | Kassa → clinic totals → "Navbat raqami qanday yetkazildi" |

## Switches

| Where | Switch | Needs |
|---|---|---|
| Settings → Onlayn xizmatlar (owner) | Online identity required | The clinic's Telegram bot |
| Settings → Onlayn xizmatlar (owner) | SMS on | `SMS_PROVIDER=eskiz` + Eskiz credentials |
| Server environment | `ONLINE_PAYMENT_PROVIDER` | `none` until the Rahmat adapter exists |
| Server environment | `HEALTH_AUDIO_ALLOWED_HOSTS` + `TRANSCRIPTION_*` | A speech server in Uzbekistan (self-hosted Whisper or Aisha/Voicelab) |

## Server environment (secrets via the host's secret store — never in code or chat)

```
# SMS (Eskiz)
SMS_PROVIDER=eskiz                 # none | eskiz   (test = local E2E only; production refuses it)
ESKIZ_EMAIL=...
ESKIZ_PASSWORD=...
ESKIZ_FROM=4546                    # the approved sender name
ESKIZ_CALLBACK_SECRET=<32+ random characters>
NEXT_PUBLIC_APP_URL=https://<your domain>

# Online payment
ONLINE_PAYMENT_PROVIDER=none       # rahmat is refused at startup until its adapter is implemented

# Voice concerns (optional)
ENABLE_TRANSCRIPTION=true
TRANSCRIPTION_BASE_URL=https://stt.<your domain>/v1
TRANSCRIPTION_API_KEY=...
HEALTH_AUDIO_ALLOWED_HOSTS=stt.<your domain>
```

Startup fails closed on a test provider, an unimplemented provider, missing Eskiz credentials or a weak callback secret.

## Before turning SMS on
1. Eskiz contract; register the sender name; submit the three templates in `src/lib/sms/templates.ts` for approval.
2. Set the variables above; restart.
3. Send one real message to a staff phone (register a test patient without Telegram, tick SMS consent, take payment)
   and confirm in `sms_messages` that it moves to `delivered` after Eskiz's report.
4. Owner: Settings → Onlayn xizmatlar → SMS on.

## Run everything locally
```
npm ci
npx supabase start
npm run db:reset-local
# .env from `npx supabase status` (+ CRON_SECRET / TELEGRAM_* random values)
npm run create-owner
npm run dev
```
Tests: `npm test`. Browser end-to-end against a production build: `npm run build`, start `.next/standalone/server.js`,
`npm run e2e:seed`, `npm run test:e2e`. The online-payment script needs `ONLINE_PAYMENT_PROVIDER=test_online`,
`ALLOW_TEST_ONLINE_PAYMENT=true` and a 32+ character `TEST_ONLINE_PAYMENT_SECRET` in the local `.env`.

## Hosting in Uzbekistan (optional)
The app is a Next.js server plus Supabase (Postgres, auth, storage). Both run on your own server:
- the app from `Dockerfile` (`docker build` → run with the environment above, behind HTTPS on your domain);
- Supabase from its official self-hosting Docker setup;
- apply `supabase/migrations` in order (or `supabase/full-db-setup.sql` on an empty database).
Only URLs and keys change. Telegram needs the public HTTPS address for its webhook and the Mini App.

## Still waiting on others
- **Rahmat:** merchant API documentation, webhook signature scheme, refund API, test credentials, contract.
- **Eskiz:** contract, sender name, template approval, one live test.
- **Aisha/Voicelab:** speech API documentation, keys, written confirmation that audio stays in Uzbekistan.
