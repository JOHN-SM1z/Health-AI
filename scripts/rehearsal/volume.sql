-- Synthetic volume for the upgrade rehearsal (scripts/rehearse-upgrade.sh): 500k patients with
-- realistic and hostile phone formats, 200k appointments with payments, 1M audit rows, in 5 clinics.
-- Fixture data only (generated; no real patient data). Loaded with triggers off so it does not
-- write its own audit rows. LOCAL DATABASE ONLY.
\timing on
set session_replication_role = replica;
insert into public.clinics (id, name, slug, timezone)
select gen_random_uuid(), 'Volume clinic '||i, 'volume-'||i, 'Asia/Tashkent' from generate_series(1,5) i;
insert into public.doctors (clinic_id, name, active)
select c.id, 'Dr '||c.slug||'-'||d, true from public.clinics c cross join generate_series(1,40) d where c.slug like 'volume-%';
insert into public.services (clinic_id, name, duration_minutes, price, active)
select id, 'Volume service', 30, 100000, true from public.clinics where slug like 'volume-%';

create temp table cl as select id, (row_number() over (order by slug))::int ci from public.clinics where slug like 'volume-%';
insert into public.patients (clinic_id, full_name, phone, telegram_user_id)
select cl.id, 'Volume patient '||g,
  case when r < 40 then '+998 9'||substr(d8,1,1)||' '||substr(d8,2,3)||' '||substr(d8,5,2)||' '||substr(d8,7,2)
       when r < 70 then '9'||d8 when r < 80 then '998'||'9'||d8 when r < 85 then '+7 9'||substr(d8,1,2)||' '||substr(d8,3,6)
       when r < 90 then '00998 9'||d8 when r < 94 then substr(d8,1,5) when r < 96 then null else '+998901234567' end,
  case when r >= 94 and r < 98 then 700000000 + g else null end
from (select g, 1 + (g % 5) ci, (random()*100)::int r, lpad((floor(random()*90000000)+10000000)::text, 8, '0') d8 from generate_series(1, 500000) g) x
join cl using (ci);

create temp table dd as select id, clinic_id, (row_number() over (partition by clinic_id order by name))::int rn from public.doctors where name like 'Dr volume-%';
create temp table pp as select id, clinic_id, (row_number() over (partition by clinic_id order by id))::int rn from public.patients;
create temp table ss as select id, clinic_id from public.services where name = 'Volume service';
create index on dd (clinic_id, rn); create index on pp (clinic_id, rn);
insert into public.appointments (clinic_id, patient_id, doctor_id, service_id, start_at, end_at, status, source)
select cl.id, pp.id, dd.id, ss.id,
  timestamptz '2025-01-01 00:00+00' + (k / 40) * interval '30 minutes',
  timestamptz '2025-01-01 00:00+00' + (k / 40) * interval '30 minutes' + interval '30 minutes', 'completed', 'walk_in'
from (select g, 1 + (g % 5) ci, (g / 5) k from generate_series(0, 199999) g) gen
join cl using (ci)
join pp on pp.clinic_id = cl.id and pp.rn = 1 + (gen.k % 90000)
join dd on dd.clinic_id = cl.id and dd.rn = 1 + (gen.k % 40)
join ss on ss.clinic_id = cl.id;
insert into public.payments (clinic_id, appointment_id, patient_id, amount, status)
select clinic_id, id, patient_id, 100000, 'paid' from public.appointments;

insert into public.audit_events (clinic_id, actor_type, action, entity_type, entity_id, metadata)
select cl.id, 'system', 'volume_event', 'appointments', g::text, '{}'::jsonb from generate_series(1,1000000) g join cl on cl.ci = 1 + (g % 5);
set session_replication_role = origin;
analyze;
select (select count(*) from public.patients) patients, (select count(*) from public.appointments) appointments,
       (select count(*) from public.payments) payments, (select count(*) from public.audit_events) audit_events,
       pg_size_pretty(pg_database_size('postgres')) db_size;
