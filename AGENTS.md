<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Health AI Project Rules

## Non-negotiable safety

- This is a real clinic booking product. Prioritize patient safety, privacy, authorization, accurate appointment availability, and payment integrity over speed or UI polish.
- Never implement AI or automated diagnosis, treatment advice or prescriptions, or claims that AI output is medical advice.
- Clinical text exists only where a doctor writes it, and belongs to the patient's longitudinal clinic record:
  - `referrals`: the referring doctor's reason and handoff note — part of the patient's history, readable by doctors with a legitimate relationship to the patient (below); never by operational staff.
  - `clinical_records`: clinical notes, assessments, diagnoses, prescriptions, laboratory orders and results, medical history and follow-up plans, written by a doctor in their own consultation. Readable by doctors with a legitimate relationship to the patient (below). Records keep author, consultation, time, type and version, and are append-only: only their author (the same doctor record AND login) corrects them, as the record's next version — the earlier version is kept, never updated or deleted. A doctor who disagrees with a colleague's record — including through a referral — writes their own record in their own consultation; never give one doctor a way to change another's record.
  - Never show clinical text to operational staff, patients, logs, audit rows, analytics, or the patient-facing bot.
  - AI must never write, read, or summarise clinical text.
- AI must only provide clinic information or non-diagnostic booking navigation. Urgent wording must trigger the approved urgent-care message and human-admin escalation.
- Never claim a booking, payment, transcription, notification, or Telegram delivery succeeded unless the backend verified it.

## Secrets and environments

- Never commit, print, log, or paste tokens, API keys, passwords, service-role keys, payment secrets, or patient data.
- Keep `.env.local`, `.env.production`, and other real environment files untracked.
- Production must fail closed when required secrets are missing or insecure defaults are used, especially `CRON_SECRET`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_WEBHOOK_SECRET`.
- Do not enable Telegram development identity, mock payment, seed data, or debug behavior in production.

## Supabase and authorization

- Enable RLS on every exposed table. Enforce authorization in both database policies and server routes.
- A doctor reaches a patient's clinical data only through `public.doctor_patient_access()` (RLS) and `canDoctorAccessPatientClinicalData()` (server), and only with a legitimate clinical relationship: a treating relationship (any appointment with the patient that was neither cancelled nor a no-show, or a record they wrote) or an open referral to them or, while untaken, to their department. With it they see the patient's whole clinical history in the clinic — every doctor's records — without asking anyone: a referral is a clinical handoff, never a permission request, and acceptance never gates the history. Never grant doctors clinic-wide patient access: a same-clinic doctor without such a relationship sees nothing, and nothing crosses clinics.
- Laboratory data (`lab_*` tables, the `lab-documents` bucket) is clinical data. Results are written only by laboratory staff (never by a doctor, never by operational staff, never by AI) and are append-only: a correction is a new version. A doctor reads a patient's FINALISED (verified) results — never drafts, unverified or abandoned work — only through the same `doctor_patient_access()` decision as the rest of the history, and cannot change them. Owner/admin/manager/reception see no result values. Result documents live in the private `lab-documents` bucket and are served only by routes that re-check clinic, patient, authorization and the document-to-result relationship on every request: no public, signed or guessable URL. Critical-value alerting is deliberately not implemented yet.
- Access that rests only on a referral ends when the referral is declined or revoked and, at the latest, at its `expires_at` (≤ 180 days), checked against the database clock on every read. Clinical text (`referrals`, `clinical_records`) is read only through the server, which authorizes and audits each read — never grant signed-in roles SELECT on those tables. Doctors never read payment rows directly; the server shows a doctor only the payment status of their own visit in front of them. `audit_events` is append-only and tenant-checked.
- Treat the Supabase service-role client as privileged: use it only in server-only code after explicit clinic/role/ownership authorization.
- Every tenant-owned query and mutation must scope by `clinic_id`.
- Deleting a patient, an appointment or a clinic must never cascade into clinical records, referrals, appointments, payments, communications (conversations, messages, voice) or audit rows: each has its own retention, set by the clinic's confirmed policy (`retention_policies`). Never assume a retention period in code. A doctor record that holds another login's clinical records is never re-linked to a new login; a new doctor gets a new doctor record.
- Never trust role, clinic ID, patient ID, payment status, or Telegram identity from the browser.
- One patient, one record: reception registration and website booking look up an existing patient (by normalized phone, `patients.phone_normalized`) before creating one, a verified Telegram identity is its own key, and no booking path overwrites an existing patient's name or phone from unverified input. A booking made without proof of identity (an unconfirmed website booking) never gives a doctor a treating relationship with the patient. Referral controls workflow; a booked visit controls the treating relationship: revoking or declining a referral never cancels or changes a visit booked for it (reception is warned — `REFERRAL_REVOKED` / `REFERRAL_DECLINED` — and decides; "reviewed" is recorded per booking, who and when). Phone normalization must never equate two different numbers (an explicit `+` or `00` marks an international number, kept as typed without the `00`; numbers of fewer than 7 or more than 15 digits match nobody — two people may still share one number), and creating and deleting a patient are always audited (`patient_created` / `patient_deleted`: ids, channel and presence flags only, never name or phone).
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
