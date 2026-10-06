# Laboratory Module — Staging Acceptance Checklist

This is the step-by-step check required by condition 1 of `PRODUCTION_READINESS.md` §3. It runs against a **staging** deployment: a separate Supabase project and app deployment, with its own Telegram test bot.

Work through it before the migrations go to production. Tick each step, and write down anything that differs from the expected result.

Rules for the run:
- **Use test people only.** Every patient, doctor and lab account here is a member of the team using a test account. If staging is a copy of production, it holds real patient data: the same access rules as production apply, and no real patient is used for the test.
- **Never copy result values, names or documents** into tickets, chat or this record. Write ids and outcomes only, the same rule as the logs and audit.
- The automated suites (`npm test`, `npm run test:e2e`) run only against a local stack by design (`assertLocalOnly`). On staging, this manual run is the check.

## People and devices

| Who | Role | Used for |
|---|---|---|
| Owner | `owner` | configuration, Kassa (payment and refund) |
| Reception | `receptionist` | patient date of birth, walk-in order, sample collection, cancellation |
| Doctor A | `doctor`, linked to a doctor record | ordering, results, notifications |
| Doctor B | `doctor`, with **no** visit with the test patient | access refusal |
| Lab 1, Lab 2 | `lab` | receiving, entering, verifying. Two people are needed, because the person who enters a result cannot verify it |
| Test patient | Telegram account on a **phone** | the "result ready" message and the Mini App |
| Second Telegram account | another phone, or another account | patient mismatch |

## A. Database (owner or engineer, SQL editor)

1. [ ] **Backup.** A verified backup or PITR point exists from just before applying. Write down its time: ________
2. [ ] Apply the migrations with `supabase db push` from the release commit. Expect no errors.
3. [ ] Check that all 21 lab migrations are recorded. Expect **21**:
   ```sql
   select count(*) from supabase_migrations.schema_migrations
   where version between '20261005000001' and '20261005000021';
   ```
4. [ ] Check that every public table has RLS enabled. Expect **no rows**:
   ```sql
   select c.relname from pg_class c
   where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity;
   ```
5. [ ] Check that lab result tables give signed-in users no privileges. Expect **no rows**:
   ```sql
   select table_name, grantee, privilege_type from information_schema.role_table_grants
   where table_schema = 'public' and grantee in ('anon', 'authenticated')
     and table_name in ('lab_results', 'lab_result_values', 'lab_documents', 'lab_import_rows', 'lab_external_requests');
   ```
6. [ ] Check the document bucket. Expect `public = false`, `20971520`, and PDF, JPEG, PNG, WebP:
   ```sql
   select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'lab-documents';
   ```
7. [ ] Check that payment amounts are no longer readable by signed-in users. Expect `amount` **absent** from the list:
   ```sql
   select column_name from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'payments' and grantee = 'authenticated';
   ```
8. [ ] Write down the Postgres major version (`select version();`): ________. On 17 or newer, `MAINTAIN` is also revoked.

## B. Configuration

1. [ ] The app's environment matches `docs/go-live-checklist.md`. `CRON_SECRET` is not the default.
2. [ ] `ENABLE_AI` is unset or `false`. `ALLOW_MOCK_LAB_PROVIDER` is **not set**.
3. [ ] The notification cron runs (`supabase/ops/scheduled-jobs.sql`). After the next quarter hour, the check query in that file shows `200 {"ok":true,…}`.
4. [ ] The owner opens **Laboratoriya** (`/admin/lab`) and:
   - adds one test with one numeric parameter, its unit, and a reference range for "Har ikki jins";
   - optionally adds a second, sex-specific range;
   - under **Sozlamalar**, chooses the payment policy "Namuna faqat to‘lovdan keyin olinadi" for this run;
   - checks that "Tasdiqlangan natijalarni bemorga Telegram ilovasida ko‘rsatish" is **on**, and the AI option is **off**.
5. [ ] The owner gives Lab 1 and Lab 2 the lab role (**Xodimlar**). Each lab account lands on **Ish navbati** (`/lab`) after signing in.

## C. The acceptance flow (one patient, end to end)

Expected results are in *italics*.

1. [ ] **Patient identity.** The test patient opens the clinic's test bot on the phone and books a visit with Doctor A for today.
   - *The patient appears under **Bemorlar** with a Telegram badge.*
2. [ ] **Date of birth (B1).** Reception opens the patient under **Bemorlar** and fills **Shaxsiy ma’lumotlar**: Tug‘ilgan sana and Jins. Then presses "Ma’lumotlarni saqlash".
   - *Before saving: "Tug‘ilgan sana kiritilmagan".*
   - *After: "Saqlandi ✓".*
   - *Before this step, a lab order for the patient is refused with "Bemorning tug‘ilgan sanasi kiritilmagan…".*
3. [ ] **Visit and order.** Doctor A starts the visit from **Bugungi navbat**. Then opens the patient under **Bemorlarim**, and in the **Laboratoriya** section: "Tahlil buyurtma qilish" → search for the test → "Ko‘rib chiqish" → "Buyurtma berish".
   - *Review shows the preparation text and the catalog price.*
   - *"1 ta tahlil buyurtma qilindi."*
4. [ ] **Payment before collection.** Reception opens **Namunalar** (`/admin/lab-queue`).
   - *The order shows "To‘lov kutilmoqda", and collection is refused.*

   The owner opens **Laboratoriya kassasi**: "To‘lovni qabul qilish" → "Naqd".
   - *The order is paid, for its stored price.*
5. [ ] **Collection.** Reception collects the sample from the order card (the "… namunasini olish" button).
   - *The status changes. A second press does not create a second sample.*
6. [ ] **Receiving.** Lab 1 opens **Ish navbati** and receives the sample ("Qabul qilish").
   - *The test moves to "Jarayonda".*
7. [ ] **Entry and document.** Lab 1: "Natija kiritish".
   1. Enter the value.
   2. Under "Ilovalar", attach a small test PDF ("Fayl tanlash").
   3. Press "Saqlash va tekshiruvga yuborish".
   - *An empty value cannot be submitted.*
   - *The PDF is listed.*
   - *The result waits in "Tekshiruvda".*
8. [ ] **Verification by a second person.**
   - Lab 1 tries to verify. *Refused: the same person cannot verify.*
   - Lab 2 verifies ("Tasdiqlash"). *The result is verified.*
9. [ ] **Doctor.** Doctor A checks the bell and the patient's **Laboratoriya** section.
   - *The bell shows "Laboratoriya natijasi tasdiqlandi", without the value.*
   - *"Natijani ko‘rish" shows the value with its unit, the configured range and the flag. The view says it is not a diagnosis.*
   - *The history tab lists it.*
   - *The "Xulosa" tab shows the computed summary (AI off).*
10. [ ] **Patient message.** Within about 15 minutes (one cron run), the test patient's phone receives **one** Telegram message.
    - *It has the date and a "📄 Natijani ko‘rish" button. There is no test name and no value.*
11. [ ] **Mini App.** The patient presses the button.
    - *The result opens inside Telegram, with the value, unit and range.*
    - *The PDF downloads.*
    - *The phone layout is usable: no horizontal scrolling, and the buttons can be reached.*
12. [ ] **No duplicate message.** Wait for the next cron run.
    - *No second message arrives.*

## D. Cancellation, refund and refusals

1. [ ] **Cancel with refund.** Make a second order for the patient and pay it at the Kassa. Then reception cancels it from **Namunalar** ("Buyurtmani bekor qilish", with a reason).
   - *The Kassa shows "Qaytarish kerak". "Qaytarish" → "Qaytarishni tasdiqlash" marks it refunded.*
2. [ ] **No cancel after collection.**
   - *An order whose sample was taken offers no cancel button.*
3. [ ] **Patient mismatch.** The second Telegram account opens the clinic's Mini App, at **Tahlil natijalari**.
   - *It sees no results from the test patient.*
   - *Pasting the test patient's result link opens nothing.*
4. [ ] **Doctor without access.** Doctor B searches for the test patient.
   - *Doctor B cannot open the patient or the results.*
5. [ ] **Operational staff see no values.** Reception and the owner look at the order in **Namunalar** and **Laboratoriya kassasi**.
   - *They see the status and payment only; no result value is shown.*
6. [ ] **Withheld release.** The owner temporarily turns off "Tasdiqlangan natijalarni bemorga…".
   - *The patient's Mini App shows no results.*

   Turn the setting back on.

## E. Evidence (SQL editor — ids and counts only, never values)

Put the test patient's id in place of `:patient`.

1. [ ] The audit trail exists for each step. Expect, among others: `patient_demographics_updated`, `lab_order_created`, `lab_sample_collected`, `lab_sample_received`, `lab_result_entered`, `lab_document_uploaded`, `lab_result_submitted`, `lab_result_verified`, `lab_result_viewed`, `lab_document_viewed`, `lab_order_cancelled`:
   ```sql
   select action, actor_type, count(*) from public.audit_events
   where patient_id = :patient group by 1, 2 order by 1;
   ```
2. [ ] Exactly one "result ready" message was sent per verified version. Expect `lab_result_ready | sent | 1` per verified result:
   ```sql
   select type, status, count(*) from public.notification_jobs
   where lab_result_id in (select r.id from public.lab_results r where r.patient_id = :patient)
   group by 1, 2;
   ```
3. [ ] The audit rows carry no values. Expect **no rows**:
   ```sql
   select id from public.audit_events
   where patient_id = :patient and (new_values::text ~ '[0-9]+\.[0-9]+' or metadata::text ilike '%value%');
   ```
   (A rough check. If it returns rows, open them and confirm they hold ids or counts, not results.)

## Go / no-go

**Go** only when all of the following hold:
- every box above is ticked with the expected result;
- the backup in A1 exists;
- the owner decisions in `PRODUCTION_READINESS.md` §3 have been made, or explicitly deferred.

**No-go** on any of these:
- a refusal in D that does not happen;
- a value shown anywhere it should not be;
- a missing or duplicated patient message;
- any error page.

If anything fails:
- write down the step, the time, and the ids involved;
- do not retry by editing data in SQL;
- the rollback options are in `PRODUCTION_READINESS.md` §4.

| Run by | Date | Staging app URL | Release commit | Result |
|---|---|---|---|---|
| | | | | |
