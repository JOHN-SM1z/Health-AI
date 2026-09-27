# Manual QA checklist

Run against the deployed environment (or local stack with dev mode) before go-live.
Each row: expected behavior. Mark all green = go.

Automated on every push (CI) and locally with `npm run e2e:seed && npm run test:e2e` against
the built app: the doctor-to-doctor referral workflow at desktop, tablet and phone widths
(including the lapsed-referral states and the reception/manager screens) and the HTTP red team.
The rows below cover what those scripts do not: the Telegram bot and Mini App, payments,
notifications, and a human's eye on every screen.

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

- [ ] Doctor sees only their own queue
- [ ] checked_in → in_progress → completed flow works
- [ ] Doctor cannot see or mutate other doctors' appointments
- [ ] Self-service break blocks the slot for patients

## Referrals

- [ ] Doctor: *Yo‘llanma* on an in-progress/completed consultation → colleague list excludes self; reason required
- [ ] *Ko‘rib chiqish* shows doctor, priority, validity, reason and note; *Tahrirlash* keeps the input; nothing is sent before *Yo‘llanma yuborish*
- [ ] Double-clicking *Yo‘llanma yuborish* creates one referral and one `referral_created` audit row
- [ ] Receiving doctor's `/doctor` dashboard shows *Sizga kelgan yo‘llanmalar (n)* with patient, referrer and priority only
- [ ] Referral appears as *Kutilmoqda* under *Yuborilgan* (referrer) and *Kelgan* (receiver)
- [ ] Receiver sees no appointment history until *Qabul qilish*; after accepting, history with the referrer appears
- [ ] Declining/revoking with a reason works; the receiver can no longer open a declined/revoked referral (404 page)
- [ ] A doctor who is not a party gets *Yo‘llanma topilmadi* for the referral URL
- [ ] Reception: patient panel shows *Yo‘llanmalar* (doctors, status, priority) but never the reason/handoff note; *Qabulga yozish* books with the receiving doctor only, then disappears
- [ ] Only owner/admin/manager see *Bekor qilish* on a referral in the patient panel
- [ ] Owner/manager account linked to a doctor record is refused on `/api/doctor/referrals` (403)
- [ ] `audit_events` has `referral_created/accepted/follow_up_booked/viewed` rows without the reason/handoff text
- [ ] With a doctor's own token, `GET /rest/v1/patients?id=eq.<X>` is empty for a same-clinic doctor with no relationship to X, and returns X for the receiving doctor only while the referral is pending/accepted and unexpired
- [ ] `GET /api/doctor/patients/<X>`: 200 for X's own doctor and the receiving doctor (accepted → referring doctor's visits only); 404 for anyone else; 410 with the reason for the receiving doctor after revoke, decline, completion or expiry
- [ ] Doctor queue → patient name opens the patient page (*Mening bemorim*, *Yo‘llanma* on own attended visits); referral → patient name opens it as *Yo‘llanma bo‘yicha* with only the handed-over visits
- [ ] A doctor's own token cannot update or delete appointments via `/rest/v1/appointments`, nor read `voice-messages` storage objects
- [ ] Deactivating a doctor record removes their patient access through the app and the REST API

## Clinical workspace

- [ ] *Yo‘llanmalar → Menga yo‘llangan bemorlar* lists each referral with patient, referring doctor, reason, handoff note, status, sent and expiry dates, priority
- [ ] Pending referral: workspace shows the patient and the consultation it came from; *Mening qabulim* asks to accept first
- [ ] Accepted: the referring doctor's records appear with *Muallif: …* and date; none are marked *Siz yozgansiz*; another doctor's records never appear
- [ ] *Hozir qabulni boshlash* starts a walk-in (or *Qabulni boshlash* for today's booked visit); records saved there show *Siz yozgansiz* under *Mening qabulim*, apart from *Oldingi yozuvlar*
- [ ] A record can't be edited; *Tuzatish* (in the current or a previous consultation) adds a correction and marks the original *Tuzatilgan*
- [ ] *Klinik xulosa* lists diagnoses, history, prescriptions and lab results in force — a corrected record gives way to its correction — each with author and date
- [ ] Pending referral: *Yo‘llanmani qabul qilish* in the workspace unlocks *Hozir qabulni boshlash*; *Rad etish* (optional reason) declines it and the page shows *Yo‘llanma rad etilgan*
- [ ] Accepted: no *Yakunlash* anywhere until Doctor B's consultation starts; the stepper shows *Qabul qilindi*
- [ ] Starting the consultation (workspace walk-in, today's booked visit, the queue or the front desk) moves the referral to *Qabul boshlangan*; *Mening qabulim* says it is the referral's consultation
- [ ] Record types in *Mening qabulim*: *Joriy baho*, *Yangi tashxis*, *Klinik qayd*, *Retsept*, *Tahlilga yo‘llanma*, *Tahlil natijasi*, *Anamnez*, *Keyingi qadam / yo‘llanma* — all *Siz yozgansiz*; Doctor A's diagnosis stays *Oldingi tashxis* with *Muallif: …* and is unchanged
- [ ] *Yo‘llanmani yakunlash* asks for confirmation; afterwards Doctor B keeps their own consultation, and Doctor A sees Doctor B's records on the follow-up, authored by Doctor B
- [ ] `audit_events`: `referral_accepted` / `referral_declined` / `referral_in_progress` / `referral_completed` / `consultation_started` rows with ids only
- [ ] *Bemorlarim* lists own patients (*Mening bemorim*, last visit that took place) and actively referred ones; revoked, expired and unrelated patients are absent; search by name or phone digits
- [ ] After revoke / expiry: the workspace shows *Yo‘llanma bekor qilingan* / *muddati tugagan* with no patient data; an unrelated patient id shows *Bemor topilmadi*
- [ ] Reception, managers and owners never see clinical records (patient panel, REST API)

## Doctor portal on phones and tablets

- [ ] Phone (≤ 767px): the strip under the header reaches *Bugungi navbat*, *Bemorlarim*, *Yo‘llanmalar*, *Jadvalim*; no page scrolls sideways
- [ ] Phone: patient page — referral card, lifecycle stepper, record form and *Yozuvni saqlash* fit the width; the referral dialog and review fit the screen
- [ ] Tablet (768–1024px): sidebar navigation; referral list, detail (*Qabul qilish*) and patient page usable without sideways scrolling

## Referral lifecycle and audit

- [ ] Workspace header of a referred patient shows *Yo‘llanma bo‘yicha kirish … da tugaydi*
- [ ] A short-lived referral: at its expiry Doctor B gets *Yo‘llanma muddati tugagan* immediately; `POST /api/referrals/expire` without the bearer → 401, with it → `{ ok: true, expired: n }` and status `expired`
- [ ] Revoke (Doctor A or a manager): Doctor B's next request is refused
- [ ] Completed: Doctor B sees only their own consultation; after the referral's validity ends Doctor B no longer opens the referral and Doctor A no longer sees Doctor B's follow-up
- [ ] With a doctor's own token, `GET /rest/v1/referrals` and `/rest/v1/clinical_records` → permission denied
- [ ] `audit_events` rows for each step carry `patient_id`, `referral_id`, actor (or `system` for expiry); a manager of another clinic sees none of them; no UPDATE/DELETE possible

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