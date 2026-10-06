-- A referral immediately permits scoped history reads; no approval ceremony.
create or replace function public.doctor_patient_access(p_clinic uuid,p_patient uuid,p_actor uuid)
returns boolean language sql stable security definer set search_path=public as $$
 select (coalesce(auth.role(),'')='service_role' or p_actor=auth.uid()) and exists(
 select 1 from public.doctors d join public.staff_roles sr on sr.profile_id=d.profile_id and sr.clinic_id=d.clinic_id
 where d.profile_id=p_actor and d.clinic_id=p_clinic and d.active and sr.role='doctor'
 and exists(select 1 from public.patients p where p.id=p_patient and p.clinic_id=p_clinic)
 and (
 exists(select 1 from public.appointments a where a.clinic_id=p_clinic and a.patient_id=p_patient and a.doctor_id=d.id and a.status not in ('cancelled','no_show'))
 or exists(select 1 from public.visits v where v.clinic_id=p_clinic and v.patient_id=p_patient and v.doctor_id=d.id and v.status<>'cancelled')
 or exists(select 1 from public.referrals r where r.clinic_id=p_clinic and r.patient_id=p_patient and r.referred_to_doctor_id=d.id and r.status in ('pending','accepted','in_progress') and r.revoked_at is null and r.expires_at>now())
 ));
$$;
revoke all on function public.doctor_patient_access(uuid,uuid,uuid) from public,anon;
grant execute on function public.doctor_patient_access(uuid,uuid,uuid) to authenticated,service_role;

-- No direct browser writes or operational-role access to clinical handoff text.
drop policy if exists "referrals insert for clinic staff" on public.referrals;
drop policy if exists "referrals update for involved doctor or management" on public.referrals;
drop policy if exists "referrals read for management and reception" on public.referrals;
drop policy if exists "referrals read for involved doctors" on public.referrals;
create policy "referrals involved active doctors" on public.referrals for select to authenticated using(
 public.is_clinic_staff(clinic_id,array['doctor']::public.staff_role[]) and exists(select 1 from public.doctors d where d.profile_id=auth.uid() and d.active and d.clinic_id=referrals.clinic_id and d.id in(referring_doctor_id,referred_to_doctor_id))
);

create or replace function public.referrals_validate_status_transition()
returns trigger language plpgsql security definer set search_path=public as $$
begin
 if tg_op='INSERT' then
   if new.status<>'pending' then raise exception 'new referral must be open'; end if;
   if new.created_by is null or not exists(select 1 from public.doctors d where d.id=new.referring_doctor_id and d.clinic_id=new.clinic_id and d.profile_id=new.created_by and d.active) or not public.doctor_patient_access(new.clinic_id,new.patient_id,new.created_by) then raise exception 'referral author or patient access denied' using errcode='42501'; end if;
   if new.expires_at is null or new.expires_at<=now() or new.expires_at>now()+interval '90 days' then raise exception 'invalid referral expiry'; end if;
   return new;
 end if;
 if old.status in('completed','declined','revoked','expired') then raise exception 'closed referral is immutable'; end if;
 if (to_jsonb(new)-array['status','updated_at','updated_by','completed_at','revoked_at','revoked_by','revocation_reason','accepted_at']) is distinct from (to_jsonb(old)-array['status','updated_at','updated_by','completed_at','revoked_at','revoked_by','revocation_reason','accepted_at']) then raise exception 'referral content is immutable; create a new note'; end if;
 if new.status=old.status then raise exception 'no referral transition requested'; end if;
 if new.status not in('completed','revoked','expired','declined','accepted','in_progress') then raise exception 'invalid referral transition'; end if;
 if new.status='expired' then
   if old.expires_at>now() then raise exception 'referral not expired'; end if;
 else
   if old.expires_at is null or old.expires_at<=now() then raise exception 'referral expired'; end if;
   if new.updated_by is null or not exists(select 1 from public.doctors d join public.staff_roles sr on sr.profile_id=d.profile_id and sr.clinic_id=d.clinic_id where d.profile_id=new.updated_by and d.clinic_id=new.clinic_id and d.active and sr.role='doctor' and d.id in(new.referring_doctor_id,new.referred_to_doctor_id)) then raise exception 'referral actor denied' using errcode='42501'; end if;
   if new.status='revoked' and not exists(select 1 from public.doctors where id=new.referring_doctor_id and profile_id=new.updated_by and new.revoked_by=new.updated_by) then raise exception 'only sender can revoke'; end if;
   if new.status in('accepted','in_progress','declined') and not exists(select 1 from public.doctors where id=new.referred_to_doctor_id and profile_id=new.updated_by) then raise exception 'only recipient can respond'; end if;
 end if;
 if new.status='accepted' then new.accepted_at:=now(); end if;
 if new.status='completed' then new.completed_at:=now(); end if;
 if new.status='revoked' then
   if new.revoked_by is null then raise exception 'revocation actor required'; end if;
   new.revoked_at:=now();
 end if;
 return new;
end $$;

alter table public.clinical_notes add column visit_id uuid;
alter table public.clinical_notes add constraint clinical_notes_visit_id_fkey foreign key(visit_id,clinic_id,patient_id) references public.visits(id,clinic_id,patient_id) on delete restrict;
alter table public.clinical_notes drop constraint clinical_notes_patient_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_patient_id_fkey foreign key(patient_id,clinic_id) references public.patients(id,clinic_id) on delete restrict;
alter table public.clinical_notes drop constraint clinical_notes_doctor_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_doctor_id_fkey foreign key(doctor_id,clinic_id) references public.doctors(id,clinic_id) on delete restrict;
alter table public.clinical_notes drop constraint clinical_notes_appointment_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_appointment_id_fkey foreign key(appointment_id,clinic_id,patient_id) references public.appointments(id,clinic_id,patient_id) on delete restrict;
alter table public.clinical_notes drop constraint clinical_notes_referral_id_fkey;
alter table public.clinical_notes add constraint clinical_notes_referral_id_fkey foreign key(referral_id,clinic_id,patient_id) references public.referrals(id,clinic_id,patient_id) on delete restrict;
create policy "clinical notes authorized history" on public.clinical_notes for select to authenticated using(
 public.doctor_patient_access(clinic_id,patient_id,auth.uid()) and (not is_private or exists(select 1 from public.doctors d where d.id=clinical_notes.doctor_id and d.profile_id=auth.uid() and d.active))
);
create function public.clinical_notes_guard() returns trigger language plpgsql security definer set search_path=public as $$
declare v_actor uuid;
begin
 if tg_op<>'INSERT' then raise exception 'clinical notes are append-only; add a correction note'; end if;
 select profile_id into v_actor from public.doctors where id=new.doctor_id and clinic_id=new.clinic_id and active;
 if v_actor is null or not public.doctor_patient_access(new.clinic_id,new.patient_id,v_actor) then raise exception 'clinical author not authorized' using errcode='42501'; end if;
 if new.appointment_id is not null and not exists(select 1 from public.appointments where id=new.appointment_id and clinic_id=new.clinic_id and patient_id=new.patient_id and doctor_id=new.doctor_id and status not in('cancelled','no_show')) then raise exception 'appointment not owned'; end if;
 if new.visit_id is not null and not exists(select 1 from public.visits where id=new.visit_id and clinic_id=new.clinic_id and patient_id=new.patient_id and doctor_id=new.doctor_id and status<>'cancelled') then raise exception 'visit not owned'; end if;
 if new.referral_id is not null and not exists(select 1 from public.referrals where id=new.referral_id and clinic_id=new.clinic_id and patient_id=new.patient_id and new.doctor_id in(referring_doctor_id,referred_to_doctor_id) and status in('pending','accepted','in_progress') and revoked_at is null and expires_at>now()) then raise exception 'referral unavailable'; end if;
 return new;
end $$;
create trigger clinical_notes_guard before insert or update or delete on public.clinical_notes for each row execute function public.clinical_notes_guard();

-- Audit IDs and state, never a second copy of the clinical narrative.
create function public.audit_clinical_change() returns trigger language plpgsql security definer set search_path=public as $$
declare v_actor uuid;
begin
 if tg_table_name='referrals' then v_actor:=coalesce((to_jsonb(new)->>'updated_by')::uuid,(to_jsonb(new)->>'created_by')::uuid);
 else select profile_id into v_actor from public.doctors where id=(to_jsonb(new)->>'doctor_id')::uuid and clinic_id=new.clinic_id; end if;
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id,old_values,new_values)
 values(new.clinic_id,v_actor,'staff',tg_table_name||'_'||lower(tg_op),tg_table_name,new.id::text,
 case when tg_op='UPDATE' then jsonb_build_object('status',to_jsonb(old)->>'status') else null end,
 jsonb_build_object('status',to_jsonb(new)->>'status'));
 return null;
end $$;
drop trigger referrals_audit on public.referrals;
create trigger referrals_audit after insert or update on public.referrals for each row execute function public.audit_clinical_change();
create trigger clinical_notes_audit after insert on public.clinical_notes for each row execute function public.audit_clinical_change();

-- Patient directory grants must use the same decision as the history route.
drop policy if exists "patients read for doctors" on public.patients;
drop policy if exists "patients read for operational staff" on public.patients;
create policy "patients scoped operational or treating doctor" on public.patients for select to authenticated using(
 public.is_clinic_staff(clinic_id,array['owner','admin','manager','receptionist']::public.staff_role[])
 or public.doctor_patient_access(clinic_id,id,auth.uid())
);
