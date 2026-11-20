# Laboratory Module — Phase 16 Lab Notifications

Status: **implemented and tested locally; not deployed.**

## On the existing architecture

Everything goes through `notification_jobs`: the same table, the unique idempotency key, `claim_due_notification_jobs` (SKIP LOCKED), the worker's retry and give-up rules, and `sendTelegramMessage` with each clinic's own bot. Two channels:

| Channel | For | How it is delivered |
|---|---|---|
| `telegram` | patients | claimed and sent by the existing worker; retried on failure (`max_attempts`, default 3); never sent twice |
| `in_app` (new) | staff | a row per recipient, inserted as delivered (`sent`); read in the staff inbox (bell). Staff have no Telegram identity, and the global admin chat (`TELEGRAM_ADMIN_CHAT_IDS`) is not per clinic, so lab events never go there. The worker never claims in-app rows. |

Rows hold **an event type and ids only** — never names, test names, values or clinical text. The inbox builds the wording when it is read.

## Events and recipients

| Event | Recipients | Rule |
|---|---|---|
| LAB_ORDER_CREATED | lab staff | not for imports |
| LAB_SAMPLE_COLLECTED | lab staff | |
| LAB_RESULT_ENTERED (submitted for verification) | the **verifiers** per the clinic's `verifiers` setting: lab staff and/or the ordering doctor | never the author or submitter; imports excluded (confirmed in the import) |
| LAB_RESULT_VERIFIED | the ordering doctor | |
| LAB_RESULT_READY | the patient (Telegram) | Phase 12. Only for a verified, current version, while the clinic releases results, to the patient's current Telegram identity (canonical record after a merge) |
| LAB_RESULT_CORRECTED | the ordering doctor; the patient (Telegram, "updated") | |
| LAB_ORDER_CANCELLED | lab staff, managers (owner/manager/admin), the ordering doctor; the patient **only if the clinic enables it** | |

Further rules:
- **Never the person who caused the event.**
- **Never anyone outside the clinic:** recipients come from `staff_roles` of that clinic.
- **Never anyone without the role:** "the ordering doctor" means an active, linked doctor with the doctor role.

## Rules respected

- **Clinic configuration** (lab settings, parsed field by field like the others):
  - `notifyStaff` (default on) turns off every staff notification;
  - `notifyPatientOnCancel` (default off) enables the patient's cancellation message;
  - `releaseToPatient` (Phase 12) gates "result ready";
  - `verifiers` decides who hears that a result awaits verification.
- **Role permissions at read time:** a doctor sees a notification only while `doctor_patient_access()` still admits them to that patient (a referral may have ended). A reader sees only their own notifications of their own clinic. Patient and test names are shown, values never.
- **Patient identity:** the Telegram recipient is resolved from the patient's canonical record. The worker re-checks it before sending and **skips** the message if it changed (wrong patient), rather than sending it to the old chat.
- **Result state:** "result ready" goes out only for the current verified version (Phase 12); "order cancelled" only while the order is still cancelled.

## Previews without clinical content

- **"Result ready" now says only** "🧪 Laboratoriya natijangiz tayyor." with the date. The **test name was removed** (in Phase 12 it was shown), because a notification preview can be read on a locked screen. The patient opens the result in the app after their Telegram identity is verified.
- **Cancellation:** "Laboratoriya buyurtmangiz bekor qilindi. Savollaringiz bo‘lsa, klinikaga murojaat qiling." No tests are named.
- **Staff inbox:** the event, patient and test — never values.

## Retry and idempotency

- **Enqueue:** one job per (event, entity, recipient), enforced by the unique `idempotency_key` with `on conflict do nothing`. A repeated event, such as a result returned and submitted again, never notifies twice.
- **Send:** claimed atomically; a failed send goes back to `pending` with `attempts + 1`, and after `max_attempts` becomes `failed`. A message that was delivered but could not be recorded is marked failed and never re-sent (existing rule).

## Pieces

| | |
|---|---|
| `20261005000018_lab_notification_events.sql` | the six new job types (enum values in their own migration) |
| `20261005000019_lab_notifications.sql` | `notification_jobs` + `recipient_profile_id`, `lab_order_id`, `read_at` with checks; in-app jobs never claimed; `lab_notify_staff()`; triggers on orders, samples and results; the patient cancellation job |
| `src/lib/notifications/processor.ts` | branch for `lab_order_cancelled`; "result ready" text without the test name |
| `src/lib/labs/patient-results.ts` | `loadLabOrderNotice` (status and Telegram identity only) — the approved patient gateway |
| `src/lib/labs/staff-notifications.ts`, `GET/POST /api/staff/notifications` | the inbox: list (built at read time, access re-checked) and mark read (own only) |
| `src/components/staff/notification-bell.tsx` | the bell in the admin, doctor and lab workspaces (desktop sidebar and mobile header) |
| Lab settings tab | two new switches |

## Tests

| Suite | Covers |
|---|---|
| `src/app/api/lab/lab-notifications.test.ts` (5) | Real database and worker.<br>**Every event's recipients:** never the actor; not another clinic, an unrelated doctor or reception.<br>**Duplicate event:** return then resubmit gives one notification per recipient.<br>**Cancellation:** staff, managers and the doctor; the patient only when enabled; the message has no test name and goes through the clinic's own bot; in-app rows are never sent to Telegram.<br>**Settings:** staff off, lab-only and doctor-only verifiers; imports notify nobody.<br>**Failed then retried**, give-up after the limit, duplicate worker runs.<br>**Wrong patient** (Telegram changed): skipped, nothing sent.<br>**Inbox:** own items only, no values, a doctor without access sees nothing, another clinic sees nothing, marking read only affects one's own |
| `src/app/api/me/lab-results.test.ts` (updated) | "result ready" has the date, **no test name**, no values |
| `src/app/api/admin/lab/lab-config.test.ts` (updated) | the two new settings, with malformed values read as defaults |
| `e2e/lab-notifications.mjs` (7) | Browser:<br>• the lab's bell shows a doctor's new order (patient and test) and "mark all read" clears it;<br>• the doctor is told the result awaits verification, then that it is verified;<br>• the doctor's bell on a phone shows no value and opens the patient;<br>• the owner switches staff notifications off and a new order notifies nobody;<br>• the inbox needs a session |

Also: tests that assert values are absent from a JSON response now blank ids, hashes and timestamps first (`src/test/id-free.ts`), so a uuid that happens to contain "135" can no longer fail them. Test workers are scoped to their own clinics (`claim_due_notification_jobs(limit, clinic_ids)`), so suites running in parallel never take each other's jobs.

Local run after a clean `supabase db reset`:
- `npm test`: **950/950** across 99 files (twice).
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, lab patient results 10/10, lab import 18/18, patient merge 14/14, lab external 13/13, **lab notifications 7/7**, HTTP red team 55/55.
- Lint, typecheck and build pass; `full-db-setup.sql` regenerated.

## Not built / decisions

- Staff notifications by **Telegram or e-mail** (staff accounts have no verified Telegram identity). In-app only for now.
- **Manager digests**, e.g. a daily summary of rejected samples or overdue results: not requested in detail; managers get cancellations.
- **Critical-result alerts** remain deferred by owner decision.
