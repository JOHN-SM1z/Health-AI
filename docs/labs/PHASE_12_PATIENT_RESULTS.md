# Laboratory Module — Phase 12 Patient Results in Telegram and the Mini App

Status: **implemented and tested locally; not deployed.** The migrations have not
been applied to any hosted database.

## Flow

```
Result verified (second person)
  → released to patients? (clinic setting releaseToPatient, default on)
  → one notification job "lab_result_ready" for this version (existing queue)
  → worker sends a Telegram message: test + date, never values, [📄 Natijani ko‘rish]
  → patient opens the Mini App (initData signed by the clinic's bot)
  → Tahlil natijalari → the result → document download (60-second link)
```

The message, as sent:

```
🧪 Laboratoriya natijangiz tayyor.

Tahlil: Umumiy qon tahlili
Sana: 01.10.2026

Natija qiymatlari faqat ilovada, sizning Telegram hisobingiz tasdiqlangandan keyin ko‘rsatiladi.
[📄 Natijani ko‘rish]
```

When a correction is verified, the patient gets "… natijangiz yangilandi (tuzatilgan)" instead.

## Reused, not rebuilt

| Need | Existing piece |
|---|---|
| Patient identity | `resolvePatientFromInitData`: Telegram `initData` verified against **the clinic's own bot token**, so another clinic's bot can't vouch for a patient here |
| Clinic tenancy | `?clinic=` in the Mini App URL, looked up on the server (`getClinicFromRequest`) |
| Notification | `notification_jobs` + `claim_due_notification_jobs` (atomic, `SKIP LOCKED`) + `processDueNotificationJobs` + `sendTelegramMessage`, which already downgrades a rejected `web_app` button |
| Deep link | HTTPS `web_app` URL `/lab-results/<item>?clinic=…` (`resolveHttpsAppUrl`); for a t.me Mini App, `?startapp=lab_<item>`, routed on the Mini App home page |
| Files | Phase 11 private bucket, 60-second signed links (here with `download`) |

## Database

Two migrations: `20261005000013_lab_notification_type.sql` adds the enum value, and `20261005000014_lab_patient_results.sql` does the rest:

- `notification_job_type` gains `lab_result_ready`.
- `notification_jobs.lab_result_id` is a same-clinic composite key to the result version. A CHECK requires it exactly for `lab_result_ready`.
- Trigger `lab_results_notify_patient`: when a version becomes verified, the clinic releases results and the patient has a Telegram identity, it queues **one** job (`lab_result_ready:<result id>`, `on conflict do nothing`).
- `lab_release_to_patient(clinic)` is the single reading of the release setting; only an explicit `false` withholds results.

## The worker re-checks before sending

A queued job is **skipped** if, by the time it is sent:
- its version is no longer the current verified one (for example, a correction was verified meanwhile — that correction has its own job);
- the clinic stopped releasing results;
- the patient's Telegram identity changed.

It is never sent twice: one job per version, claimed atomically, and recorded as sent before anything retries.

## What the patient sees

Only through the **one approved gateway** `src/lib/labs/patient-results.ts`. Every query is pinned to the clinic, the verified patient and the current **verified** version, and checks the release setting:

- **List:** test, date, "updated" badge, number of values outside the configured range. No values.
- **Detail:** each value with its unit, the configured range used and the position against it, the "not a diagnosis — discuss with your doctor" note, and the result's documents. Lab comments and correction reasons are staff information and are not shown.
- **Document:** a 60-second download link for a non-withdrawn document of that result.

Everything else gets the **same 404**, so a guessed URL reveals nothing:
- another patient's or another clinic's id;
- a draft or a result awaiting review;
- a superseded version;
- withheld results;
- withdrawn or foreign documents.

Each read of values or a document is audited strictly before it is returned, with `actor_type: patient`, the patient id and `via: mini_app`, and ids only. No AI is involved, and AI summaries are not built (Phase 18).

## Guard

`src/lib/ai/clinical-isolation.test.ts` now:
- lets **only** the Mini App routes and pages and the notification worker import `@/lib/labs/patient-results`;
- keeps AI, the chat bot, safety and transcription code away from every lab module and table;
- checks the gateway itself: its result queries are clinic-scoped, both patient reads are pinned to the patient and to `verified`, it consults the release setting, it excludes withdrawn documents, and it never touches clinical records, referrals, lab comments or correction reasons.

## Tests

| Suite | Covers |
|---|---|
| `src/app/api/me/lab-results.test.ts` (11) | one job per verified version, none for unverified results or patients without Telegram, a correction gets its own job, none while results are withheld; the **worker** sends test + date and **no values** with the `web_app` button to `/lab-results/<item>?clinic=…`, skips a superseded version, never sends twice, skips when release is switched off before sending; the t.me `startapp=lab_<item>` link; **correct patient** (current corrected version, values, audit as patient); **wrong patient** (list, guessed detail, document); **wrong clinic** (another bot's signature 401, cross-clinic detail and document 404); **expired** (48 h) / **tampered** / missing / `dev` identity; unverified, random and malformed ids; withheld results; **documents**: own verified only, 60-second download, audited, withdrawn / in-review / someone else's / malformed refused. Real database, real signed `initData`; only Telegram's API is mocked |
| `src/lib/ai/clinical-isolation.test.ts` (updated) | the gateway rules above |
| `e2e/lab-patient-results.mjs` (10) | in a phone-sized browser opened as Telegram opens the Mini App (signed `#tgWebAppData`): one notification job queued; the **deep link** opens the result with value, unit, range, position and the note; the report downloads through a signed link; the list shows the one verified result; reads audited as the patient; **another patient** guessing the URL sees "Natija topilmadi"; a forged signature and a missing identity are refused |

Local run after a clean `supabase db reset` (real Supabase stack):
- `npm test`: **901/901** across 93 files.
- `npm run test:e2e`: referral 84/84, booking 9/9, staff & safety 14/14, lab configuration 11/11, lab ordering 14/14, lab collection 12/12, lab result entry 11/11, lab verification 13/13, lab history 12/12, lab documents 12/12, **lab patient results 10/10**, HTTP red team 55/55.
- Lint, typecheck and build pass, and `full-db-setup.sql` is regenerated (`--check` passes).

## Known limitation (needs a product decision)

A patient's results appear in the Mini App only on the patient record that holds their Telegram identity: the person who booked through, or opened, the clinic's bot.

A patient registered at the **reception desk** has no Telegram identity on that record. When they open the Mini App, the existing identity code (`getOrCreatePatient`) creates a separate Telegram patient record, which has no lab orders.

Linking the two needs a verified step so one person cannot claim another's record. Options include a one-time code printed on the lab receipt and entered in the bot, or a desk-side QR code. This was not built, and no identity data is merged automatically.

## Not in this phase

- AI summaries of results (Phase 18).
- Notifications other than "result ready" (for example, sample reminders): not requested.
- Critical-result alerts remain deferred by owner decision.
