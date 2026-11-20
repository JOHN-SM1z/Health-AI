-- Manual laboratory foundation. Verification/release intentionally unavailable
-- until clinic verifier permissions and release policy have been approved.
create table public.lab_orders (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null references public.clinics(id) on delete restrict,
 patient_id uuid not null,
 created_by uuid not null references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 idempotency_key uuid not null,
 fingerprint text not null,
 unique(id,clinic_id), unique(clinic_id,created_by,idempotency_key),
 foreign key(patient_id,clinic_id) references public.patients(id,clinic_id) on delete restrict
);
create table public.lab_specimens (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null,
 order_id uuid not null,
 specimen_type text not null check(char_length(btrim(specimen_type)) between 1 and 100),
 accession text not null unique default ('L'||replace(gen_random_uuid()::text,'-','')),
 status text not null default 'ordered' check(status in ('ordered','collected','received','processing','rejected')),
 version integer not null default 1,
 collected_at timestamptz, received_at timestamptz,
 rejection_reason text,
 replaces_id uuid,
 created_at timestamptz not null default now(),
 unique(id,clinic_id,order_id), unique(replaces_id),
 foreign key(order_id,clinic_id) references public.lab_orders(id,clinic_id) on delete restrict,
 foreign key(replaces_id,clinic_id,order_id) references public.lab_specimens(id,clinic_id,order_id) on delete restrict
);
create table public.lab_order_tests (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null,
 order_id uuid not null,
 specimen_id uuid not null,
 test_name text not null check(char_length(btrim(test_name)) between 1 and 160),
 unique(id,clinic_id,order_id),
 foreign key(specimen_id,clinic_id,order_id) references public.lab_specimens(id,clinic_id,order_id) on delete restrict
);
create table public.lab_result_drafts (
 id uuid primary key default gen_random_uuid(),
 clinic_id uuid not null,
 order_id uuid not null,
 test_id uuid not null,
 specimen_id uuid not null,
 revision integer not null check(revision>0),
 value text not null check(char_length(btrim(value)) between 1 and 2000),
 unit text not null default '' check(char_length(unit)<=80),
 reference_text text not null default '' check(char_length(reference_text)<=500),
 correction_reason text check(char_length(correction_reason) between 3 and 500),
 author_id uuid not null references public.profiles(id) on delete restrict,
 created_at timestamptz not null default now(),
 unique(test_id,revision),
 foreign key(test_id,clinic_id,order_id) references public.lab_order_tests(id,clinic_id,order_id) on delete restrict,
 foreign key(specimen_id,clinic_id,order_id) references public.lab_specimens(id,clinic_id,order_id) on delete restrict
);
create index lab_orders_patient_idx on public.lab_orders(clinic_id,patient_id,created_at desc);
create index lab_orders_worklist_idx on public.lab_orders(clinic_id,created_at desc);
create index lab_specimens_order_idx on public.lab_specimens(clinic_id,order_id);
create index lab_order_tests_order_idx on public.lab_order_tests(clinic_id,order_id);
create index lab_result_drafts_order_idx on public.lab_result_drafts(clinic_id,order_id);
-- No direct Data API access. Reads and writes both go through checked RPCs.
alter table public.lab_orders enable row level security;
alter table public.lab_specimens enable row level security;
alter table public.lab_order_tests enable row level security;
alter table public.lab_result_drafts enable row level security;
revoke all on public.lab_orders,public.lab_specimens,public.lab_order_tests,public.lab_result_drafts from anon,authenticated;

create function public.lab_drafts_immutable() returns trigger language plpgsql set search_path=public as $$
begin raise exception 'laboratory draft revisions are append-only'; end $$;
create trigger lab_drafts_immutable before update or delete on public.lab_result_drafts for each row execute function public.lab_drafts_immutable();
revoke all on function public.lab_drafts_immutable() from public,anon,authenticated;

create function public.lab_workbench(p_clinic uuid,p_actor uuid,p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 v_order public.lab_orders; v_specimen public.lab_specimens; v_test public.lab_order_tests;
 v_id uuid; v_key uuid; v_patient uuid; v_existing integer; v_item jsonb; v_result jsonb;
 v_fingerprint text; v_reason text; v_page integer;
begin
 perform public.operations_require_actor(p_clinic,p_actor,array['doctor']::public.staff_role[]);
 if not exists(select 1 from public.doctors where clinic_id=p_clinic and profile_id=p_actor and active) then
  raise exception 'active doctor required' using errcode='42501';
 end if;
 if p_action='list' then
  v_page:=coalesce((p_payload->>'page')::int,0);
  if v_page<0 or v_page>10000 then raise exception 'invalid page'; end if;
  select coalesce(jsonb_agg(q),'[]'::jsonb) into v_result from (
   select o.id,o.patient_id,o.created_at,p.full_name,p.patient_number,
    (select count(*) from public.lab_order_tests t where t.order_id=o.id and t.clinic_id=p_clinic) as tests_count,
    (select count(distinct r.test_id) from public.lab_result_drafts r join public.lab_order_tests t on t.id=r.test_id and t.specimen_id=r.specimen_id where r.order_id=o.id and r.clinic_id=p_clinic) as draft_count
   from public.lab_orders o join public.patients p on p.id=o.patient_id and p.clinic_id=o.clinic_id
   where o.clinic_id=p_clinic and public.doctor_patient_access(p_clinic,o.patient_id,p_actor)
   order by o.created_at desc,o.id limit 51 offset v_page*50
  ) q;
  return jsonb_build_object('orders',v_result);
 end if;
 if p_action='create' then
  v_patient:=(p_payload->>'patientId')::uuid; v_key:=(p_payload->>'idempotencyKey')::uuid;
  if not public.doctor_patient_access(p_clinic,v_patient,p_actor) then raise exception 'patient access denied' using errcode='42501'; end if;
  if jsonb_typeof(p_payload->'tests') is distinct from 'array' or jsonb_array_length(p_payload->'tests') not between 1 and 50 then raise exception 'tests required'; end if;
  v_fingerprint:=md5((p_payload-'idempotencyKey')::text);
  perform pg_advisory_xact_lock(hashtextextended('lab:'||p_clinic::text||p_actor::text||v_key::text,0));
  select * into v_order from public.lab_orders where clinic_id=p_clinic and created_by=p_actor and idempotency_key=v_key;
  if found then
   if v_order.fingerprint<>v_fingerprint then raise exception 'idempotency conflict'; end if;
   return jsonb_build_object('id',v_order.id);
  end if;
  insert into public.lab_orders(clinic_id,patient_id,created_by,idempotency_key,fingerprint) values(p_clinic,v_patient,p_actor,v_key,v_fingerprint) returning * into v_order;
  -- One explicit sample type per order in this first workbench. Separate orders
  -- are used for distinct specimen types; never infer specimen requirements.
  insert into public.lab_specimens(clinic_id,order_id,specimen_type) values(p_clinic,v_order.id,btrim(p_payload->>'specimenType')) returning * into v_specimen;
  for v_item in select * from jsonb_array_elements(p_payload->'tests') loop
   if jsonb_typeof(v_item) is distinct from 'string' then raise exception 'test name required'; end if;
   insert into public.lab_order_tests(clinic_id,order_id,specimen_id,test_name) values(p_clinic,v_order.id,v_specimen.id,btrim(v_item#>>'{}'));
  end loop;
 else
  select * into v_order from public.lab_orders where id=(p_payload->>'orderId')::uuid and clinic_id=p_clinic for update;
  if not found or not public.doctor_patient_access(p_clinic,v_order.patient_id,p_actor) then raise exception 'patient access denied' using errcode='42501'; end if;
  if p_action='read' then
   select jsonb_build_object('order',to_jsonb(v_order)-'fingerprint'-'idempotency_key',
    'patient',(select jsonb_build_object('full_name',full_name,'patient_number',patient_number) from public.patients where id=v_order.patient_id and clinic_id=p_clinic),
    'specimens',(select coalesce(jsonb_agg(s order by s.created_at),'[]') from public.lab_specimens s where s.order_id=v_order.id and s.clinic_id=p_clinic),
    'tests',(select coalesce(jsonb_agg(t order by t.test_name),'[]') from public.lab_order_tests t where t.order_id=v_order.id and t.clinic_id=p_clinic),
    'drafts',(select coalesce(jsonb_agg(r order by r.created_at desc),'[]') from public.lab_result_drafts r where r.order_id=v_order.id and r.clinic_id=p_clinic)) into v_result;
  elsif p_action in ('transition','recollect') then
   select * into v_specimen from public.lab_specimens where id=(p_payload->>'specimenId')::uuid and order_id=v_order.id and clinic_id=p_clinic for update;
   if not found or v_specimen.version is distinct from (p_payload->>'expectedVersion')::int then raise exception 'specimen changed' using errcode='40001'; end if;
   if p_action='recollect' then
    if v_specimen.status<>'rejected' then raise exception 'rejected specimen required'; end if;
    insert into public.lab_specimens(clinic_id,order_id,specimen_type,replaces_id) values(p_clinic,v_order.id,v_specimen.specimen_type,v_specimen.id) returning id into v_id;
    update public.lab_order_tests set specimen_id=v_id where order_id=v_order.id and clinic_id=p_clinic and specimen_id=v_specimen.id;
   else
    if not ((v_specimen.status='ordered' and p_payload->>'status'='collected') or (v_specimen.status='collected' and p_payload->>'status'='received') or (v_specimen.status='received' and p_payload->>'status'='processing') or (v_specimen.status in ('ordered','collected','received','processing') and p_payload->>'status'='rejected')) then raise exception 'invalid specimen transition'; end if;
    v_reason:=nullif(btrim(p_payload->>'reason'),'');
    if p_payload->>'status'='rejected' and (v_reason is null or char_length(v_reason) not between 3 and 500) then raise exception 'rejection reason required'; end if;
    update public.lab_specimens set status=p_payload->>'status',version=version+1,
     collected_at=case when p_payload->>'status'='collected' then now() else collected_at end,
     received_at=case when p_payload->>'status'='received' then now() else received_at end,
     rejection_reason=case when p_payload->>'status'='rejected' then v_reason else rejection_reason end
    where id=v_specimen.id and clinic_id=p_clinic;
   end if;
  elsif p_action='draft' then
   select * into v_test from public.lab_order_tests where id=(p_payload->>'testId')::uuid and order_id=v_order.id and clinic_id=p_clinic;
   if not found then raise exception 'test not found'; end if;
   select * into v_specimen from public.lab_specimens where id=v_test.specimen_id and clinic_id=p_clinic;
   if v_specimen.status<>'processing' then raise exception 'specimen not processing'; end if;
   select coalesce(max(revision),0) into v_existing from public.lab_result_drafts where test_id=v_test.id and clinic_id=p_clinic;
   if v_existing is distinct from (p_payload->>'expectedRevision')::int then raise exception 'draft changed' using errcode='40001'; end if;
   v_reason:=nullif(btrim(p_payload->>'reason'),'');
   if v_existing>0 and (v_reason is null or char_length(v_reason) not between 3 and 500) then raise exception 'correction reason required'; end if;
   insert into public.lab_result_drafts(clinic_id,order_id,test_id,specimen_id,revision,value,unit,reference_text,correction_reason,author_id)
    values(p_clinic,v_order.id,v_test.id,v_specimen.id,v_existing+1,btrim(p_payload->>'value'),coalesce(p_payload->>'unit',''),coalesce(p_payload->>'referenceText',''),v_reason,p_actor);
  else raise exception 'unsupported action; verification and release are not configured'; end if;
 end if;
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id)
 values(p_clinic,p_actor,'staff','lab_'||p_action,'lab_orders',v_order.id::text);
 return coalesce(v_result,jsonb_build_object('id',v_order.id));
end $$;
revoke all on function public.lab_workbench(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.lab_workbench(uuid,uuid,text,jsonb) to service_role;
