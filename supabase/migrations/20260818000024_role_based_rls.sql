-- 0024: Role-based RLS policy rewrites (manager, receptionist, operator).
--
-- Follows 0023 (roles + platform_admins). PostgreSQL forbids referencing a
-- new enum value in the migration that adds it, so every policy that names
-- 'manager' or 'receptionist' is created here.
--
-- Access matrix (spec Phase 2):
--   Action            Owner Manager Operator Doctor
--   View appointments  ✅     ✅      ✅      own
--   Manual booking     ✅     ✅      ✅      ❌
--   Conversations      ✅     ✅      ✅      ❌
--   Takeover           ✅     ✅      ✅      ❌
--   Revenue analytics  ✅     ✅      ❌      ❌
--   Manage doctors     ✅     ✅      ❌      ❌
--   Manage Telegram    ✅     ✅      ❌      ❌
--   Platform clinics   ❌     ❌      ❌      ❌

-- ---------- 3. RLS policy generalization ----------
-- Owner/admin/manager manage the catalog and clinic settings; receptionist
-- gets operational powers (appointments, patients, conversations) only.

-- specialties
drop policy if exists "specialties write for admin owner" on public.specialties;
create policy "specialties write for management"
  on public.specialties for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- services
drop policy if exists "services write for admin owner" on public.services;
create policy "services write for management"
  on public.services for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- doctors
drop policy if exists "doctors write for admin owner" on public.doctors;
create policy "doctors write for management"
  on public.doctors for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- doctor_services
drop policy if exists "doctor_services write for admin owner" on public.doctor_services;
create policy "doctor_services write for management"
  on public.doctor_services for all
  to authenticated
  using (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff((
    select d.clinic_id from public.doctors d where d.id = doctor_services.doctor_id
  ), array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- working hours
drop policy if exists "working_hours write for admin owner" on public.doctor_working_hours;
create policy "working_hours write for management"
  on public.doctor_working_hours for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- time blocks (doctor self-service already handled by the API + status-only trigger)
drop policy if exists "time_blocks write for admin owner" on public.doctor_time_blocks;
create policy "time_blocks write for management"
  on public.doctor_time_blocks for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- faqs
drop policy if exists "faqs write for admin owner" on public.faq_entries;
create policy "faqs write for management"
  on public.faq_entries for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- app_settings
drop policy if exists "settings write for admin owner" on public.app_settings;
create policy "settings write for management"
  on public.app_settings for all
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- ---------- 4. Operational roles (receptionist) ----------

-- appointments: receptionists read, create (manual booking) and update
-- (status actions) appointments; doctors keep own-appointment read + status-only update.
drop policy if exists "appointments read for admin owner" on public.appointments;
create policy "appointments read for staff"
  on public.appointments for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = appointments.clinic_id
        and d.id = appointments.doctor_id
    )
  );

drop policy if exists "appointments write for admin owner" on public.appointments;
create policy "appointments insert for operational staff"
  on public.appointments for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "appointments update for admin owner" on public.appointments;
create policy "appointments update for operational staff"
  on public.appointments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

-- patients: receptionists manage walk-in patients (read/insert/update).
drop policy if exists "patients read for admin owner" on public.patients;
create policy "patients read for operational staff"
  on public.patients for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      join public.appointments a on a.doctor_id = d.id and a.patient_id = patients.id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = patients.clinic_id
    )
  );

drop policy if exists "patients update for admin owner" on public.patients;
create policy "patients update for operational staff"
  on public.patients for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "patients insert for admin owner" on public.patients;
create policy "patients insert for operational staff"
  on public.patients for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and telegram_user_id is null
  );

-- conversations: operational staff read and update (takeover); messages reply.
drop policy if exists "conversations read for staff" on public.conversations;
create policy "conversations read for operational staff"
  on public.conversations for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "conversations update for admin owner" on public.conversations;
create policy "conversations update for operational staff"
  on public.conversations for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "conversations insert for admin owner" on public.conversations;
create policy "conversations insert for operational staff"
  on public.conversations for insert
  to authenticated
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "messages read for staff" on public.messages;
create policy "messages read for operational staff"
  on public.messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "messages insert for admin owner" on public.messages;
create policy "messages insert for operational staff"
  on public.messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and role = 'admin'::public.message_role
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.clinic_id = clinic_id
    )
  );

-- voice messages: read + reply inserts for operational staff.
drop policy if exists "voice_messages read for staff" on public.voice_messages;
create policy "voice_messages read for operational staff"
  on public.voice_messages for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role]));

drop policy if exists "voice_messages insert for admin owner" on public.voice_messages;
create policy "voice_messages insert for operational staff"
  on public.voice_messages for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.clinic_id = clinic_id
    )
  );

drop policy if exists "voice_messages update for admin owner" on public.voice_messages;
create policy "voice_messages update for management"
  on public.voice_messages for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- payments: operational staff see payment STATUS (desk check-in); only
-- management can update payments. Aggregated revenue analytics are
-- additionally restricted at the API layer (owner/manager only).
drop policy if exists "payments read for staff" on public.payments;
create policy "payments read for operational staff"
  on public.payments for select
  to authenticated
  using (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role, 'receptionist'::public.staff_role])
    or exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      join public.appointments a on a.id = payments.appointment_id and a.doctor_id = d.id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'::public.staff_role
        and sr.clinic_id = payments.clinic_id
    )
  );

drop policy if exists "payments update for admin owner" on public.payments;
create policy "payments update for management"
  on public.payments for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "payments insert for admin owner" on public.payments;
create policy "payments insert for management"
  on public.payments for insert
  to authenticated
  with check (
    public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role])
    and exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.clinic_id = clinic_id
    )
  );

-- ---------- 5. Analytics / audit / notifications: management only ----------

drop policy if exists "analytics read for admin owner" on public.analytics_events;
create policy "analytics read for management"
  on public.analytics_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "audit read for admin owner" on public.audit_events;
create policy "audit read for management"
  on public.audit_events for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "notification_jobs read for admin owner" on public.notification_jobs;
create policy "notification_jobs read for management"
  on public.notification_jobs for select
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

drop policy if exists "notification_jobs update for admin owner" on public.notification_jobs;
create policy "notification_jobs update for management"
  on public.notification_jobs for update
  to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]))
  with check (public.is_clinic_staff(clinic_id, array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role]));

-- ---------- 6. Owner-only stays owner-only ----------
-- clinics update, staff_roles management, storage uploads, storage reads.

drop policy if exists "voice-messages staff upload" on storage.objects;
create policy "voice-messages staff upload"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'voice-messages'
    and exists (
      select 1 from public.staff_roles sr
      where sr.profile_id = auth.uid()
        and sr.clinic_id::text = (storage.foldername(name))[1]
        and sr.role = any (array['owner'::public.staff_role, 'admin'::public.staff_role, 'manager'::public.staff_role])
    )
  );
