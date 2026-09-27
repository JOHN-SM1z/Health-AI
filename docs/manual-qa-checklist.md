# Manual QA checklist

Run against the deployed environment (or local stack with dev mode) before go-live.
Each row: expected behavior. Mark all green = go.

## Telegram bot

- [ ] `/start` shows the menu with the Mini App button and booking entry
- [ ] Menu → "Qabulga yozilish" → choose service → doctor → time slot → confirm
- [ ] Confirmation message arrives; appointment appears in "Mening qabullarim"
- [ ] Booking a slot that someone else just booked → friendly "band" message (no double-book)
- [ ] Booking outside working hours / doctor's break → clear rejection message
- [ ] Cancel an appointment → confirmation message; slot becomes free again
- [ ] "Shifokor tanlashda yordam" answers from FAQ/catalog; NOT a diagnosis
- [ ] Urgency keywords (e.g. "yurak og'riyapti", "вызовите скорую", "chest pain")
      → escalation message + Telegram alert to TELEGRAM_ADMIN_CHAT_IDS
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
- [ ] Referral appears as *Kutilmoqda* under *Yuborilgan* (referrer) and *Kelgan* (receiver)
- [ ] Receiver sees no appointment history until *Qabul qilish*; after accepting, history with the referrer appears
- [ ] Declining/revoking with a reason works; the receiver can no longer open a declined/revoked referral (404 page)
- [ ] A doctor who is not a party gets *Yo‘llanma topilmadi* for the referral URL
- [ ] Reception: patient panel shows *Yo‘llanmalar* (doctors, status, priority) but never the reason/handoff note; *Qabulga yozish* books with the receiving doctor only, then disappears
- [ ] Only owner/admin/manager see *Bekor qilish* on a referral in the patient panel
- [ ] Owner/manager account linked to a doctor record is refused on `/api/doctor/referrals` (403)
- [ ] `audit_events` has `referral_created/accepted/follow_up_booked/viewed` rows without the reason/handoff text

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