-- ============================================================================
-- LOCAL DEVELOPMENT SEED DATA — NEVER run in production.
-- Applied automatically by `supabase db reset` (local only).
-- ============================================================================

insert into public.clinics (id, name, slug, timezone, phone, address, email, currency, opening_hours, privacy_notice)
values (
  '11111111-1111-4111-8111-111111111111',
  'Health AI Namuna Klinikasi',
  'health-ai-demo',
  'Asia/Tashkent',
  '+998 71 000 00 00',
  'Toshkent sh., Navoiy ko‘chasi 1',
  'info@example.uz',
  'UZS',
  '{"mon": "09:00-18:00", "tue": "09:00-18:00", "wed": "09:00-18:00", "thu": "09:00-18:00", "fri": "09:00-18:00", "sat": "09:00-14:00", "sun": null}',
  'Sizning ma‘lumotlaringiz faqat qabul jarayonini tashkil qilish uchun ishlatiladi va shifokor xonasidan tashqariga chiqarilmaydi.'
);

insert into public.specialties (clinic_id, name, description, sort_order)
values
  ('11111111-1111-4111-8111-111111111111', 'Terapiya', 'Umumiy terapiya — katta yoshli bemorlar uchun', 1),
  ('11111111-1111-4111-8111-111111111111', 'Kardiologiya', 'Yurak va qon-tomir kasalliklari', 2),
  ('11111111-1111-4111-8111-111111111111', 'Dermatologiya', 'Teri kasalliklari', 3),
  ('11111111-1111-4111-8111-111111111111', 'Pediatriya', 'Bolalar salomatligi', 4);

insert into public.services (clinic_id, specialty_id, name, description, duration_minutes, price, preparation_text, sort_order)
values
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Terapiya'), 'Terapevt qabuli', 'Umumiy shifokor ko‘rigi', 20, 150000, null, 1),
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Kardiologiya'), 'Kardiolog qabuli', 'Kardiolog bilan konsultatsiya', 30, 250000, 'Qon bosimi o‘lchangan holda keling', 2),
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Dermatologiya'), 'Dermatolog qabuli', 'Teri kasalliklari bo‘yicha konsultatsiya', 30, 200000, null, 3),
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Pediatriya'), 'Pediatr qabuli', 'Bola shifokori ko‘rigi', 20, 180000, null, 4),
  ('11111111-1111-4111-8111-111111111111', null, 'Umumiy konsultatsiya', 'Yo‘nalish aniq bo‘lmaganda umumiy qabul', 20, 120000, null, 5);

insert into public.doctors (clinic_id, specialty_id, name, title, bio, active)
values
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Terapiya'), 'Karimov Alisher', 'Terapevt, 1-toifa', '15 yillik tajriba', true),
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Kardiologiya'), 'Rahimova Dilnoza', 'Kardiolog', '10 yillik tajriba', true),
  ('11111111-1111-4111-8111-111111111111', (select id from public.specialties where name = 'Pediatriya'), 'Yusupova Malika', 'Pediatr', '8 yillik tajriba', true);

insert into public.doctor_services (doctor_id, service_id)
select d.id, s.id
from public.doctors d
join public.specialties sp on sp.id = d.specialty_id
join public.services s on s.specialty_id = sp.id;

-- The general consultation (no specialty) is offered by the general
-- therapist; otherwise it is unbookable because the doctors above have
-- explicit (closed) service lists.
insert into public.doctor_services (doctor_id, service_id)
select d.id, s.id
from public.doctors d
cross join public.services s
where s.name = 'Umumiy konsultatsiya'
  and d.name = 'Karimov Alisher';

insert into public.doctor_working_hours (clinic_id, doctor_id, weekday, start_time, end_time)
select '11111111-1111-4111-8111-111111111111', d.id, wh.weekday, wh.start_time, wh.end_time
from public.doctors d
cross join (
  values (1, '09:00'::time, '18:00'::time),
         (2, '09:00'::time, '18:00'::time),
         (3, '09:00'::time, '18:00'::time),
         (4, '09:00'::time, '18:00'::time),
         (5, '09:00'::time, '18:00'::time),
         (6, '09:00'::time, '14:00'::time)
) as wh(weekday, start_time, end_time);

insert into public.faq_entries (clinic_id, question, answer, category, sort_order)
values
  ('11111111-1111-4111-8111-111111111111', 'Qabulga qanday yozilish mumkin?', 'Telegram bot orqali “Qabulga yozilish” tugmasini bosib, qulay vaqtni tanlang. Shuningdek, operatorga qo‘ng‘iroq qilishingiz mumkin.', 'Qabul', 1),
  ('11111111-1111-4111-8111-111111111111', 'Klinika qayerda joylashgan?', 'Toshkent sh., Navoiy ko‘chasi 1. Telefon: +998 71 000 00 00.', 'Manzil', 2),
  ('11111111-1111-4111-8111-111111111111', 'Ish vaqti qanday?', 'Dushanba–Juma 09:00–18:00, Shanba 09:00–14:00. Yakshanba dam olish kuni.', 'Ish vaqti', 3),
  ('11111111-1111-4111-8111-111111111111', 'To‘lov qanday amalga oshiriladi?', 'Qabulga kelganingizda klinika qabulxonasida naqd yoki karta orqali to‘lashingiz mumkin.', 'To‘lov', 4);

insert into public.patients (clinic_id, telegram_user_id, telegram_username, telegram_first_name, full_name, phone, consent_given, consent_given_at)
values
  ('11111111-1111-4111-8111-111111111111', 777000, 'demo_patient', 'Demo', 'Demo Bemor', '+998 90 000 00 00', true, now());

insert into public.app_settings (clinic_id, key, value)
values
  ('11111111-1111-4111-8111-111111111111', 'booking_notes', '{"required_fields": ["full_name", "phone"]}'),
  ('11111111-1111-4111-8111-111111111111', 'reminder_hours', '{"reminder_24h": true, "reminder_2h": true}');