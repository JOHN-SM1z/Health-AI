-- 0031: Distinguish genuine self-service website bookings from reception
-- walk-ins (Phase 5 booking-workflow audit).
--
-- api/bookings/route.ts's non-Telegram fallback (a patient booking directly
-- through the website, with no Telegram identity at all) was tagging its
-- appointment_source as 'walk_in' — the SAME value api/admin/appointments
-- uses for a real front-desk walk-in a staff member enters on a patient's
-- behalf. Analytics could not distinguish "patient booked themselves
-- online" from "reception typed this in at the desk," even though they are
-- different channels with different operational meaning. Adds 'web' as its
-- own value; existing 'walk_in' rows are untouched (they remain correctly
-- attributed to reception-entered walk-ins).

alter type public.appointment_source add value if not exists 'web' after 'telegram_chat';
