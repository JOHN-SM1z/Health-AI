-- Laboratory (Phase 15): external laboratory integration architecture.
--
-- A test the clinic's lab has received can be SENT OUT to an external
-- laboratory through a provider adapter (src/lib/labs/providers). No real
-- provider is integrated yet (no verified API); the first adapter is a mock.
--
--   lab_providers         a clinic's configured external laboratory: which
--                         adapter speaks to it, non-secret settings, and the
--                         NAME of the environment variable holding its
--                         credential (LAB_PROVIDER_…). Secrets never enter
--                         the database.
--   lab_provider_codes    the provider's codes for the clinic's tests and
--                         parameters. Provider-specific codes live here, not
--                         in the core lab model.
--   lab_external_requests one send-out of one order item: status (normalized
--                         from the provider's), the provider's order id,
--                         retries with back-off, a processing lease, the
--                         result it produced, and whether it needs review.
--
-- Normalized flow:
--   queued → sent → in_progress → resulted       (failed / rejected / cancelled)
--
-- Results from a provider become a lab result version with source =
-- external, entered (and, when complete, submitted) on behalf of the staff
-- member who sent the test out, and VERIFIED BY A SECOND PERSON like every
-- result (O4). Nothing a provider sends is final on its own.
--
-- Duplicate prevention: one live send-out per order item; a provider order
-- id once per provider; a provider result id once per send-out; and while a
-- send-out is live, nobody enters a manual result for the item.

create type public.lab_external_status as enum ('queued', 'sent', 'in_progress', 'resulted', 'failed', 'rejected', 'cancelled');

create table public.lab_providers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  code text not null,
  name text not null,
  -- Which adapter (src/lib/labs/providers/registry.ts) speaks to this provider.
  adapter text not null,
  active boolean not null default true,
  -- Non-secret settings for the adapter (validated by the adapter).
  config jsonb not null default '{}'::jsonb,
  -- The environment variable holding the credential — never the credential.
  credential_ref text,
  -- Minimum necessary: the patient's name is shared only when the provider requires it.
  send_patient_name boolean not null default false,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_providers_id_clinic_id_key unique (id, clinic_id),
  constraint lab_providers_code_key unique (clinic_id, code),
  constraint lab_providers_code_check check (code ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  constraint lab_providers_name_check check (name ~ '\S' and char_length(name) <= 120),
  constraint lab_providers_adapter_check check (adapter ~ '^[a-z0-9_]{2,40}$'),
  constraint lab_providers_config_check check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 8192),
  constraint lab_providers_credential_check check (credential_ref is null or credential_ref ~ '^LAB_PROVIDER_[A-Z0-9_]{1,60}$')
);

create table public.lab_provider_codes (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  provider_id uuid not null,
  kind text not null,
  internal_id uuid not null,
  external_code text not null,
  created_at timestamptz not null default now(),

  constraint lab_provider_codes_provider_fkey
    foreign key (provider_id, clinic_id) references public.lab_providers (id, clinic_id) on delete cascade,
  constraint lab_provider_codes_kind_check check (kind in ('test', 'parameter')),
  constraint lab_provider_codes_code_check check (external_code ~ '\S' and char_length(external_code) <= 64),
  constraint lab_provider_codes_internal_key unique (provider_id, kind, internal_id),
  constraint lab_provider_codes_external_key unique (provider_id, kind, external_code)
);

-- A code names a test / parameter of the same clinic.
create or replace function public.lab_provider_codes_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.kind = 'test' and not exists (
    select 1 from public.lab_tests t where t.id = new.internal_id and t.clinic_id = new.clinic_id
  ) then
    raise exception 'lab provider code: unknown test';
  end if;
  if new.kind = 'parameter' and not exists (
    select 1 from public.lab_test_parameters p where p.id = new.internal_id and p.clinic_id = new.clinic_id
  ) then
    raise exception 'lab provider code: unknown parameter';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_provider_codes_validate() from public, anon, authenticated;

create trigger lab_provider_codes_validate
  before insert or update on public.lab_provider_codes
  for each row execute function public.lab_provider_codes_validate();

create table public.lab_external_requests (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  provider_id uuid not null,
  order_item_id uuid not null,
  patient_id uuid not null,
  status public.lab_external_status not null default 'queued',
  requested_by uuid not null references public.profiles(id),
  requested_at timestamptz not null default now(),
  -- The provider's identifier for the order (set once it accepted it).
  external_order_id text,
  -- The provider's identifier of the result recorded (duplicate deliveries are ignored).
  external_result_id text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  -- A worker holds the request until then (no two workers act on it at once).
  lease_until timestamptz,
  last_error_code text,
  sent_at timestamptz,
  resulted_at timestamptz,
  result_id uuid,
  -- Something the integration cannot settle on its own (codes only).
  review_reason text,
  cancelled_by uuid references public.profiles(id),
  cancelled_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint lab_external_requests_id_clinic_id_key unique (id, clinic_id),
  constraint lab_external_requests_provider_fkey
    foreign key (provider_id, clinic_id) references public.lab_providers (id, clinic_id),
  constraint lab_external_requests_item_fkey
    foreign key (order_item_id, clinic_id, patient_id) references public.lab_order_items (id, clinic_id, patient_id),
  constraint lab_external_requests_result_fkey
    foreign key (result_id, clinic_id) references public.lab_results (id, clinic_id),
  constraint lab_external_requests_codes_check
    check ((last_error_code is null or last_error_code ~ '^[a-z_]{2,40}$')
           and (review_reason is null or review_reason ~ '^[a-z_]{2,40}$')
           and (external_order_id is null or (external_order_id ~ '\S' and char_length(external_order_id) <= 120))
           and (external_result_id is null or (external_result_id ~ '\S' and char_length(external_result_id) <= 120))),
  constraint lab_external_requests_resulted_check
    check ((status = 'resulted') = (result_id is not null) and (status = 'resulted') = (resulted_at is not null)),
  constraint lab_external_requests_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null))
);

-- One live send-out per test; a provider order id once per provider.
create unique index lab_external_requests_live_item_key
  on public.lab_external_requests (order_item_id) where status not in ('failed', 'rejected', 'cancelled');
create unique index lab_external_requests_external_order_key
  on public.lab_external_requests (provider_id, external_order_id) where external_order_id is not null;
create index lab_external_requests_due_idx
  on public.lab_external_requests (next_attempt_at) where status in ('queued', 'sent', 'in_progress');

create or replace function public.lab_external_requests_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and (new.clinic_id <> old.clinic_id or new.order_item_id <> old.order_item_id
     or new.provider_id <> old.provider_id or new.patient_id <> old.patient_id or new.requested_by <> old.requested_by) then
    raise exception 'lab external request: what was sent and to whom cannot change';
  end if;
  if tg_op = 'UPDATE' and old.status in ('resulted', 'rejected', 'cancelled') and new.status <> old.status then
    raise exception 'lab external request: a % request is final', old.status;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_external_requests_touch() from public, anon, authenticated;

create trigger lab_external_requests_touch
  before insert or update on public.lab_external_requests
  for each row execute function public.lab_external_requests_touch();

create trigger lab_providers_touch
  before update on public.lab_providers
  for each row execute function public.set_updated_at();

-- While a test is out at an external laboratory, nobody enters a manual result for it.
create or replace function public.lab_results_refuse_while_sent_out()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source = 'manual' and new.supersedes_result_id is null and exists (
    select 1 from public.lab_external_requests r
    where r.order_item_id = new.order_item_id and r.status in ('queued', 'sent', 'in_progress')
  ) then
    raise exception 'lab_result_external_pending: the test is at an external laboratory';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_results_refuse_while_sent_out() from public, anon, authenticated;

create trigger lab_results_refuse_while_sent_out
  before insert on public.lab_results
  for each row execute function public.lab_results_refuse_while_sent_out();

-- Audit: ids, status and codes — never values or provider payloads.
create or replace function public.lab_external_requests_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
begin
  if tg_op = 'INSERT' then
    v_action := 'lab_external_requested';
  elsif new.status is distinct from old.status then
    v_action := 'lab_external_' || new.status::text;
  elsif new.review_reason is distinct from old.review_reason and new.review_reason is not null then
    v_action := 'lab_external_needs_review';
  else
    return null;
  end if;
  if public.lab_clinic_is_being_erased(new.clinic_id) then
    return null;
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    case when tg_op = 'INSERT' then new.requested_by else coalesce(new.cancelled_by, public.lab_current_actor()) end,
    case when tg_op = 'INSERT' or coalesce(new.cancelled_by, public.lab_current_actor()) is not null then 'staff'::public.actor_type else 'system'::public.actor_type end,
    v_action,
    'lab_external_requests',
    new.id::text,
    new.patient_id,
    jsonb_build_object('order_item_id', new.order_item_id, 'provider_id', new.provider_id, 'status', new.status,
                       'attempts', new.attempts, 'error_code', new.last_error_code, 'review_reason', new.review_reason,
                       'result_id', new.result_id)
  );
  return null;
end;
$$;

revoke all on function public.lab_external_requests_audit() from public, anon, authenticated;

create trigger lab_external_requests_audit
  after insert or update on public.lab_external_requests
  for each row execute function public.lab_external_requests_audit();

alter table public.lab_providers enable row level security;
alter table public.lab_provider_codes enable row level security;
alter table public.lab_external_requests enable row level security;
revoke all on table public.lab_providers from public, anon, authenticated, service_role;
revoke all on table public.lab_provider_codes from public, anon, authenticated, service_role;
revoke all on table public.lab_external_requests from public, anon, authenticated, service_role;
grant select, insert, update on table public.lab_providers to service_role;
grant select, insert, update, delete on table public.lab_provider_codes to service_role;
grant select, insert, update on table public.lab_external_requests to service_role;

-- ---------------------------------------------------------------------------
-- request_external_lab: send a received test out (idempotent per item)
-- ---------------------------------------------------------------------------

create or replace function public.request_external_lab(p_clinic_id uuid, p_order_item_id uuid, p_provider_id uuid, p_actor uuid)
returns table (lab_external_request_id uuid, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_provider public.lab_providers;
  v_existing public.lab_external_requests;
  v_source public.lab_order_source;
  v_id uuid;
begin
  perform set_config('app.lab_actor', p_actor::text, true);
  if not public.lab_is_clinic_member(p_clinic_id, p_actor) then
    raise exception 'lab_external_forbidden: not a staff member of the clinic';
  end if;

  select * into v_item from public.lab_order_items i where i.id = p_order_item_id and i.clinic_id = p_clinic_id for update;
  if not found then
    raise exception 'lab_external_unknown_item: the test is not in this clinic';
  end if;
  select * into v_provider from public.lab_providers p where p.id = p_provider_id and p.clinic_id = p_clinic_id;
  if not found or not v_provider.active then
    raise exception 'lab_external_unknown_provider: no such active provider in this clinic';
  end if;

  select * into v_existing from public.lab_external_requests r
  where r.order_item_id = v_item.id and r.status not in ('failed', 'rejected', 'cancelled');
  if found then
    if v_existing.provider_id <> p_provider_id then
      raise exception 'lab_external_already_sent: the test is already sent to another laboratory';
    end if;
    return query select v_existing.id, true;
    return;
  end if;

  select o.source into v_source from public.lab_orders o where o.id = v_item.order_id;
  if v_source = 'external_import' then
    raise exception 'lab_external_imported: imported results are not sent out';
  end if;
  if v_item.status <> 'processing' then
    raise exception 'lab_external_item_not_ready: a test is sent out once the lab has received its sample (it is %)', v_item.status;
  end if;
  if exists (select 1 from public.lab_results r where r.order_item_id = v_item.id) then
    raise exception 'lab_external_has_result: the test already has a result';
  end if;
  if not exists (
    select 1 from public.lab_provider_codes c
    where c.provider_id = p_provider_id and c.kind = 'test' and c.internal_id = v_item.test_id
  ) then
    raise exception 'lab_external_unmapped_test: the provider has no code for this test';
  end if;

  insert into public.lab_external_requests (clinic_id, provider_id, order_item_id, patient_id, requested_by)
  values (p_clinic_id, p_provider_id, v_item.id, v_item.patient_id, p_actor)
  returning id into v_id;
  return query select v_id, false;
end;
$$;

revoke all on function public.request_external_lab(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.request_external_lab(uuid, uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- claim_external_lab_requests: the worker's atomic claim (SKIP LOCKED + lease)
-- ---------------------------------------------------------------------------

create or replace function public.claim_external_lab_requests(p_limit integer default 20, p_lease_seconds integer default 120)
returns setof public.lab_external_requests
language sql
security invoker
set search_path = public, pg_temp
as $$
  with due as (
    select r.id
    from public.lab_external_requests r
    join public.lab_providers p on p.id = r.provider_id
    where r.status in ('queued', 'sent', 'in_progress')
      and r.next_attempt_at <= now()
      and (r.lease_until is null or r.lease_until < now())
      and p.active
    order by r.next_attempt_at
    limit greatest(1, least(coalesce(p_limit, 20), 100))
    for update of r skip locked
  )
  update public.lab_external_requests r
  set lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease_seconds, 120), 900)))
  from due
  where r.id = due.id
  returning r.*;
$$;

revoke all on function public.claim_external_lab_requests(integer, integer) from public, anon, authenticated;
grant execute on function public.claim_external_lab_requests(integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- record_external_lab_result: a provider's result → a result version (source
-- external), idempotent per provider result id. Values arrive already mapped
-- to the clinic's parameters by the server; the value trigger checks types,
-- choices and decimals and computes flags from the clinic's ranges.
-- ---------------------------------------------------------------------------

create or replace function public.record_external_lab_result(
  p_clinic_id uuid,
  p_request_id uuid,
  p_external_result_id text,
  p_values jsonb,
  p_performed_at timestamptz default null
)
returns table (lab_result_id uuid, submitted boolean, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_req public.lab_external_requests;
  v_result uuid;
  v_submitted boolean := false;
  v_entry jsonb;
begin
  select * into v_req from public.lab_external_requests r
  where r.id = p_request_id and r.clinic_id = p_clinic_id
  for update;
  if not found then
    raise exception 'lab_external_unknown_request: no such send-out in this clinic';
  end if;
  if v_req.status = 'resulted' then
    if v_req.external_result_id = p_external_result_id then
      return query select v_req.result_id, true, true; -- the same delivery again
      return;
    end if;
    raise exception 'lab_external_result_conflict: a different result for a send-out that already has one';
  end if;
  if v_req.status not in ('sent', 'in_progress') then
    raise exception 'lab_external_not_awaiting_result: the send-out is %', v_req.status;
  end if;
  if p_values is null or jsonb_typeof(p_values) <> 'array' or jsonb_array_length(p_values) = 0 or jsonb_array_length(p_values) > 200 then
    raise exception 'lab_external_bad_values: no values';
  end if;

  perform set_config('app.lab_actor', v_req.requested_by::text, true);

  insert into public.lab_results (clinic_id, order_item_id, patient_id, source, entered_by, performed_at)
  values (p_clinic_id, v_req.order_item_id, v_req.patient_id, 'external', v_req.requested_by, p_performed_at)
  returning id into v_result;

  for v_entry in select * from jsonb_array_elements(p_values) loop
    insert into public.lab_result_values (clinic_id, result_id, parameter_id, value_numeric, value_text, value_boolean)
    values (p_clinic_id, v_result, (v_entry->>'parameter_id')::uuid,
            (v_entry->>'value_numeric')::numeric, nullif(btrim(v_entry->>'value_text'), ''), (v_entry->>'value_boolean')::boolean);
  end loop;

  -- Complete → submitted for a second person's verification; incomplete → a
  -- draft the requester completes. Never verified here.
  begin
    perform public.submit_lab_result(p_clinic_id, v_result, v_req.requested_by);
    v_submitted := true;
  exception when others then
    if sqlerrm not like 'lab_result_incomplete%' then
      raise;
    end if;
  end;

  update public.lab_external_requests
  set status = 'resulted', result_id = v_result, resulted_at = now(), external_result_id = p_external_result_id,
      lease_until = null, last_error_code = null,
      review_reason = case when v_submitted then null else 'result_incomplete' end
  where id = v_req.id;

  return query select v_result, v_submitted, false;
end;
$$;

revoke all on function public.record_external_lab_result(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.record_external_lab_result(uuid, uuid, text, jsonb, timestamptz) to service_role;
