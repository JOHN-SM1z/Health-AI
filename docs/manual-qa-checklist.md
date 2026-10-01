# Manual QA checklist

Run against the deployed environment (or local stack with dev mode) before go-live.
Each row: expected behavior. Mark all green = go.

Automated on every push (CI) and locally with `npm run e2e:seed && npm run test:e2e` against
the built app: the doctor-to-doctor referral workflow at desktop, tablet and phone widths
(including the lapsed-referral states and the reception/manager screens) and the HTTP red team.
The patient's journey (*Acceptance journey* below) is also covered against the local database by
`src/app/api/doctor/patients/longitudinal-care.test.ts`. The rows below cover what those scripts do
not: the Telegram bot and Mini App, payments, notifications, and a human's eye on every screen.

## Telegram bot

- [ ] `/start` shows the menu with the Mini App button and booking entry
- [ ] Menu → "Qabulga yozilish" → choose service → doctor → time slot → confirm
- [ ] Confirmation message arrives; appointment appears in "Mening qabullarim"
- [ ] Booking a slot that someone else just booked → friendly "band" message (no double-book)
- [ ] Booking outside working hours / doctor's break → clear rejection message
- [ ] Cancel an appointment → confirmation message; slot becomes free again
- [ ] "Shifokor tanlashda yordam" answers from FAQ/catalog; NOT a diagnosis
- [ ] Urgency keywords (e.g. "yurak og'riyapti", "вызовите скорую", "chest pain")
      → approved urgent-care message (also while an operator holds the chat); the chat shows
      as *Shoshilinch* first in `/admin/conversations` and in the dashboard count; the bot
      stops auto-replying
- [ ] Voice message → transcribed (if transcription enabled) or graceful decline
- [ ] Unknown commands → helpful fallback reply

## Mini App (/book)

- [ ] Opens inside Telegram, loads clinic catalog
- [ ] Booking flow completes end-to-end; confirmation screen shows details
- [ ] /my-appointments lists bookings; cancel works
- [ ] Second patient booking the same slot concurrently → exactly one succeeds
- [ ] Direct HTTP call to /api/bookings without valid initData → 401/400

## Admin panel (/admin)

- [ ] Login with a staff account; wrong password → error, no redirect
- [ ] Staff without admin role → blocked from /admin
- [ ] Today view shows today's appointments; status updates reflect immediately
- [ ] Create manual/walk-in appointment; slot conflict → rejected
- [ ] Cancel/confirm/reschedule appointments; reschedule conflict → rejected
- [ ] Mark payment paid (manual mode) → payment status changes, audit row written
- [ ] Conversations: takeover → bot stops answering; admin reply reaches patient
- [ ] Doctors: add/edit doctor, working hours, time blocks
- [ ] Services/Specialties/FAQs CRUD → Mini App catalog reflects changes
- [ ] Settings (owner): update clinic settings → persisted
- [ ] Owner-only sections invisible to admin role

## Doctor panel (/doctor)

- [ ] Doctor's queue (*Bugungi navbat*) lists only their own visits
- [ ] checked_in → in_progress → completed flow works
- [ ] Doctor cannot change other doctors' appointments (a patient's other visits are read-only history on the patient's page, see below)
- [ ] Self-service break blocks the slot for patients

## Referrals

A referral is a clinical handoff, not a permission request: the receiving doctor sees the patient's
history at once.

- [ ] Doctor: *Yo‘llanma* on an in-progress/completed consultation → *Bo‘lim* and/or *Qabul qiluvchi shifokor* (colleague list excludes self; with a department chosen only its doctors, or *Bo‘limning istalgan shifokori*); reason required
- [ ] *Ko‘rib chiqish* shows department, doctor, priority, validity, reason and note, and says reason and note enter the patient's medical history; *Tahrirlash* keeps the input; nothing is sent before *Yo‘llanma yuborish*
- [ ] Double-clicking *Yo‘llanma yuborish* creates one referral and one `referral_created` audit row
- [ ] Receiving doctor's `/doctor` dashboard shows *Sizga kelgan yo‘llanmalar (n)* with patient, referrer and priority only; the *Yo‘llanmalar* link shows the same count
- [ ] Referral appears as *Kutilmoqda* under *Men yo‘llagan bemorlar* (referrer) and *Menga yo‘llangan bemorlar* (receiver)
- [ ] Receiver sees the patient's whole history — every doctor's visits and clinical records, each with its author — while the referral is still *Kutilmoqda*: on the patient's page and, on the referral page, the patient's contact details and last visits. Nothing has to be accepted or approved first
- [ ] Declining (named doctor only) with or without a reason works; a receiver with no visit or record of their own with the patient can then no longer open the referral or the patient (*Yo‘llanma rad etilgan* / 404 page); a receiver who has their own visit or record keeps the patient's history
- [ ] A doctor who is not a party gets *Yo‘llanma topilmadi* for the referral URL (they may still read the referral inside the patient's history if they have that access, but see no actions)
- [ ] Reception: patient panel shows *Yo‘llanmalar* (doctors, status, priority) but never the reason/handoff note; *Qabulga yozish* books with the receiving doctor only once the referral is accepted, then disappears
- [ ] Only owner/admin/manager see *Bekor qilish* on a referral in the patient panel
- [ ] Owner/manager account linked to a doctor record is refused on `/api/doctor/referrals` (403)
- [ ] `audit_events` has `referral_created/accepted/follow_up_booked`, `referral_opened` (detail) and `referral_viewed` (lists) rows without the reason/handoff text
- [ ] With a doctor's own token, `GET /rest/v1/patients?id=eq.<X>` is empty for a same-clinic doctor with no relationship to X, and returns X for the receiving doctor from the moment the referral is pending — and is empty again after revoke/decline/expiry if the referral was their only link
- [ ] `GET /api/doctor/patients/<X>`: 200 for a doctor with a relationship (own visit or record, or an open referral); 404 for anyone else; 410 with the reason for the receiving doctor after revoke, decline, completion or expiry when nothing else links them to X
- [ ] Doctor queue → patient name opens the patient page (*Mening bemorim*); referral → patient name opens it as *Yo‘llanma bo‘yicha*; both show every doctor's visits
- [ ] A doctor's own token cannot update or delete appointments via `/rest/v1/appointments`, nor read `voice-messages` storage objects
- [ ] Deactivating a doctor record removes their patient access through the app and the REST API

## Department referrals

- [ ] Doctor A refers to a department alone (*Bo‘lim* chosen, doctor left at *Bo‘limning istalgan shifokori*): the review says *(birinchi qabul qilgan)*; the referral is *Kutilmoqda* under A's *Men yo‘llagan bemorlar* and not in A's incoming list
- [ ] Every active doctor of that department sees it under *Menga yo‘llangan bemorlar*, on the dashboard and in the *Yo‘llanmalar* count, and sees the patient's whole history without accepting
- [ ] Doctors of other departments, doctors without a department and doctors of another clinic (also a department of the same name) see no referral, no count change, and the patient's id gives *Bemor topilmadi*
- [ ] No one of the department sees *Rad etish* on it — only *Yo‘llanmani qabul qilish*
- [ ] One of them accepts (*Yo‘llanmani qabul qilish*, or by starting a consultation): they become the receiving doctor (their name shows on the referral), and it leaves the other department doctors' list and count; those who had no other link lose the patient (*Bemor topilmadi*)
- [ ] A doctor who refers a patient to their own department does not receive it themselves (not in their list or count); the other doctors of the department do
- [ ] A second open referral of the same patient to the same department by the same doctor is refused (*Bu bemor u yerga allaqachon yo‘llangan*); allowed again once the first is closed
- [ ] The referring doctor or a manager revokes an untaken referral: every department doctor loses it at once
- [ ] The referral form offers only departments that have another active doctor
- [ ] `audit_events`: the acceptance that takes it is `referral_accepted` by the accepting doctor, with the department id, no reason text

## Patient profile and clinical records

- [ ] The patient page has the tabs *Umumiy*, *Qabullar*, *Klinik tarix*, *Tashxislar*, *Laboratoriya*, *Retseptlar*, *Yo‘llanmalar*; *Qabullar* lists every visit of the patient in the clinic, whoever held it (*Siz* on your own)
- [ ] *Bemorlarim* lists own patients (*Mening bemorim*; any visit that is neither cancelled nor a no-show, or a record you wrote) and patients with an open referral to you (*Yo‘llanma: …*); patients whose referral was revoked/expired (and no visit or record of yours) and unrelated patients are absent; search by name or phone digits works
- [ ] *Umumiy* shows *Javob kutayotgan yo‘llanmalar* for a pending referral; *Mening qabulim* lets the receiving doctor start a consultation immediately, without accepting first
- [ ] *Hozir qabulni boshlash* starts a walk-in (or *Qabulni boshlash* for today's booked visit); records saved there show *Siz yozgansiz* under *Mening qabulim*
- [ ] *Klinik tarix* shows the journey newest first — every doctor's visits with the records written in them, and the referrals; other doctors' records show *Muallif: …* and are never marked *Siz yozgansiz*
- [ ] *Tahrirlash* appears only on your own records; edit → *Saqlash* (no reason asked) replaces the text everywhere with the new version, marked *Tuzatilgan · 2-versiya*; the old text appears nowhere but under *Tarix*
- [ ] *Tarix* lists every version (oldest first) with author and time, the latest *Amaldagi*, the rest *Almashtirilgan*, and nothing in it can be edited
- [ ] A doctor reading another doctor's record (through a treating relationship or a referral) sees *Muallif: …* (and *Tarix* on corrected ones), never *Tahrirlash*
- [ ] Two tabs editing the same record: the second *Saqlash* says the edit was not saved because the record was updated meanwhile, shows the latest version and keeps the typed text in the form for a deliberate re-save — nothing is overwritten
- [ ] *Tashxislar* lists the current version of diagnoses, clinical assessments and *Anamnez*, *Laboratoriya* the lab orders and results, *Retseptlar* the prescriptions — each with author and date
- [ ] *Yo‘llanmalar* lists all of the patient's referrals with reason and note; *Yo‘llanmani qabul qilish* / *Rad etish* / *Yo‘llanmani yakunlash* appear only where you are the receiver, and there are no actions on a referral between two other doctors
- [ ] Accepted: no *Yakunlash* anywhere until Doctor B's consultation starts; the stepper shows *Qabul qilindi*
- [ ] Starting the consultation (patient page walk-in, today's booked visit, the queue or the front desk) moves the referral to *Qabul boshlangan*, accepting a pending one first; *Mening qabulim* says it is the referral's consultation
- [ ] Record types in *Mening qabulim*: *Joriy baho*, *Yangi tashxis*, *Klinik qayd*, *Retsept*, *Tahlilga yo‘llanma*, *Tahlil natijasi*, *Anamnez*, *Keyingi qadam / yo‘llanma* — all *Siz yozgansiz*; Doctor A's diagnosis stays *Oldingi tashxis* with *Muallif: …* and is unchanged
- [ ] *Yo‘llanmani yakunlash* asks for confirmation; afterwards Doctor B keeps the patient's history through their own consultation, and Doctor A sees Doctor B's records on the follow-up, authored by Doctor B
- [ ] `audit_events`: `referral_accepted` / `referral_declined` / `referral_in_progress` / `referral_completed` / `consultation_started` rows with ids only; opening a patient page writes `clinical_record_viewed`, a refused one `unauthorized_clinical_access_attempt`
- [ ] Payments: a booked or in-progress visit of your own shows *To‘lov: …* (status only); no amount or price appears in the page or its API response, and no other visit shows a payment; with a doctor's own token `GET /rest/v1/payments` returns no rows
- [ ] After revoke / expiry of a referral that was the only link: the page shows *Yo‘llanma bekor qilingan* / *muddati tugagan* with no patient data; an unrelated patient id shows *Bemor topilmadi*
- [ ] Reception, managers and owners never see clinical records (patient panel, REST API)

## Doctor portal on phones and tablets

- [ ] Phone (≤ 767px): the strip under the header reaches *Bugungi navbat*, *Bemorlarim*, *Yo‘llanmalar*, *Jadvalim*; no page scrolls sideways
- [ ] Phone: patient page — referral card, lifecycle stepper, record form and *Yozuvni saqlash* fit the width; the referral dialog and review fit the screen
- [ ] Tablet (768–1024px): sidebar navigation; referral list, detail (*Qabul qilish*) and patient page usable without sideways scrolling

## Referral lifecycle and audit

- [ ] The patient page of a doctor whose access rests only on a referral shows *Yo‘llanma bo‘yicha kirish … da tugaydi*; a doctor with their own visit or record with the patient does not see it
- [ ] A short-lived referral: at its expiry Doctor B — if it was their only link to the patient — gets *Yo‘llanma muddati tugagan* immediately; `POST /api/referrals/expire` without the bearer → 401, with it → `{ ok: true, expired: n }` and status `expired`
- [ ] Revoke (Doctor A or a manager): Doctor B's next request is refused unless B has their own visit or record with the patient
- [ ] Completed: Doctor B keeps the history through their own consultation; after the referral's validity ends Doctor B no longer opens the referral and Doctor A still sees Doctor B's follow-up
- [ ] With a doctor's own token, `GET /rest/v1/referrals` and `/rest/v1/clinical_records` → permission denied
- [ ] `audit_events` rows for each step carry `patient_id`, `referral_id`, actor (or `system` for expiry); a manager of another clinic sees none of them; no UPDATE/DELETE possible
- [ ] Rows written after migration `20261002000001` use `clinical_record_viewed`, `unauthorized_clinical_access_attempt`, `unauthorized_clinical_mutation_attempt`, `clinical_record_version_created` and `referral_opened`; rows written before it keep the old names (see [security.md](security.md#audit-event-names)), so a report spanning that date matches both

## Acceptance journey (longitudinal history)

One patient, followed by hand through registration, care, handoff and return. Cast: reception; Doctor
A (e.g. general medicine); Doctor B and Doctor B2 (same department, e.g. cardiology); Doctor C (same
clinic, any department); Doctor D (same clinic, unrelated); Doctor K (another clinic). Use a phone
number nobody in the clinic has, e.g. `+998 90 123 45 67`.

1. [ ] **Reception registers a new patient.** *Tezkor qabul yozish* with a new name and that phone, booked with Doctor A → created; `/admin/patients` shows exactly one such patient
2. [ ] **Doctor A examines and records.** Doctor A opens the patient from the queue, *Qabulni boshlash*, saves a diagnosis (*Yangi tashxis*) and a clinical note → both show *Siz yozgansiz*
3. [ ] **Doctor A refers to a department.** *Yo‘llanma* → *Bo‘lim*: cardiology, doctor left at *Bo‘limning istalgan shifokori*, reason and note → review → send. The referral is *Kutilmoqda* under *Men yo‘llagan bemorlar* and is not in Doctor A's incoming list
4. [ ] **Every doctor of the department sees it and the history — no approval.** Doctor B and Doctor B2 each have the referral in *Menga yo‘llangan bemorlar*, on the dashboard and in the count. Each opens the patient before accepting and sees Doctor A's visit and diagnosis with *Muallif: …*; the only action offered is *Yo‘llanmani qabul qilish* (no *Rad etish*). Doctor D and Doctor K have no referral, and the patient is *Bemor topilmadi*
5. [ ] **Doctor B starts a consultation.** *Hozir qabulni boshlash*: the referral is accepted automatically and becomes Doctor B's — *Qabul boshlangan*, Doctor B named as the receiving doctor — and leaves Doctor B2's list and count (Doctor B2 no longer opens the patient). Doctor B saves their own assessment (*Joriy baho*) → *Siz yozgansiz*
6. [ ] **Doctor B cannot edit Doctor A's record.** There is no *Tahrirlash* on it; a correction sent to the API is 403 `CLINICAL_RECORD_NOT_OWNED`; with Doctor B's own token, updating or deleting it over `/rest/v1/clinical_records` is denied; the record is unchanged; `audit_events` has `unauthorized_clinical_mutation_attempt` (`not_owned`)
7. [ ] **Doctor A corrects their own record.** *Tahrirlash* → *Saqlash* (no reason asked) → *Tuzatilgan · 2-versiya*; *Tarix* lists version 1 *Almashtirilgan* and version 2 *Amaldagi*; `audit_events` has `clinical_record_version_created`
8. [ ] **The patient returns.** Reception searches the phone typed differently (`90 123 45 67`, `901234567`, `+998901234567`) → the same patient. Trying *Tezkor qabul yozish* for a "new" patient with that phone shows *Bu telefon raqami bilan ro‘yxatdan o‘tgan bemor(lar)* and creates nothing; *Shu bemor* books the existing patient (book them with Doctor C). *Yo‘q, bu boshqa odam — yangi bemor sifatida yozish* registers a genuinely different person who shares the phone (two patients, the new one with an empty history); editing the phone after that clears the confirmation and the check runs again
9. [ ] **Doctor C sees the longitudinal history.** Doctor C (booked with the patient) opens the patient: *Klinik tarix* shows Doctor A's and Doctor B's visits and records, each with its author, Doctor A's diagnosis as version 2; the referral is listed under *Yo‘llanmalar* with no actions
10. [ ] **Unrelated doctors see nothing.** Doctor D (same clinic, no relationship) and Doctor K (another clinic) get *Bemor topilmadi* for the patient page, 404 from `GET /api/doctor/patients/<id>`, and no row from `/rest/v1/patients`; `audit_events` has `unauthorized_clinical_access_attempt` for Doctor D
11. [ ] **Payments: only the status of your own visit.** Doctor C's page shows *To‘lov: …* for their own booked visit and nothing for any other visit; no amount or price appears in the page or its API response

## Notifications

- [ ] Cloud Scheduler runs; reminder arrives ~1h before a confirmed appointment
- [ ] GET /api/notifications/process without bearer → 401
- [ ] Webhook POST without X-Telegram-Bot-Api-Secret-Token → 401

## Security

- [ ] No real secrets in the repo (`git grep -E "sk-|service_role" --not-include=*.example*`)
- [ ] RLS: anon can't read patients/appointments (curl with anon key)
- [ ] HSTS + security headers present (curl -I)
- [ ] Audit log shows payment transitions and staff mutations

## Infra

- [ ] `GET /api/health` 200 from the load balancer
- [ ] Rollback procedure rehearsed (revision switch < 2 min)