-- Arrivals are not scheduled appointments. Preserve the old booking engine.
alter table public.patients add column patient_number bigint generated always as identity;
create unique index patients_patient_number_key on public.patients(patient_number);
alter table public.patients add constraint patients_id_clinic_key unique(id,clinic_id);
alter table public.doctors add constraint doctors_id_clinic_key unique(id,clinic_id);
alter table public.services add constraint services_id_clinic_key unique(id,clinic_id);
alter table public.appointments add constraint appointments_id_clinic_patient_key unique(id,clinic_id,patient_id);
alter table public.referrals add constraint referrals_id_clinic_patient_key unique(id,clinic_id,patient_id);

create table public.visits (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 patient_id uuid not null,
 doctor_id uuid not null,
 service_id uuid not null,
 queue_date date not null,
 queue_number integer not null check(queue_number>0),
 status text not null default 'waiting' check(status in ('waiting','called','in_progress','completed','cancelled')),
 arrived_at timestamptz not null default now(),
 started_at timestamptz,
 completed_at timestamptz,
 created_by uuid not null references public.profiles(id),
 idempotency_key uuid not null,
 request_fingerprint text not null,
 constraint visits_patient_id_fkey foreign key(patient_id,clinic_id) references public.patients(id,clinic_id) on delete restrict,
 constraint visits_doctor_id_fkey foreign key(doctor_id,clinic_id) references public.doctors(id,clinic_id) on delete restrict,
 constraint visits_service_id_fkey foreign key(service_id,clinic_id) references public.services(id,clinic_id) on delete restrict,
 unique(clinic_id,queue_date,queue_number),
 unique(clinic_id,created_by,idempotency_key),
 unique(id,clinic_id,patient_id)
);
alter table public.visits enable row level security;
create index visits_clinic_queue_idx on public.visits(clinic_id,queue_date,status,queue_number);
create index visits_doctor_queue_idx on public.visits(clinic_id,doctor_id,status,arrived_at);
create index visits_patient_idx on public.visits(clinic_id,patient_id,arrived_at desc);
create policy "visits staff read" on public.visits for select to authenticated using (
 public.is_clinic_staff(clinic_id,array['owner','admin','manager','receptionist']::public.staff_role[])
 or (public.is_clinic_staff(clinic_id,array['doctor']::public.staff_role[]) and exists(select 1 from public.doctors d where d.id=visits.doctor_id and d.clinic_id=visits.clinic_id and d.profile_id=auth.uid() and d.active))
);

alter table public.payments alter column appointment_id drop not null;
alter table public.payments add column visit_id uuid;
alter table public.payments add constraint payments_visit_id_fkey foreign key(visit_id,clinic_id,patient_id) references public.visits(id,clinic_id,patient_id) on delete restrict;
alter table public.payments add constraint payments_visit_key unique(visit_id);
alter table public.payments add constraint payments_one_source check(num_nonnulls(appointment_id,visit_id)=1);
alter table public.payments drop constraint payments_appointment_id_fkey;
alter table public.payments add constraint payments_appointment_id_fkey foreign key(appointment_id,clinic_id,patient_id) references public.appointments(id,clinic_id,patient_id) on delete restrict;

-- Block caller-managed financial writes, including INSERT, and job redirection.
drop policy if exists "payments insert for management" on public.payments;
drop policy if exists "payments update for management" on public.payments;
drop policy if exists "notification_jobs update for management" on public.notification_jobs;
revoke all on function public.claim_due_notification_jobs(integer) from public,anon,authenticated;
revoke all on function public.claim_webhook_update(text,text) from public,anon,authenticated;
revoke all on function public.finish_webhook_update(text,text) from public,anon,authenticated;
revoke all on function public.release_webhook_update(text,text) from public,anon,authenticated;

create function public.operations_require_actor(p_clinic uuid,p_actor uuid,p_roles public.staff_role[])
returns void language plpgsql security definer set search_path=public as $$
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'server role required' using errcode='42501'; end if;
 if not exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_actor and role=any(p_roles))
 or not exists(select 1 from public.clinics where id=p_clinic and is_active)
 then raise exception 'clinic access denied' using errcode='42501'; end if;
end $$;
revoke all on function public.operations_require_actor(uuid,uuid,public.staff_role[]) from public,anon,authenticated;
grant execute on function public.operations_require_actor(uuid,uuid,public.staff_role[]) to service_role;

create function public.register_walk_in(p_clinic uuid,p_actor uuid,p_key uuid,p_patient uuid,p_name text,p_phone text,p_doctor uuid,p_service uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_visit public.visits; v_patient uuid:=p_patient; v_price numeric; v_date date; v_number int; v_currency text; v_fingerprint text;
begin
 perform public.operations_require_actor(p_clinic,p_actor,array['owner','admin','manager','receptionist']::public.staff_role[]);
 v_fingerprint:=md5(jsonb_build_array(p_patient,p_name,p_phone,p_doctor,p_service)::text);
 -- Serialize clinic queue numbering and retries, including new patient creation.
 perform pg_advisory_xact_lock(hashtextextended('walk-in:'||p_clinic::text,0));
 select * into v_visit from public.visits where clinic_id=p_clinic and created_by=p_actor and idempotency_key=p_key;
 if found then
   if v_visit.request_fingerprint<>v_fingerprint then raise exception 'idempotency conflict'; end if;
   return to_jsonb(v_visit)-'request_fingerprint'-'idempotency_key';
 end if;
 if not exists(select 1 from public.doctors where id=p_doctor and clinic_id=p_clinic and active) then raise exception 'doctor unavailable'; end if;
 select coalesce(ds.price_override,s.price) into v_price from public.services s left join public.doctor_services ds on ds.service_id=s.id and ds.doctor_id=p_doctor where s.id=p_service and s.clinic_id=p_clinic and s.active;
 if not found then raise exception 'service unavailable'; end if;
 if exists(select 1 from public.doctor_services where doctor_id=p_doctor) and not exists(select 1 from public.doctor_services where doctor_id=p_doctor and service_id=p_service) then raise exception 'service not offered'; end if;
 if p_phone is not null and p_phone !~ '^\+?[0-9 ()-]{7,24}$' then raise exception 'invalid phone'; end if;
 if v_patient is null then
   if p_name is null or char_length(trim(p_name)) not between 2 and 120 then raise exception 'patient name required'; end if;
   insert into public.patients(clinic_id,full_name,phone) values(p_clinic,trim(p_name),nullif(trim(p_phone),'')) returning id into v_patient;
 elsif not exists(select 1 from public.patients where id=v_patient and clinic_id=p_clinic) then raise exception 'patient not found'; end if;
 select (now() at time zone timezone)::date,currency into v_date,v_currency from public.clinics where id=p_clinic;
 select coalesce(max(queue_number),0)+1 into v_number from public.visits where clinic_id=p_clinic and queue_date=v_date;
 insert into public.visits(clinic_id,patient_id,doctor_id,service_id,queue_date,queue_number,created_by,idempotency_key,request_fingerprint)
 values(p_clinic,v_patient,p_doctor,p_service,v_date,v_number,p_actor,p_key,v_fingerprint) returning * into v_visit;
 insert into public.payments(clinic_id,visit_id,patient_id,amount,currency) values(p_clinic,v_visit.id,v_patient,v_price,v_currency);
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id) values(p_clinic,p_actor,'staff','walk_in_registered','visits',v_visit.id::text);
 return to_jsonb(v_visit)-'request_fingerprint'-'idempotency_key';
end $$;
revoke all on function public.register_walk_in(uuid,uuid,uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.register_walk_in(uuid,uuid,uuid,uuid,text,text,uuid,uuid) to service_role;

create function public.transition_visit(p_clinic uuid,p_actor uuid,p_visit uuid,p_expected text,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.visits; v_doctor boolean;
begin
 perform public.operations_require_actor(p_clinic,p_actor,array['owner','admin','manager','receptionist','doctor']::public.staff_role[]);
 select * into v from public.visits where id=p_visit and clinic_id=p_clinic for update;
 if not found then raise exception 'visit not found'; end if;
 select exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_actor and role='doctor') into v_doctor;
 if v_doctor and not exists(select 1 from public.doctors where id=v.doctor_id and clinic_id=p_clinic and profile_id=p_actor and active) then raise exception 'not your visit' using errcode='42501'; end if;
 if v.status<>p_expected then raise exception 'visit changed; refresh' using errcode='40001'; end if;
 if not ((v.status='waiting' and p_status in ('called','in_progress','cancelled')) or (v.status='called' and p_status in ('waiting','in_progress','cancelled')) or (v.status='in_progress' and p_status='completed')) then raise exception 'invalid visit transition'; end if;
 if not v_doctor and p_status in ('in_progress','completed') and not exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_actor and role in ('owner','admin','manager')) then raise exception 'doctor action required' using errcode='42501'; end if;
 update public.visits set status=p_status,started_at=case when p_status='in_progress' then now() else started_at end,completed_at=case when p_status='completed' then now() else completed_at end where id=v.id returning * into v;
 if p_status='cancelled' then update public.payments set status='voided' where clinic_id=p_clinic and visit_id=v.id and status='unpaid'; end if;
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id,old_values,new_values) values(p_clinic,p_actor,'staff','visit_status_changed','visits',v.id::text,jsonb_build_object('status',p_expected),jsonb_build_object('status',p_status));
 return to_jsonb(v);
end $$;
revoke all on function public.transition_visit(uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.transition_visit(uuid,uuid,uuid,text,text) to service_role;
