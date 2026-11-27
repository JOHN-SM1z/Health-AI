-- Validate all existing data before replacing single-column tenant references.
-- A failure requires investigating the inconsistent rows, never deleting them.
do $$
declare r record; v_delete text;
begin
 for r in
 select c.conname,c.confdeltype,child.relname child_table,parent.relname parent_table,ca.attname child_column
 from pg_constraint c join pg_class child on child.oid=c.conrelid join pg_class parent on parent.oid=c.confrelid
 join pg_namespace ns on ns.oid=child.relnamespace join pg_namespace pn on pn.oid=parent.relnamespace
 join pg_attribute ca on ca.attrelid=child.oid and ca.attnum=c.conkey[1]
 join pg_attribute pa on pa.attrelid=parent.oid and pa.attnum=c.confkey[1]
 where c.contype='f' and ns.nspname='public' and pn.nspname='public' and cardinality(c.conkey)=1 and pa.attname='id'
 and exists(select 1 from pg_attribute where attrelid=child.oid and attname='clinic_id' and not attisdropped)
 and exists(select 1 from pg_attribute where attrelid=parent.oid and attname='clinic_id' and not attisdropped)
 loop
   -- Preserve the original deletion semantics. SET NULL only clears the
   -- optional reference, never the required tenant column.
   v_delete:=case r.confdeltype when 'c' then 'cascade' when 'n' then format('set null (%I)',r.child_column) when 'r' then 'restrict' else 'no action' end;
   execute format('create unique index if not exists %I on public.%I(id,clinic_id)',r.parent_table||'_tenant_reference_key',r.parent_table);
   execute format('alter table public.%I drop constraint %I',r.child_table,r.conname);
   execute format('alter table public.%I add constraint %I foreign key(%I,clinic_id) references public.%I(id,clinic_id) on delete %s',r.child_table,r.conname,r.child_column,r.parent_table,v_delete);
 end loop;
end $$;
create function public.tenant_identity_immutable() returns trigger language plpgsql set search_path=public as $$
begin
 if tg_table_name='patients' and to_jsonb(new)->'patient_number' is distinct from to_jsonb(old)->'patient_number' then raise exception 'patient number is immutable'; end if;
 if new.clinic_id is distinct from old.clinic_id or to_jsonb(new)->'id' is distinct from to_jsonb(old)->'id' then raise exception 'tenant and record identity are immutable'; end if;
 return new;
end $$;
do $$ declare r record; begin
 for r in select table_name from information_schema.columns where table_schema='public' and column_name='clinic_id'
 loop execute format('create trigger tenant_identity_immutable before update on public.%I for each row execute function public.tenant_identity_immutable()',r.table_name); end loop;
end $$;

create or replace function public.appointments_doctor_status_only()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'')<>'authenticated' or public.is_clinic_staff(new.clinic_id,array['owner','admin','manager','receptionist']::public.staff_role[]) then return new; end if;
 if (to_jsonb(new)-array['status','updated_at']) is distinct from (to_jsonb(old)-array['status','updated_at']) then raise exception 'Doctors may only update the status of their own appointments'; end if;
 return new;
end $$;
drop policy "appointments read for staff" on public.appointments;
create policy "appointments read for staff" on public.appointments for select to authenticated using(
 public.is_clinic_staff(clinic_id,array['owner','admin','manager','receptionist']::public.staff_role[]) or exists(
 select 1 from public.doctors d join public.staff_roles sr on sr.profile_id=d.profile_id and sr.clinic_id=d.clinic_id where d.id=appointments.doctor_id and d.clinic_id=appointments.clinic_id and d.profile_id=auth.uid() and d.active and sr.role='doctor'));
drop policy "appointments status update for own doctor" on public.appointments;
create policy "appointments status update for own doctor" on public.appointments for update to authenticated using(
 exists(select 1 from public.doctors d join public.staff_roles sr on sr.profile_id=d.profile_id and sr.clinic_id=d.clinic_id where d.id=appointments.doctor_id and d.clinic_id=appointments.clinic_id and d.profile_id=auth.uid() and d.active and sr.role='doctor')) with check(
 exists(select 1 from public.doctors d join public.staff_roles sr on sr.profile_id=d.profile_id and sr.clinic_id=d.clinic_id where d.id=appointments.doctor_id and d.clinic_id=appointments.clinic_id and d.profile_id=auth.uid() and d.active and sr.role='doctor'));
drop policy "voice-messages staff read" on storage.objects;
create policy "voice-messages staff read" on storage.objects for select to authenticated using(bucket_id='voice-messages' and exists(select 1 from public.staff_roles sr where sr.profile_id=auth.uid() and sr.role in('owner','admin','manager','receptionist') and sr.clinic_id::text=(storage.foldername(name))[1]));
drop policy "voice-messages staff upload" on storage.objects;
create policy "voice-messages staff upload" on storage.objects for insert to authenticated with check(bucket_id='voice-messages' and exists(select 1 from public.staff_roles sr where sr.profile_id=auth.uid() and sr.role in('owner','admin','manager','receptionist') and sr.clinic_id::text=(storage.foldername(name))[1]));

-- Preserve the patient/author relationship if an appointment parent is edited.
alter table public.appointments add constraint appointments_care_reference unique(id,clinic_id,patient_id,doctor_id);
alter table public.visits add constraint visits_care_reference unique(id,clinic_id,patient_id,doctor_id);
alter table public.clinical_notes drop constraint clinical_notes_appointment_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_appointment_id_fkey foreign key(appointment_id,clinic_id,patient_id,doctor_id) references public.appointments(id,clinic_id,patient_id,doctor_id) on delete restrict;
alter table public.clinical_notes drop constraint clinical_notes_visit_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_visit_id_fkey foreign key(visit_id,clinic_id,patient_id,doctor_id) references public.visits(id,clinic_id,patient_id,doctor_id) on delete restrict;
alter table public.referrals drop constraint referrals_originating_appointment_id_fkey;
alter table public.referrals add constraint referrals_originating_appointment_id_fkey foreign key(originating_appointment_id,clinic_id,patient_id,referring_doctor_id) references public.appointments(id,clinic_id,patient_id,doctor_id) on delete restrict;
