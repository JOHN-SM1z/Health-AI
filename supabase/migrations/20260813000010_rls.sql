-- 0010: Row Level Security policies.
--
-- Model:
--  * Staff (Supabase Auth users) are governed by these policies through the
--    browser client (anon key + session). Owner/admin/doctor roles are
--    enforced here AND in the application layer.
--  * Patients are NOT Supabase users. Patient data flows only through
--    server-side code that verifies the Telegram identity first; the
--    application layer scopes every query by clinic and patient.
--    No anon policy exists anywhere, so the anon role can read nothing.
--  * Service-role server code (bot, cron, admin APIs) runs with RLS
--    bypassed and performs explicit authorization checks in code.

alter table public.clinics enable row level security;
alter table public.profiles enable row level security;
alter table public.staff_roles enable row level security;
alter table public.patients enable row level security;
alter table public.specialties enable row level security;
alter table public.services enable row level security;
alter table public.doctors enable row level security;
alter table public.doctor_services enable row level security;
alter table public.doctor_working_hours enable row level security;
alter table public.doctor_time_blocks enable row level security;
alter table public.appointments enable row level security;
alter table public.payments enable row level security;
alter table public.faq_entries enable row level security;
alter table public.app_settings enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.voice_messages enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.processed_webhooks enable row level security;
alter table public.audit_events enable row level security;
alter table public.analytics_events enable row level security;

-- ---------- clinics ----------
create policy "clinic read for its staff"
  on public.clinics for select
  to authenticated
  using (public.is_clinic_staff(id));

create policy "clinic update for owner"
  on public.clinics for update
  to authenticated
  using (public.is_clinic_staff(id, array['owner'::public.staff_role]))
  with check (public.is_clinic_staff(id, array['owner'::public.staff_role]));

-- ---------- profiles ----------
create policy "profile read own"
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

create policy "profile read for clinic staff"
  on public.profiles for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    where sr.profile_id = auth.uid()
      and sr.clinic_id = (select p.clinic_id from public.staff_roles p where p.profile_id = profiles.id limit 1)
  ));

create policy "profile insert own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "profile update own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- staff_roles ----------
create policy "staff_roles read for same clinic staff"
  on public.staff_roles for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "staff_roles manage for owner"
  on public.staff_roles for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role]));

-- ---------- patients ----------
-- Admin/owner see all clinic patients; doctors see patients of their own
-- appointments only (limited operational details needed for the queue).
create policy "patients read for admin owner"
  on public.patients for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "patients read for own doctor"
  on public.patients for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    join public.appointments a on a.doctor_id = d.id and a.patient_id = patients.id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = patients.clinic_id
  ));

create policy "patients update for admin owner"
  on public.patients for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- catalog (specialties, services, doctors, doctor_services) ----------
create policy "specialties read for staff"
  on public.specialties for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "specialties write for admin owner"
  on public.specialties for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "services read for staff"
  on public.services for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "services write for admin owner"
  on public.services for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "doctors read for staff"
  on public.doctors for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "doctors write for admin owner"
  on public.doctors for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "doctor_services read for staff"
  on public.doctor_services for select
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  )));

create policy "doctor_services write for admin owner"
  on public.doctor_services for all
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- schedules ----------
create policy "working_hours read for staff"
  on public.doctor_working_hours for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "working_hours write for admin owner"
  on public.doctor_working_hours for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "time_blocks read for staff"
  on public.doctor_time_blocks for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "time_blocks write for admin owner"
  on public.doctor_time_blocks for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- appointments ----------
create policy "appointments read for admin owner"
  on public.appointments for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments read for own doctor"
  on public.appointments for select
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = appointments.clinic_id
      and d.id = appointments.doctor_id
  ));

create policy "appointments write for admin owner"
  on public.appointments for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments update for admin owner"
  on public.appointments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "appointments status update for own doctor"
  on public.appointments for update
  to authenticated
  using (exists (
    select 1 from public.staff_roles sr
    join public.doctors d on d.profile_id = sr.profile_id
    where sr.profile_id = auth.uid()
      and sr.role = 'doctor'::public.staff_role
      and sr.clinic_id = appointments.clinic_id
      and d.id = appointments.doctor_id
  ));

-- ---------- payments ----------
create policy "payments read for staff"
  on public.payments for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role])
      or exists (
        select 1 from public.staff_roles sr
        join public.doctors d on d.profile_id = sr.profile_id
        join public.appointments a on a.id = payments.appointment_id and a.doctor_id = d.id
        where sr.profile_id = auth.uid()
          and sr.role = 'doctor'::public.staff_role
          and sr.clinic_id = payments.clinic_id
      ));

create policy "payments update for admin owner"
  on public.payments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- faqs & settings ----------
create policy "faqs read for staff"
  on public.faq_entries for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "faqs write for admin owner"
  on public.faq_entries for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "settings read for staff"
  on public.app_settings for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

create policy "settings write for admin owner"
  on public.app_settings for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- conversations ----------
create policy "conversations read for staff"
  on public.conversations for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "conversations update for admin owner"
  on public.conversations for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- messages ----------
create policy "messages read for staff"
  on public.messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- voice messages ----------
create policy "voice_messages read for staff"
  on public.voice_messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- notification jobs ----------
create policy "notification_jobs read for admin owner"
  on public.notification_jobs for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

create policy "notification_jobs update for admin owner"
  on public.notification_jobs for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- audit ----------
create policy "audit read for admin owner"
  on public.audit_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- ---------- analytics ----------
create policy "analytics read for admin owner"
  on public.analytics_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role]));

-- No policies exist for: processed_webhooks (server-side only), and no
-- insert/delete policies exist on any table for anon or unauthenticated roles.