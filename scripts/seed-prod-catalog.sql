-- ============================================================================
-- PRODUCTION CATALOG SEED (run manually — NOT auto-applied)
-- ============================================================================
-- Fixes "Xizmatlar hozircha kiritilmagan" in the deployed Mini App when the
-- production database has a clinic but an empty catalog (no specialties,
-- services, doctors, working hours).
--
-- Idempotent: safe to re-run; upserts by unique keys.
--
-- How to run:
--   Option A (SQL editor): supabase.com/dashboard -> SQL Editor -> paste -> Run
--   Option B (psql):       psql "postgresql://postgres:<pass>@<host>:5432/postgres" -f scripts/seed-prod-catalog.sql
--
-- Requires: a clinic row. The script resolves the target clinic by id, then
-- by slug. It FAILS loudly (raises) if neither matches.
-- ============================================================================

do $$
declare
  v_clinic_id uuid;
begin
  select id into v_clinic_id
    from public.clinics
    where id = 'f5329947-da01-4044-a87b-45e191b5a23d';

  if v_clinic_id is null then
    select id into v_clinic_id
      from public.clinics
      where slug = 'my-clinic';
  end if;

  if v_clinic_id is null then
    raise exception 'Klinika topilmadi: seed-prod-catalog.sql faqat mavjud klinika uchun ishlaydi. Avval create-owner skriptini ishga tushiring yoki klinika id sini skriptdagi qiymatga almashtiring.';
  end if;

  -- ---------- Specialties ----------
  insert into public.specialties (clinic_id, name, description, sort_order) values
    (v_clinic_id, 'Terapiya', 'Umumiy terapiya — katta yoshli bemorlar uchun', 1),
    (v_clinic_id, 'Kardiologiya', 'Yurak va qon-tomir kasalliklari', 2),
    (v_clinic_id, 'Dermatologiya', 'Teri kasalliklari', 3),
    (v_clinic_id, 'Pediatriya', 'Bolalar salomatligi', 4)
  on conflict (clinic_id, name) do update set
    description = excluded.description,
    sort_order = excluded.sort_order;

  -- ---------- Services ----------
  insert into public.services (clinic_id, specialty_id, name, description, duration_minutes, price, preparation_text, sort_order)
  select v_clinic_id, sp.id, s.name, s.description, s.duration_minutes, s.price, s.preparation_text, s.sort_order
  from (values
    ('Terapiya', 'Terapevt qabuli', 'Umumiy shifokor ko‘rigi', 20, 150000, null, 1),
    ('Kardiologiya', 'Kardiolog qabuli', 'Kardiolog bilan konsultatsiya', 30, 250000, 'Qon bosimi o‘lchangan holda keling', 2),
    ('Dermatologiya', 'Dermatolog qabuli', 'Teri kasalliklari bo‘yicha konsultatsiya', 30, 200000, null, 3),
    ('Pediatriya', 'Pediatr qabuli', 'Bola shifokori ko‘rigi', 20, 180000, null, 4),
    (null, 'Umumiy konsultatsiya', 'Yo‘nalish aniq bo‘lmaganda umumiy qabul', 20, 120000, null, 5)
  ) as s(specialty_name, name, description, duration_minutes, price, preparation_text, sort_order)
  left join public.specialties sp on sp.clinic_id = v_clinic_id and sp.name = s.specialty_name
  on conflict (clinic_id, name) do update set
    specialty_id = excluded.specialty_id,
    description = excluded.description,
    duration_minutes = excluded.duration_minutes,
    price = excluded.price,
    preparation_text = excluded.preparation_text,
    sort_order = excluded.sort_order,
    active = true,
    updated_at = now();

  -- ---------- Doctors ----------
  insert into public.doctors (clinic_id, specialty_id, name, title, bio, active)
  select v_clinic_id, sp.id, d.name, d.title, d.bio, true
  from (values
    ('Terapiya', 'Karimov Alisher', 'Terapevt, 1-toifa', '15 yillik tajriba'),
    ('Kardiologiya', 'Rahimova Dilnoza', 'Kardiolog', '10 yillik tajriba'),
    ('Pediatriya', 'Yusupova Malika', 'Pediatr', '8 yillik tajriba')
  ) as d(specialty_name, name, title, bio)
  left join public.specialties sp on sp.clinic_id = v_clinic_id and sp.name = d.specialty_name
  on conflict do nothing;

  -- ---------- doctor_services (doctors offer services of their specialty) ----------
  insert into public.doctor_services (doctor_id, service_id)
  select d.id, s.id
  from public.doctors d
  join public.specialties sp on sp.id = d.specialty_id
  join public.services s on s.specialty_id = sp.id and s.clinic_id = v_clinic_id
  where d.clinic_id = v_clinic_id
  on conflict do nothing;

  -- The general consultation (no specialty) is offered by the therapist.
  insert into public.doctor_services (doctor_id, service_id)
  select d.id, s.id
  from public.doctors d
  cross join public.services s
  where d.clinic_id = v_clinic_id
    and s.clinic_id = v_clinic_id
    and s.name = 'Umumiy konsultatsiya'
    and d.name = 'Karimov Alisher'
  on conflict do nothing;

  -- ---------- Working hours (Mon–Sat 09:00–18:00) ----------
  insert into public.doctor_working_hours (clinic_id, doctor_id, weekday, start_time, end_time)
  select v_clinic_id, d.id, wh.weekday, wh.start_time, wh.end_time
  from public.doctors d
  cross join (values
    (1, '09:00'::time, '18:00'::time),
    (2, '09:00'::time, '18:00'::time),
    (3, '09:00'::time, '18:00'::time),
    (4, '09:00'::time, '18:00'::time),
    (5, '09:00'::time, '18:00'::time),
    (6, '09:00'::time, '14:00'::time)
  ) as wh(weekday, start_time, end_time)
  where d.clinic_id = v_clinic_id
  on conflict (doctor_id, weekday) do nothing;

  raise notice 'Catalog seed complete for clinic %', v_clinic_id;
end $$;