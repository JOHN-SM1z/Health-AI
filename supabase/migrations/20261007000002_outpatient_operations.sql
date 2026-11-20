-- Outpatient pilot: walk-in arrivals, itemized charges, the kassa ledger,
-- refund grants, the digital queue and doctor access through a visit.
--
-- Requirements: docs/PILOT_PLAN.md; owner decisions 2026-10-07
-- (docs/decisions/2026-10-07-retention-tenancy-refunds.md and the pilot answers):
--   * reception registers an arrival; the patient pays at the kassa; the queue
--     number is issued on FULL payment (cash and card terminal may be split;
--     no partial payment / debt until the clinic sets a rule). A free visit is
--     queued at once. `clinics.queue_after_payment = false` queues at
--     registration instead.
--   * registration and cash collection are separate roles (receptionist /
--     cashier); refunds: owner or manager, or a cashier holding an active
--     grant from one of them; admin may not refund; partial refunds with a
--     reason; who authorized and who executed are both recorded.
--   * a queue ticket is not an appointment and promises no time. Unfinished
--     visits stay in the queue across midnight; the number keeps its day.
--   * money is append-only: charges are voided (never edited), collections and
--     refunds are ledger rows that cannot change. Two printed receipts are
--     never two payments: a collection is one row per method per request.
--   * no paper talon: the patient's own Telegram chat gets the ticket
--     (notification 'queue_ticket'); a waiting-room screen shows numbers.
--   * a walk-in consultation reuses the booking engine
--     (start_walk_in_consultation) so clinical records keep their authorship
--     rules; its auto-created appointment bill is removed in the same
--     transaction because the visit's charges are the bill.
--   * a referral gives the receiving doctor the referring doctor's history
--     at once (pending included) — no accept/start step is needed to read.
--
-- Every write goes through a SECURITY DEFINER function callable only by the
-- service role, which re-checks the actor's role in the clinic. Signed-in
-- roles get no table access (RLS on, no policies).

-- ---------------------------------------------------------------------------
-- Clinic operating settings
-- ---------------------------------------------------------------------------

alter table public.clinics
  add column operating_mode text not null default 'walk_in'
    check (operating_mode in ('walk_in', 'scheduled', 'mixed')),
  add column queue_after_payment boolean not null default true;

-- Existing clinics take bookings today: keep them working alongside walk-ins.
update public.clinics set operating_mode = 'mixed';

comment on column public.clinics.operating_mode is
  'walk_in (default for new clinics) | scheduled | mixed. Reception screens and the bot follow it.';
comment on column public.clinics.queue_after_payment is
  'true (owner decision 2026-10-07): a walk-in gets a queue number when the bill is fully paid; false: at registration.';

-- ---------------------------------------------------------------------------
-- Patient number (per clinic, human-readable, never reused)
-- ---------------------------------------------------------------------------

create table public.clinic_counters (
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null,
  value bigint not null,
  primary key (clinic_id, name)
);
alter table public.clinic_counters enable row level security;
revoke all on public.clinic_counters from anon, authenticated;

alter table public.patients add column patient_number bigint;

with numbered as (
  select id, row_number() over (partition by clinic_id order by created_at, id) as n
  from public.patients
)
update public.patients p set patient_number = numbered.n from numbered where numbered.id = p.id;

insert into public.clinic_counters (clinic_id, name, value)
select clinic_id, 'patient_number', max(patient_number) from public.patients group by clinic_id;

create or replace function public.patients_assign_number()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.clinic_counters as c (clinic_id, name, value)
    values (new.clinic_id, 'patient_number', 1)
    on conflict (clinic_id, name) do update set value = c.value + 1
    returning c.value into new.patient_number;
  elsif new.patient_number is distinct from old.patient_number then
    raise exception 'patients: patient_number cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.patients_assign_number() from public, anon, authenticated;

create trigger patients_assign_number
  before insert or update of patient_number on public.patients
  for each row execute function public.patients_assign_number();

alter table public.patients alter column patient_number set not null;
create unique index patients_clinic_patient_number_key on public.patients (clinic_id, patient_number);

comment on column public.patients.patient_number is
  'Per-clinic patient number for reception and queue screens. Assigned on insert, never changed or reused.';

-- ---------------------------------------------------------------------------
-- Visits (arrivals)
-- ---------------------------------------------------------------------------

create table public.visits (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  patient_id uuid not null,
  doctor_id uuid not null,
  status text not null default 'awaiting_payment'
    check (status in ('awaiting_payment', 'waiting', 'called', 'in_progress', 'completed', 'cancelled')),
  queue_date date,
  queue_number integer check (queue_number > 0),
  arrived_at timestamptz not null default now(),
  queued_at timestamptz,
  called_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  appointment_id uuid,
  created_by uuid not null references public.profiles(id),
  idempotency_key uuid not null,
  request_fingerprint text not null,
  updated_at timestamptz not null default now(),
  constraint visits_patient_fkey foreign key (patient_id, clinic_id) references public.patients (id, clinic_id) on delete restrict,
  constraint visits_doctor_fkey foreign key (doctor_id, clinic_id) references public.doctors (id, clinic_id) on delete restrict,
  constraint visits_appointment_fkey foreign key (appointment_id, clinic_id) references public.appointments (id, clinic_id) on delete restrict,
  constraint visits_queue_pair_check check ((queue_date is null) = (queue_number is null) and (queue_number is null) = (queued_at is null)),
  constraint visits_queued_status_check check (status in ('awaiting_payment', 'cancelled') or queue_number is not null),
  constraint visits_cancel_check check ((status = 'cancelled') = (cancelled_at is not null) and (status <> 'cancelled' or char_length(btrim(cancel_reason)) between 3 and 500)),
  constraint visits_clinic_day_number_key unique (clinic_id, queue_date, queue_number),
  constraint visits_idempotency_key unique (clinic_id, idempotency_key),
  constraint visits_id_clinic_id_key unique (id, clinic_id),
  constraint visits_id_clinic_patient_key unique (id, clinic_id, patient_id)
);

alter table public.visits enable row level security;
revoke all on public.visits from anon, authenticated;

create index visits_open_queue_idx on public.visits (clinic_id, status, queue_date, queue_number)
  where status in ('awaiting_payment', 'waiting', 'called', 'in_progress');
create index visits_doctor_idx on public.visits (clinic_id, doctor_id, status);
create index visits_patient_idx on public.visits (clinic_id, patient_id, arrived_at desc);
create unique index visits_appointment_key on public.visits (appointment_id) where appointment_id is not null;

comment on table public.visits is
  'A walk-in arrival. Not an appointment and not a promise of a time: queue_number is arrival order for the clinic day, issued on full payment (or at registration, per clinic). Written only by the outpatient RPCs.';

-- ---------------------------------------------------------------------------
-- Charges (itemized, price snapshot, void instead of edit)
-- ---------------------------------------------------------------------------

create table public.visit_charges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  patient_id uuid not null,
  service_id uuid not null,
  service_name text not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null default 1 check (quantity between 1 and 99),
  amount numeric(12, 2) not null check (amount >= 0),
  currency text not null,
  status text not null default 'active' check (status in ('active', 'voided')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  idempotency_key uuid,
  voided_by uuid references public.profiles(id),
  voided_at timestamptz,
  void_reason text,
  constraint visit_charges_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict,
  constraint visit_charges_service_fkey foreign key (service_id, clinic_id) references public.services (id, clinic_id) on delete restrict,
  constraint visit_charges_amount_total_check check (amount = unit_price * quantity),
  constraint visit_charges_void_check check (
    (status = 'voided') = (voided_at is not null)
    and (status = 'voided') = (voided_by is not null)
    and (status <> 'voided' or char_length(btrim(void_reason)) between 3 and 500)
  )
);

alter table public.visit_charges enable row level security;
revoke all on public.visit_charges from anon, authenticated;
create index visit_charges_visit_idx on public.visit_charges (visit_id, created_at);
create unique index visit_charges_idempotency_key on public.visit_charges (clinic_id, idempotency_key) where idempotency_key is not null;

create or replace function public.visit_charges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit charges are never deleted; void them' using errcode = '42501';
  end if;
  -- The only change: active → voided, with who/when/why. Everything else is fixed.
  if old.status = 'active' and new.status = 'voided'
     and (new.id, new.clinic_id, new.visit_id, new.patient_id, new.service_id, new.service_name, new.unit_price,
          new.quantity, new.amount, new.currency, new.created_by, new.created_at, new.idempotency_key)
         is not distinct from
         (old.id, old.clinic_id, old.visit_id, old.patient_id, old.service_id, old.service_name, old.unit_price,
          old.quantity, old.amount, old.currency, old.created_by, old.created_at, old.idempotency_key) then
    return new;
  end if;
  raise exception 'visit charges cannot be changed; void and add a new line' using errcode = '42501';
end;
$$;

create trigger visit_charges_guard
  before update or delete on public.visit_charges
  for each row execute function public.visit_charges_guard();

-- ---------------------------------------------------------------------------
-- The kassa ledger (append-only)
-- ---------------------------------------------------------------------------

create table public.visit_transactions (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  patient_id uuid not null,
  kind text not null check (kind in ('collection', 'refund')),
  method text not null check (method in ('cash', 'terminal')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null,
  reason text,
  executed_by uuid not null references public.profiles(id),
  authorized_by uuid not null references public.profiles(id),
  refund_grant_id uuid,
  request_key uuid not null,
  request_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint visit_transactions_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict,
  constraint visit_transactions_reason_check check (kind <> 'refund' or char_length(btrim(reason)) between 3 and 500),
  constraint visit_transactions_collection_check check (kind <> 'collection' or (reason is null and refund_grant_id is null and authorized_by = executed_by)),
  constraint visit_transactions_request_key unique (clinic_id, request_key, method)
);

alter table public.visit_transactions enable row level security;
revoke all on public.visit_transactions from anon, authenticated;
create index visit_transactions_visit_idx on public.visit_transactions (visit_id, created_at);
create index visit_transactions_clinic_time_idx on public.visit_transactions (clinic_id, created_at);

create or replace function public.visit_transactions_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'the kassa ledger is append-only; record a refund instead' using errcode = '42501';
end;
$$;

create trigger visit_transactions_append_only
  before update or delete on public.visit_transactions
  for each row execute function public.visit_transactions_append_only();

comment on table public.visit_transactions is
  'Money actually received (collection) or paid back (refund) at the kassa, by method. Append-only. Collected money is not revenue or profit; charges are in visit_charges.';

-- ---------------------------------------------------------------------------
-- Refund grants (manager/owner → named cashier)
-- ---------------------------------------------------------------------------

create table public.refund_grants (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  profile_id uuid not null references public.profiles(id),
  granted_by uuid not null references public.profiles(id),
  granted_at timestamptz not null default now(),
  revoked_by uuid references public.profiles(id),
  revoked_at timestamptz,
  revoke_reason text,
  constraint refund_grants_revoke_check check (
    (revoked_at is null) = (revoked_by is null)
    and (revoked_at is null or char_length(btrim(revoke_reason)) between 3 and 500)
  ),
  constraint refund_grants_id_clinic_id_key unique (id, clinic_id)
);

alter table public.refund_grants enable row level security;
revoke all on public.refund_grants from anon, authenticated;
create unique index refund_grants_active_key on public.refund_grants (clinic_id, profile_id) where revoked_at is null;

alter table public.visit_transactions
  add constraint visit_transactions_grant_fkey foreign key (refund_grant_id, clinic_id) references public.refund_grants (id, clinic_id);

create or replace function public.refund_grants_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refund grants are revoked, never deleted' using errcode = '42501';
  end if;
  if old.revoked_at is null and new.revoked_at is not null
     and (new.id, new.clinic_id, new.profile_id, new.granted_by, new.granted_at)
         is not distinct from (old.id, old.clinic_id, old.profile_id, old.granted_by, old.granted_at) then
    return new;
  end if;
  raise exception 'a refund grant can only be revoked' using errcode = '42501';
end;
$$;

create trigger refund_grants_guard
  before update or delete on public.refund_grants
  for each row execute function public.refund_grants_guard();

-- ---------------------------------------------------------------------------
-- Queue-ticket notifications
-- ---------------------------------------------------------------------------

alter table public.notification_jobs add column visit_id uuid;
alter table public.notification_jobs
  add constraint notification_jobs_visit_fkey
    foreign key (visit_id, clinic_id) references public.visits (id, clinic_id) on delete cascade,
  add constraint notification_jobs_visit_check
    check ((type = 'queue_ticket') = (visit_id is not null));

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The actor must hold one of the roles in an active clinic.
create or replace function public.ops_require_role(p_clinic uuid, p_actor uuid, p_roles public.staff_role[])
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or not exists (
    select 1 from public.staff_roles sr
    join public.clinics c on c.id = sr.clinic_id and c.is_active
    where sr.clinic_id = p_clinic and sr.profile_id = p_actor and sr.role = any (p_roles)
  ) then
    raise exception using message = 'operations: not allowed', errcode = '42501', hint = 'forbidden';
  end if;
end;
$$;

create or replace function public.ops_has_role(p_clinic uuid, p_actor uuid, p_roles public.staff_role[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic and sr.profile_id = p_actor and sr.role = any (p_roles)
  );
$$;

-- What a visit owes and has been paid, overall and per method.
create or replace function public.visit_balance(p_visit uuid)
returns table (
  charged numeric,
  collected numeric,
  refunded numeric,
  outstanding numeric,
  cash_net numeric,
  terminal_net numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with c as (
    select coalesce(sum(amount) filter (where status = 'active'), 0) as charged
    from public.visit_charges where visit_id = p_visit
  ), t as (
    select
      coalesce(sum(amount) filter (where kind = 'collection'), 0) as collected,
      coalesce(sum(amount) filter (where kind = 'refund'), 0) as refunded,
      coalesce(sum(case when kind = 'collection' then amount else -amount end) filter (where method = 'cash'), 0) as cash_net,
      coalesce(sum(case when kind = 'collection' then amount else -amount end) filter (where method = 'terminal'), 0) as terminal_net
    from public.visit_transactions where visit_id = p_visit
  )
  select c.charged, t.collected, t.refunded, c.charged - t.collected + t.refunded, t.cash_net, t.terminal_net
  from c, t;
$$;

-- Give a visit the next number of the clinic's current day. Callers hold the
-- visit row lock; the advisory lock serializes numbering across the clinic.
create or replace function public.visit_enqueue(p_visit uuid)
returns public.visits
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_date date;
  v_number integer;
  v_tg bigint;
begin
  select * into v from public.visits where id = p_visit for update;
  if v.queue_number is not null then
    return v;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('visit-queue:' || v.clinic_id::text, 0));
  select (now() at time zone c.timezone)::date into v_date from public.clinics c where c.id = v.clinic_id;
  select coalesce(max(queue_number), 0) + 1 into v_number
    from public.visits where clinic_id = v.clinic_id and queue_date = v_date;
  update public.visits
     set status = case when status = 'awaiting_payment' then 'waiting' else status end,
         queue_date = v_date, queue_number = v_number, queued_at = now(), updated_at = now()
   where id = v.id
  returning * into v;

  -- The digital ticket, to the patient's own verified Telegram chat only.
  select p.telegram_user_id into v_tg from public.patients p where p.id = v.patient_id;
  if v_tg is not null then
    insert into public.notification_jobs (clinic_id, visit_id, type, patient_telegram_user_id, scheduled_for, idempotency_key)
    values (v.clinic_id, v.id, 'queue_ticket', v_tg, now(), 'queue_ticket:' || v.id::text)
    on conflict (idempotency_key) do nothing;
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Registration
-- ---------------------------------------------------------------------------

create or replace function public.register_arrival(
  p_clinic uuid,
  p_actor uuid,
  p_key uuid,
  p_patient uuid,
  p_new_patient jsonb,
  p_doctor uuid,
  p_service_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_patient uuid := p_patient;
  v_fingerprint text;
  v_clinic public.clinics;
  v_name text;
  v_phone text;
  v_dob date;
  v_doc text;
  v_pinfl text;
  v_match uuid;
  v_service uuid;
  v_total numeric := 0;
  v_count int;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;

  v_fingerprint := md5(jsonb_build_array(
    p_actor, p_patient, p_new_patient, p_doctor,
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(p_service_ids) x)
  )::text);

  -- Serialize registrations of one clinic (patient creation, duplicate checks, retries).
  perform pg_advisory_xact_lock(hashtextextended('visit-register:' || p_clinic::text, 0));

  select * into v from public.visits where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if v.request_fingerprint <> v_fingerprint then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  select * into v_clinic from public.clinics where id = p_clinic;

  if not exists (select 1 from public.doctors d where d.id = p_doctor and d.clinic_id = p_clinic and d.active) then
    raise exception using message = 'operations: doctor unavailable', errcode = '22023', hint = 'doctor_not_found';
  end if;

  select count(*) into v_count from (select distinct x from unnest(p_service_ids) x where x is not null) s;
  if v_count = 0 or v_count > 10 or v_count <> coalesce(array_length(p_service_ids, 1), 0) then
    raise exception using message = 'operations: choose 1 to 10 different services', errcode = '22023', hint = 'invalid_services';
  end if;
  foreach v_service in array p_service_ids loop
    if not exists (select 1 from public.services s where s.id = v_service and s.clinic_id = p_clinic and s.active) then
      raise exception using message = 'operations: service unavailable', errcode = '22023', hint = 'service_not_found';
    end if;
    if exists (select 1 from public.doctor_services where doctor_id = p_doctor)
       and not exists (select 1 from public.doctor_services where doctor_id = p_doctor and service_id = v_service) then
      raise exception using message = 'operations: service not offered by this doctor', errcode = '22023', hint = 'service_not_offered';
    end if;
  end loop;

  if (v_patient is null) = (p_new_patient is null) then
    raise exception using message = 'operations: choose an existing patient or describe a new one', errcode = '22023', hint = 'invalid_patient';
  end if;

  if v_patient is not null then
    if not exists (select 1 from public.patients where id = v_patient and clinic_id = p_clinic) then
      raise exception using message = 'operations: patient not found', errcode = '22023', hint = 'patient_not_found';
    end if;
    if exists (select 1 from public.patients where id = v_patient and merged_into_patient_id is not null) then
      raise exception using message = 'operations: this record was merged; use the main record', errcode = '22023', hint = 'patient_merged';
    end if;
  else
    v_name := btrim(p_new_patient ->> 'full_name');
    v_phone := nullif(btrim(p_new_patient ->> 'phone'), '');
    v_doc := public.normalize_identity_document(p_new_patient ->> 'document_number');
    v_pinfl := public.normalize_identity_document(p_new_patient ->> 'pinfl');
    begin
      v_dob := nullif(p_new_patient ->> 'date_of_birth', '')::date;
    exception when others then
      raise exception using message = 'operations: invalid date of birth', errcode = '22023', hint = 'invalid_patient';
    end;
    if v_name is null or char_length(v_name) not between 2 and 120 then
      raise exception using message = 'operations: patient name required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_dob is null then
      raise exception using message = 'operations: date of birth required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,24}$' then
      raise exception using message = 'operations: invalid phone', errcode = '22023', hint = 'invalid_patient';
    end if;
    -- Never create a second record for someone the clinic already knows.
    select id into v_match from public.patients
     where clinic_id = p_clinic and merged_into_patient_id is null
       and ((v_pinfl is not null and pinfl = v_pinfl)
         or (v_doc is not null and document_number = v_doc)
         or (date_of_birth = v_dob and lower(btrim(full_name)) = lower(v_name)))
     order by created_at limit 1;
    if v_match is not null then
      raise exception using message = 'operations: this patient is already registered', errcode = '22023',
        hint = 'patient_exists', detail = v_match::text;
    end if;
    insert into public.patients (clinic_id, full_name, phone, date_of_birth, sex, document_number, pinfl)
    values (p_clinic, v_name, v_phone, v_dob, nullif(p_new_patient ->> 'sex', '')::public.patient_sex, v_doc, v_pinfl)
    returning id into v_patient;
  end if;

  if exists (
    select 1 from public.visits
     where clinic_id = p_clinic and patient_id = v_patient and doctor_id = p_doctor
       and status in ('awaiting_payment', 'waiting', 'called', 'in_progress')
  ) then
    raise exception using message = 'operations: this patient is already registered with this doctor', errcode = '22023', hint = 'already_registered';
  end if;

  insert into public.visits (clinic_id, patient_id, doctor_id, created_by, idempotency_key, request_fingerprint)
  values (p_clinic, v_patient, p_doctor, p_actor, p_key, v_fingerprint)
  returning * into v;

  insert into public.visit_charges (clinic_id, visit_id, patient_id, service_id, service_name, unit_price, quantity, amount, currency, created_by)
  select p_clinic, v.id, v_patient, s.id, s.name, coalesce(ds.price_override, s.price), 1, coalesce(ds.price_override, s.price), v_clinic.currency, p_actor
    from unnest(p_service_ids) with ordinality as u(service_id, ord)
    join public.services s on s.id = u.service_id
    left join public.doctor_services ds on ds.doctor_id = p_doctor and ds.service_id = s.id
   order by u.ord;

  select sum(amount) into v_total from public.visit_charges where visit_id = v.id;

  if not v_clinic.queue_after_payment or v_total = 0 then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_registered', 'visits', v.id::text,
          jsonb_build_object('patient_id', v_patient, 'doctor_id', p_doctor, 'charge_total', v_total, 'new_patient', p_patient is null));

  return jsonb_build_object('visit_id', v.id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Kassa: collection (full payment, cash/terminal split)
-- ---------------------------------------------------------------------------

create or replace function public.record_visit_payment(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_key uuid,
  p_lines jsonb,
  p_expected_outstanding numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_fingerprint text;
  v_line jsonb;
  v_sum numeric := 0;
  v_methods text[] := '{}';
  v_method text;
  v_amount numeric;
  v_currency text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'cashier']::public.staff_role[]);
  if p_key is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception using message = 'operations: invalid payment request', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(p_actor, p_visit, p_lines, p_expected_outstanding)::text);

  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  -- A retry of the same request returns what it recorded.
  if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key) then
    if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key
                and (request_fingerprint <> v_fingerprint or visit_id <> p_visit)) then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  if v.status = 'cancelled' then
    raise exception using message = 'operations: the visit was cancelled', errcode = '22023', hint = 'visit_cancelled';
  end if;

  select * into b from public.visit_balance(v.id);
  if p_expected_outstanding is null or b.outstanding <> p_expected_outstanding then
    raise exception using message = 'operations: the bill changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if b.outstanding <= 0 then
    raise exception using message = 'operations: nothing to pay', errcode = '22023', hint = 'nothing_due';
  end if;

  if jsonb_array_length(p_lines) not between 1 and 2 then
    raise exception using message = 'operations: one or two payment methods', errcode = '22023', hint = 'invalid_request';
  end if;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_method := v_line ->> 'method';
    begin
      v_amount := (v_line ->> 'amount')::numeric;
    exception when others then
      v_amount := null;
    end;
    if v_method not in ('cash', 'terminal') or v_method = any (v_methods)
       or v_amount is null or v_amount <= 0 or v_amount <> round(v_amount, 2) then
      raise exception using message = 'operations: invalid payment line', errcode = '22023', hint = 'invalid_request';
    end if;
    v_methods := v_methods || v_method;
    v_sum := v_sum + v_amount;
  end loop;

  -- Full payment only (owner decision): the lines must settle the bill exactly.
  if v_sum <> b.outstanding then
    raise exception using message = 'operations: the payment must equal the amount due', errcode = '22023', hint = 'amount_mismatch';
  end if;

  select currency into v_currency from public.clinics where id = p_clinic;
  insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, executed_by, authorized_by, request_key, request_fingerprint)
  select p_clinic, v.id, v.patient_id, 'collection', l ->> 'method', (l ->> 'amount')::numeric, v_currency, p_actor, p_actor, p_key, v_fingerprint
    from jsonb_array_elements(p_lines) l;

  if v.queue_number is null then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_payment_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', v_sum, 'methods', to_jsonb(v_methods), 'queue_number', v.queue_number));

  return jsonb_build_object('visit_id', v.id, 'replayed', false, 'queue_number', v.queue_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- Kassa: refunds
-- ---------------------------------------------------------------------------

create or replace function public.refund_visit_payment(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_key uuid,
  p_method text,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_fingerprint text;
  v_grant public.refund_grants;
  v_authorized uuid;
  v_available numeric;
  v_currency text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'cashier']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(p_actor, p_visit, p_method, p_amount, p_reason)::text);

  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key) then
    if exists (select 1 from public.visit_transactions where clinic_id = p_clinic and request_key = p_key
                and (request_fingerprint <> v_fingerprint or visit_id <> p_visit)) then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  -- Owner and manager refund on their own authority; a cashier only under an
  -- active grant, which records who authorized it.
  if public.ops_has_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]) then
    v_authorized := p_actor;
  else
    select * into v_grant from public.refund_grants
     where clinic_id = p_clinic and profile_id = p_actor and revoked_at is null;
    if not found then
      raise exception using message = 'operations: refunds need a manager''s permission', errcode = '42501', hint = 'refund_not_permitted';
    end if;
    v_authorized := v_grant.granted_by;
  end if;

  if p_method not in ('cash', 'terminal') or p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception using message = 'operations: invalid refund', errcode = '22023', hint = 'invalid_request';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a refund needs a reason', errcode = '22023', hint = 'reason_required';
  end if;

  select * into b from public.visit_balance(v.id);
  v_available := case when p_method = 'cash' then b.cash_net else b.terminal_net end;
  if p_amount > v_available then
    raise exception using message = 'operations: refund larger than what was paid by this method', errcode = '22023', hint = 'refund_exceeds_paid';
  end if;

  select currency into v_currency from public.clinics where id = p_clinic;
  insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, reason,
                                         executed_by, authorized_by, refund_grant_id, request_key, request_fingerprint)
  values (p_clinic, v.id, v.patient_id, 'refund', p_method, p_amount, v_currency, btrim(p_reason),
          p_actor, v_authorized, v_grant.id, p_key, v_fingerprint);

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_refund_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', p_amount, 'method', p_method, 'authorized_by', v_authorized, 'refund_grant_id', v_grant.id));

  return jsonb_build_object('visit_id', v.id, 'replayed', false);
end;
$$;

create or replace function public.grant_refund_permission(p_clinic uuid, p_actor uuid, p_cashier uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.refund_grants;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]);
  if not public.ops_has_role(p_clinic, p_cashier, array['cashier']::public.staff_role[]) then
    raise exception using message = 'operations: only a cashier can be given refund permission', errcode = '22023', hint = 'not_a_cashier';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('refund-grant:' || p_clinic::text || p_cashier::text, 0));
  select * into g from public.refund_grants where clinic_id = p_clinic and profile_id = p_cashier and revoked_at is null;
  if found then
    return jsonb_build_object('grant_id', g.id, 'replayed', true);
  end if;
  insert into public.refund_grants (clinic_id, profile_id, granted_by) values (p_clinic, p_cashier, p_actor) returning * into g;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'refund_grant_given', 'refund_grants', g.id::text, jsonb_build_object('profile_id', p_cashier));
  return jsonb_build_object('grant_id', g.id, 'replayed', false);
end;
$$;

create or replace function public.revoke_refund_permission(p_clinic uuid, p_actor uuid, p_cashier uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  g public.refund_grants;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
  end if;
  update public.refund_grants set revoked_by = p_actor, revoked_at = now(), revoke_reason = btrim(p_reason)
   where clinic_id = p_clinic and profile_id = p_cashier and revoked_at is null
  returning * into g;
  if not found then
    raise exception using message = 'operations: no active permission', errcode = '22023', hint = 'grant_not_found';
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'refund_grant_revoked', 'refund_grants', g.id::text, jsonb_build_object('profile_id', p_cashier));
  return jsonb_build_object('grant_id', g.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Charges: add / void (corrections)
-- ---------------------------------------------------------------------------

create or replace function public.add_visit_charge(p_clinic uuid, p_actor uuid, p_visit uuid, p_service uuid, p_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  c public.visit_charges;
  v_price numeric;
  v_name text;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  select * into c from public.visit_charges where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if c.visit_id <> p_visit or c.service_id <> p_service then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('charge_id', c.id, 'replayed', true);
  end if;

  if v.status = 'cancelled' then
    raise exception using message = 'operations: the visit was cancelled', errcode = '22023', hint = 'visit_cancelled';
  end if;
  select s.name, coalesce(ds.price_override, s.price) into v_name, v_price
    from public.services s
    left join public.doctor_services ds on ds.doctor_id = v.doctor_id and ds.service_id = s.id
   where s.id = p_service and s.clinic_id = p_clinic and s.active;
  if not found then
    raise exception using message = 'operations: service unavailable', errcode = '22023', hint = 'service_not_found';
  end if;

  insert into public.visit_charges (clinic_id, visit_id, patient_id, service_id, service_name, unit_price, quantity, amount, currency, created_by, idempotency_key)
  select p_clinic, v.id, v.patient_id, p_service, v_name, v_price, 1, v_price, currency, p_actor, p_key from public.clinics where id = p_clinic
  returning * into c;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_charge_added', 'visit_charges', c.id::text,
          jsonb_build_object('visit_id', v.id, 'service_id', p_service, 'amount', v_price));
  return jsonb_build_object('charge_id', c.id, 'replayed', false);
end;
$$;

create or replace function public.void_visit_charge(p_clinic uuid, p_actor uuid, p_charge uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  c public.visit_charges;
  b record;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
  end if;
  select vi.* into v from public.visits vi
    join public.visit_charges ch on ch.visit_id = vi.id
   where ch.id = p_charge and ch.clinic_id = p_clinic
   for update of vi;
  if not found then
    raise exception using message = 'operations: charge not found', errcode = '22023', hint = 'charge_not_found';
  end if;
  select * into c from public.visit_charges where id = p_charge;
  if c.status = 'voided' then
    return jsonb_build_object('charge_id', c.id, 'replayed', true);
  end if;

  -- Voiding must never leave the patient having paid more than they owe:
  -- refund first, then void.
  select * into b from public.visit_balance(v.id);
  if b.charged - c.amount < b.collected - b.refunded then
    raise exception using message = 'operations: refund the payment before removing this service', errcode = '22023', hint = 'refund_first';
  end if;

  update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = btrim(p_reason)
   where id = c.id;

  -- The bill may now be settled (a wrong extra line removed after payment).
  select * into b from public.visit_balance(v.id);
  if v.queue_number is null and v.status = 'awaiting_payment' and b.outstanding = 0 and b.charged > 0 then
    perform public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_charge_voided', 'visit_charges', c.id::text, jsonb_build_object('visit_id', v.id, 'amount', c.amount));
  return jsonb_build_object('charge_id', c.id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Queue transitions
-- ---------------------------------------------------------------------------

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  if not v_desk and not v_own_doctor then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    update public.appointments set status = 'completed' where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

-- The visit's own doctor starts the consultation: a walk-in appointment
-- through the booking engine (working hours, overlaps, referral linking and
-- clinical-record rules all as before). Its auto-created bill is removed —
-- the visit's charges are the bill — so nothing is charged twice.
create or replace function public.start_visit_consultation(p_clinic uuid, p_actor uuid, p_visit uuid, p_expected text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_service uuid;
  v_result jsonb;
  v_appointment uuid;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found or not exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;
  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if v.status not in ('waiting', 'called') then
    raise exception using message = 'operations: this patient is not in the queue', errcode = '22023', hint = 'invalid_transition';
  end if;

  select service_id into v_service from public.visit_charges
   where visit_id = v.id and status = 'active' order by created_at, id limit 1;
  if v_service is null then
    raise exception using message = 'operations: the visit has no service', errcode = '22023', hint = 'invalid_services';
  end if;

  v_result := public.start_walk_in_consultation(
    p_clinic, v.patient_id, v.doctor_id, v_service, date_trunc('minute', now()) + interval '1 minute', p_actor
  );
  v_appointment := (v_result ->> 'appointment_id')::uuid;
  if v_appointment is null then
    raise exception using message = 'operations: the consultation could not start', errcode = '22023',
      hint = coalesce(v_result ->> 'error_code', 'booking_failed');
  end if;
  delete from public.payments where appointment_id = v_appointment and status = 'unpaid';

  update public.visits set status = 'in_progress', started_at = now(), appointment_id = v_appointment, updated_at = now()
   where id = v.id returning * into v;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_consultation_started', 'visits', v.id::text, jsonb_build_object('appointment_id', v_appointment));
  return jsonb_build_object('visit_id', v.id, 'appointment_id', v_appointment, 'referral_id', v_result ->> 'referral_id');
end;
$$;

-- ---------------------------------------------------------------------------
-- Doctor access: a visit is a relationship; a referral shares history at once
-- ---------------------------------------------------------------------------

create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.clinic_id,
    -- Own relationship: a live appointment, a walk-in visit, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = any (g.ids)
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.visits v
      where v.clinic_id = d.clinic_id
        and v.patient_id = any (g.ids)
        and v.doctor_id = d.id
        and v.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = any (g.ids)
        and cr.author_doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    -- The referring doctor's history is shared as soon as the referral exists
    -- (pending included): no accept/start step is needed to read it.
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  cross join lateral (select public.patient_record_group(p.id) as ids) g
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient (see 20260929000001; merged record group since 20261005000016; walk-in visits and immediate referral history since 20261007000002): own relationship (live appointment, walk-in visit or authored record); open, unexpired referrals to them; referring doctors whose visits open referrals share (pending included); referral-linked appointments. No row = no access. Server-only.';

-- ---------------------------------------------------------------------------
-- Grants: server only
-- ---------------------------------------------------------------------------

revoke all on function public.ops_require_role(uuid, uuid, public.staff_role[]) from public, anon, authenticated;
revoke all on function public.ops_has_role(uuid, uuid, public.staff_role[]) from public, anon, authenticated;
revoke all on function public.visit_balance(uuid) from public, anon, authenticated;
revoke all on function public.visit_enqueue(uuid) from public, anon, authenticated;
revoke all on function public.register_arrival(uuid, uuid, uuid, uuid, jsonb, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.record_visit_payment(uuid, uuid, uuid, uuid, jsonb, numeric) from public, anon, authenticated;
revoke all on function public.refund_visit_payment(uuid, uuid, uuid, uuid, text, numeric, text) from public, anon, authenticated;
revoke all on function public.grant_refund_permission(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.revoke_refund_permission(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.add_visit_charge(uuid, uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.void_visit_charge(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.transition_visit(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.start_visit_consultation(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.visit_charges_guard() from public, anon, authenticated;
revoke all on function public.visit_transactions_append_only() from public, anon, authenticated;
revoke all on function public.refund_grants_guard() from public, anon, authenticated;

grant execute on function public.visit_balance(uuid) to service_role;
grant execute on function public.register_arrival(uuid, uuid, uuid, uuid, jsonb, uuid, uuid[]) to service_role;
grant execute on function public.record_visit_payment(uuid, uuid, uuid, uuid, jsonb, numeric) to service_role;
grant execute on function public.refund_visit_payment(uuid, uuid, uuid, uuid, text, numeric, text) to service_role;
grant execute on function public.grant_refund_permission(uuid, uuid, uuid) to service_role;
grant execute on function public.revoke_refund_permission(uuid, uuid, uuid, text) to service_role;
grant execute on function public.add_visit_charge(uuid, uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.void_visit_charge(uuid, uuid, uuid, text) to service_role;
grant execute on function public.transition_visit(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.start_visit_consultation(uuid, uuid, uuid, text) to service_role;
