-- Laboratory (Phase 2, 3 of 4): lab orders, order items and samples.
--
-- docs/labs/PHASE_1_DOMAIN_MODEL.md §3.2–3.3 and §4, owner decisions
-- 2026-10-05.
--
--   lab_orders        one request for one patient. Any staff member of the
--                     clinic may order (no per-role or per-test restriction);
--                     the database records who did. Three sources: a doctor's
--                     consultation, a walk-in (reception / lab), an external
--                     import.
--   lab_order_items   one test in an order — the unit of lab work. It freezes
--                     the test's code, name and standalone price when ordered,
--                     plus the price actually charged (a panel's price is
--                     allocated across its tests by the ordering function,
--                     Phase 5 — O2). Catalog edits never rewrite history.
--   lab_samples       a physical specimen of the order's patient.
--   lab_sample_items  which items a specimen serves (one tube, several tests);
--                     an item has at most one sample that is not rejected.
--
-- Lifecycles are separate columns, each guarded by a trigger:
--   order   active → completed | cancelled
--   item    ordered → ready_for_collection → collected → processing → resulted → verified
--           (ordered | ready_for_collection) → cancelled
--           collected | processing → ready_for_collection   (sample rejected)
--           resulted → processing                            (result returned)
--   sample  collected → received → rejected, collected → rejected
-- Payment is NOT part of any of these (O6): it stays on payments.
--
-- Deletion: nothing here cascades from a patient. Deleting a patient who has
-- lab history fails (NO ACTION) instead of erasing that history; retention is
-- an open legal question and this migration does not decide it. Deleting a
-- clinic still removes everything (its rows cascade from clinics).
--
-- Access: no signed-in role may read or write these tables directly in this
-- phase — the server authorizes every read and write (Phase 3 decides any
-- direct read). RLS policies are still defined as the backstop, matching the
-- AGENTS.md access model: operational staff see their clinic's work status,
-- a doctor only patients doctor_can_read_patient() admits.

create type public.lab_order_source as enum ('consultation', 'walk_in', 'external_import');
create type public.lab_order_status as enum ('active', 'completed', 'cancelled');
create type public.lab_item_status as enum (
  'ordered',
  'ready_for_collection',
  'collected',
  'processing',
  'resulted',
  'verified',
  'cancelled'
);
create type public.lab_sample_status as enum ('collected', 'received', 'rejected');

-- appointments (id, clinic_id, patient_id, doctor_id) is already unique
-- (appointments_id_clinic_id_patient_id_doctor_id_key).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.lab_orders (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  source public.lab_order_source not null,
  -- The staff member who placed the order (any role of the clinic).
  ordered_by uuid not null references public.profiles(id),
  -- Set when the orderer is a linked doctor; required for a consultation.
  ordering_doctor_id uuid,
  -- The consultation the order came from (source = consultation only).
  appointment_id uuid,
  status public.lab_order_status not null default 'active',
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id),
  cancel_reason text,
  -- Provider / import identifier (source = external_import).
  external_reference text,
  -- Client idempotency key: a repeated submission resolves to this order.
  creation_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_orders_id_clinic_id_key unique (id, clinic_id),
  constraint lab_orders_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id),
  constraint lab_orders_patient_fkey
    foreign key (patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint lab_orders_ordering_doctor_fkey
    foreign key (ordering_doctor_id, clinic_id) references public.doctors (id, clinic_id),
  -- The ordering doctor's own consultation with this patient in this clinic.
  constraint lab_orders_consultation_fkey
    foreign key (appointment_id, clinic_id, patient_id, ordering_doctor_id)
    references public.appointments (id, clinic_id, patient_id, doctor_id),
  constraint lab_orders_consultation_source_check
    check ((source = 'consultation') = (appointment_id is not null)),
  -- MATCH SIMPLE skips the FK when ordering_doctor_id is NULL: forbid that.
  constraint lab_orders_consultation_doctor_check
    check (appointment_id is null or ordering_doctor_id is not null),
  constraint lab_orders_external_reference_check
    check ((source = 'external_import') = (external_reference is not null)
           and (external_reference is null or (external_reference ~ '\S' and char_length(external_reference) <= 120))),
  constraint lab_orders_cancel_check
    check ((status = 'cancelled') = (cancelled_at is not null)
           and (status = 'cancelled') = (cancelled_by is not null)
           and (cancel_reason is null or (cancel_reason ~ '\S' and char_length(cancel_reason) <= 300)))
);

create table public.lab_order_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  order_id uuid not null,
  patient_id uuid not null,
  test_id uuid not null,
  -- The panel this item was ordered through, if any.
  panel_id uuid,
  test_code_snapshot text not null,
  test_name_snapshot text not null,
  -- The test's standalone catalog price when ordered.
  list_price_snapshot numeric(12, 2) not null,
  -- The price actually charged for this item (= list price for a single test,
  -- the allocated share of the panel price for a panel item — O2).
  price_snapshot numeric(12, 2) not null,
  status public.lab_item_status not null default 'ordered',
  status_changed_at timestamptz not null default now(),
  status_changed_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_order_items_id_clinic_id_key unique (id, clinic_id),
  constraint lab_order_items_id_clinic_id_patient_id_key unique (id, clinic_id, patient_id),
  constraint lab_order_items_order_test_key unique (order_id, test_id),
  constraint lab_order_items_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_order_items_test_fkey
    foreign key (test_id, clinic_id) references public.lab_tests (id, clinic_id),
  constraint lab_order_items_panel_fkey
    foreign key (panel_id, clinic_id) references public.lab_panels (id, clinic_id),
  constraint lab_order_items_prices_check
    check (list_price_snapshot >= 0 and price_snapshot >= 0
           and (panel_id is not null or price_snapshot = list_price_snapshot))
);

create table public.lab_samples (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  patient_id uuid not null,
  order_id uuid not null,
  -- Human / barcode identifier, unique in the clinic.
  sample_code text not null,
  sample_type text not null,
  status public.lab_sample_status not null default 'collected',
  collected_at timestamptz not null default now(),
  collected_by uuid not null references public.profiles(id),
  received_at timestamptz,
  received_by uuid references public.profiles(id),
  rejected_at timestamptz,
  rejected_by uuid references public.profiles(id),
  reject_reason text,
  -- Operational notes only (e.g. "haemolysed", "second attempt").
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_samples_id_clinic_id_key unique (id, clinic_id),
  constraint lab_samples_clinic_code_key unique (clinic_id, sample_code),
  constraint lab_samples_order_fkey
    foreign key (order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id),
  constraint lab_samples_code_check check (sample_code ~ '^[A-Za-z0-9-]{3,40}$'),
  constraint lab_samples_type_check check (sample_type ~ '\S' and char_length(sample_type) <= 80),
  constraint lab_samples_received_check
    check ((received_at is null) = (received_by is null)),
  constraint lab_samples_rejected_check
    check ((status = 'rejected') = (rejected_at is not null)
           and (status = 'rejected') = (rejected_by is not null)
           and (status = 'rejected') = (reject_reason is not null)
           and (reject_reason is null or (reject_reason ~ '\S' and char_length(reject_reason) <= 300))),
  constraint lab_samples_notes_check check (notes is null or char_length(notes) <= 500)
);

create table public.lab_sample_items (
  sample_id uuid not null,
  order_item_id uuid not null,
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (sample_id, order_item_id),
  constraint lab_sample_items_sample_fkey
    foreign key (sample_id, clinic_id) references public.lab_samples (id, clinic_id),
  constraint lab_sample_items_item_fkey
    foreign key (order_item_id, clinic_id) references public.lab_order_items (id, clinic_id)
);

comment on table public.lab_orders is 'A lab request for one patient. Any clinic staff member may order; ordered_by records who. Server-only.';
comment on table public.lab_order_items is 'One test of a lab order with code, name, list price and charged price frozen at order time. Its status is the lab work position.';
comment on table public.lab_samples is 'A physical specimen of the order''s patient.';
comment on table public.lab_sample_items is 'Which order items a specimen serves; an item has at most one non-rejected sample.';

create unique index lab_orders_creation_key_key on public.lab_orders (clinic_id, ordered_by, creation_key)
  where creation_key is not null;
create unique index lab_orders_external_reference_key on public.lab_orders (clinic_id, external_reference)
  where external_reference is not null;
create index lab_orders_patient_idx on public.lab_orders (clinic_id, patient_id, created_at desc);
create index lab_orders_status_idx on public.lab_orders (clinic_id, status, created_at);
create index lab_orders_appointment_idx on public.lab_orders (appointment_id) where appointment_id is not null;
create index lab_order_items_status_idx on public.lab_order_items (clinic_id, status, created_at);
create index lab_order_items_patient_test_idx on public.lab_order_items (clinic_id, patient_id, test_id, created_at desc);
create index lab_order_items_order_idx on public.lab_order_items (order_id);
create index lab_samples_status_idx on public.lab_samples (clinic_id, status, collected_at);
create index lab_samples_order_idx on public.lab_samples (order_id);
create index lab_sample_items_item_idx on public.lab_sample_items (order_item_id);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Any staff role of the clinic (lab ordering has no role restriction).
create or replace function public.lab_is_clinic_member(p_clinic_id uuid, p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_profile_id
  );
$$;

revoke all on function public.lab_is_clinic_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_is_clinic_member(uuid, uuid) to service_role;

-- True while this transaction deletes the clinic (clinics_mark_erasure,
-- 20260930000006): its lab rows go with it, and only then may append-only
-- lab rows be deleted.
create or replace function public.lab_clinic_is_being_erased(p_clinic_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select strpos(coalesce(current_setting('app.erasing_clinics', true), ''), p_clinic_id::text || ',') > 0;
$$;

revoke all on function public.lab_clinic_is_being_erased(uuid) from public, anon, authenticated;

-- Fails unless only the listed columns differ between OLD and NEW.
create or replace function public.lab_assert_only_changed(p_old jsonb, p_new jsonb, p_mutable text[], p_what text)
returns void
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  for v_key in select jsonb_object_keys(p_new) loop
    if not (v_key = any (p_mutable)) and (p_old -> v_key) is distinct from (p_new -> v_key) then
      raise exception '%: % cannot be changed', p_what, v_key;
    end if;
  end loop;
end;
$$;

revoke all on function public.lab_assert_only_changed(jsonb, jsonb, text[], text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- lab_orders: provenance, lifecycle, immutability
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dob date;
  v_doctor_profile uuid;
  v_doctor_active boolean;
  v_appointment_status public.appointment_status;
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    if new.status <> 'active' then
      raise exception 'lab order: a new order must be active';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.ordered_by) then
      raise exception 'lab order: ordered_by must be a staff member of the clinic';
    end if;

    select p.date_of_birth into v_dob
    from public.patients p
    where p.id = new.patient_id and p.clinic_id = new.clinic_id;
    if found and v_dob is null and new.source <> 'external_import' then
      raise exception 'lab order: the patient''s date of birth is required before ordering lab tests';
    end if;

    if new.ordering_doctor_id is not null then
      select d.profile_id, d.active into v_doctor_profile, v_doctor_active
      from public.doctors d
      where d.id = new.ordering_doctor_id and d.clinic_id = new.clinic_id;
      if not found or not v_doctor_active or v_doctor_profile is distinct from new.ordered_by then
        raise exception 'lab order: ordering_doctor_id must be the orderer''s own active doctor account';
      end if;
    end if;

    if new.appointment_id is not null then
      select a.status into v_appointment_status
      from public.appointments a
      where a.id = new.appointment_id and a.clinic_id = new.clinic_id;
      if found and v_appointment_status not in ('in_progress', 'completed') then
        raise exception 'lab order: the consultation must be in progress or completed (it is %)', v_appointment_status;
      end if;
    end if;
    return new;
  end if;

  -- UPDATE: only the lifecycle moves.
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'],
    'lab order');
  new.updated_at := now();

  if new.status is distinct from old.status then
    if old.status <> 'active' then
      raise exception 'lab order: a % order cannot change status', old.status;
    end if;
    if new.status = 'cancelled' then
      new.cancelled_at := now();
      if new.cancelled_by is null or not public.lab_is_clinic_member(new.clinic_id, new.cancelled_by) then
        raise exception 'lab order: cancelled_by must be a staff member of the clinic';
      end if;
      if exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id
          and i.status not in ('ordered', 'ready_for_collection', 'cancelled')
      ) then
        raise exception 'lab order: an order with collected samples cannot be cancelled';
      end if;
    elsif new.status = 'completed' then
      if exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id and i.status not in ('verified', 'cancelled')
      ) or not exists (
        select 1 from public.lab_order_items i
        where i.order_id = new.id and i.status = 'verified'
      ) then
        raise exception 'lab order: completed requires every item verified or cancelled, and at least one verified';
      end if;
    end if;
  elsif new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason then
    raise exception 'lab order: cancellation details change only when the order is cancelled';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_orders_validate() from public, anon, authenticated;

create trigger lab_orders_validate
  before insert or update on public.lab_orders
  for each row execute function public.lab_orders_validate();

-- Cancelling an order cancels its open items.
create or replace function public.lab_orders_cancel_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.lab_order_items
  set status = 'cancelled', status_changed_by = new.cancelled_by
  where order_id = new.id and status in ('ordered', 'ready_for_collection');
  return null;
end;
$$;

revoke all on function public.lab_orders_cancel_items() from public, anon, authenticated;

create trigger lab_orders_cancel_items
  after update of status on public.lab_orders
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_orders_cancel_items();

-- ---------------------------------------------------------------------------
-- lab_order_items: snapshots from the catalog, lifecycle
-- ---------------------------------------------------------------------------

create or replace function public.lab_item_transition_allowed(
  p_from public.lab_item_status,
  p_to public.lab_item_status,
  p_source public.lab_order_source
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- Historical / external results arrive already performed.
    when p_source = 'external_import' then
      (p_from, p_to) in (('ordered', 'resulted'), ('ordered', 'verified'), ('resulted', 'verified'),
                         ('resulted', 'processing'), ('processing', 'resulted'), ('ordered', 'cancelled'))
    else
      (p_from, p_to) in (
        ('ordered', 'ready_for_collection'),
        ('ordered', 'cancelled'),
        ('ready_for_collection', 'collected'),
        ('ready_for_collection', 'cancelled'),
        ('collected', 'processing'),
        ('collected', 'ready_for_collection'),
        ('processing', 'resulted'),
        ('processing', 'ready_for_collection'),
        ('resulted', 'verified'),
        ('resulted', 'processing'))
  end;
$$;

revoke all on function public.lab_item_transition_allowed(public.lab_item_status, public.lab_item_status, public.lab_order_source)
  from public, anon, authenticated;

create or replace function public.lab_order_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.lab_orders;
  v_test public.lab_tests;
begin
  select * into v_order from public.lab_orders o where o.id = new.order_id and o.clinic_id = new.clinic_id;

  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.status_changed_at := now();
    if v_order.status is distinct from 'active' then
      raise exception 'lab order item: items can only be added to an active order';
    end if;
    if new.status <> 'ordered' then
      raise exception 'lab order item: a new item starts as ordered';
    end if;

    select * into v_test from public.lab_tests t where t.id = new.test_id and t.clinic_id = new.clinic_id;
    if not found then
      raise exception 'lab order item: unknown test';
    end if;
    if not v_test.active and v_order.source <> 'external_import' then
      raise exception 'lab order item: test % is inactive and cannot be ordered', v_test.code;
    end if;
    if new.panel_id is not null then
      if not exists (
        select 1 from public.lab_panel_tests pt
        where pt.panel_id = new.panel_id and pt.test_id = new.test_id and pt.clinic_id = new.clinic_id
      ) then
        raise exception 'lab order item: test % is not part of the panel', v_test.code;
      end if;
      if v_order.source <> 'external_import' and not exists (
        select 1 from public.lab_panels p where p.id = new.panel_id and p.active
      ) then
        raise exception 'lab order item: the panel is inactive and cannot be ordered';
      end if;
    end if;

    -- The catalog, never the caller, decides what the item is and costs.
    new.test_code_snapshot := v_test.code;
    new.test_name_snapshot := v_test.name;
    new.list_price_snapshot := v_test.price;
    if new.panel_id is null then
      new.price_snapshot := v_test.price;
    end if;
    return new;
  end if;

  -- UPDATE: only the work position moves.
  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'status_changed_at', 'status_changed_by', 'updated_at'],
    'lab order item');
  new.updated_at := now();
  if new.status is distinct from old.status then
    if not public.lab_item_transition_allowed(old.status, new.status, v_order.source) then
      raise exception 'lab order item: % → % is not allowed', old.status, new.status;
    end if;
    if new.status = 'ready_for_collection' and v_order.status <> 'active' then
      raise exception 'lab order item: the order is %', v_order.status;
    end if;
    new.status_changed_at := now();
    if new.status_changed_by is not null and not public.lab_is_clinic_member(new.clinic_id, new.status_changed_by) then
      raise exception 'lab order item: status_changed_by must be a staff member of the clinic';
    end if;
  else
    new.status_changed_at := old.status_changed_at;
    new.status_changed_by := old.status_changed_by;
  end if;
  return new;
end;
$$;

revoke all on function public.lab_order_items_validate() from public, anon, authenticated;

create trigger lab_order_items_validate
  before insert or update on public.lab_order_items
  for each row execute function public.lab_order_items_validate();

-- ---------------------------------------------------------------------------
-- lab_samples and lab_sample_items
-- ---------------------------------------------------------------------------

create or replace function public.lab_samples_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.updated_at := now();
    new.collected_at := now();
    if new.status <> 'collected' or new.received_at is not null or new.rejected_at is not null then
      raise exception 'lab sample: a new sample starts as collected';
    end if;
    if not exists (
      select 1 from public.lab_orders o
      where o.id = new.order_id and o.clinic_id = new.clinic_id and o.status = 'active'
    ) then
      raise exception 'lab sample: samples can only be collected for an active order';
    end if;
    if not public.lab_is_clinic_member(new.clinic_id, new.collected_by) then
      raise exception 'lab sample: collected_by must be a staff member of the clinic';
    end if;
    return new;
  end if;

  perform public.lab_assert_only_changed(
    to_jsonb(old), to_jsonb(new),
    array['status', 'received_at', 'received_by', 'rejected_at', 'rejected_by', 'reject_reason', 'notes', 'updated_at'],
    'lab sample');
  new.updated_at := now();

  if new.status is distinct from old.status then
    if not ((old.status, new.status) in (('collected', 'received'), ('collected', 'rejected'), ('received', 'rejected'))) then
      raise exception 'lab sample: % → % is not allowed', old.status, new.status;
    end if;
    if new.status = 'received' then
      new.received_at := now();
      if new.received_by is null or not public.lab_is_clinic_member(new.clinic_id, new.received_by) then
        raise exception 'lab sample: received_by must be a staff member of the clinic';
      end if;
    else
      new.rejected_at := now();
      if new.rejected_by is null or not public.lab_is_clinic_member(new.clinic_id, new.rejected_by) then
        raise exception 'lab sample: rejected_by must be a staff member of the clinic';
      end if;
    end if;
  elsif new.received_at is distinct from old.received_at or new.received_by is distinct from old.received_by
     or new.rejected_at is distinct from old.rejected_at or new.rejected_by is distinct from old.rejected_by
     or new.reject_reason is distinct from old.reject_reason then
    raise exception 'lab sample: receipt and rejection details change only with the status';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_samples_validate() from public, anon, authenticated;

create trigger lab_samples_validate
  before insert or update on public.lab_samples
  for each row execute function public.lab_samples_validate();

-- A link is fixed once made; it may only be created for an item of the same
-- order that is not cancelled and has no other live (non-rejected) sample.
-- The item row is locked, so two collectors cannot both attach a sample.
create or replace function public.lab_sample_items_validate()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.lab_order_items;
  v_sample public.lab_samples;
begin
  if tg_op = 'DELETE' and public.lab_clinic_is_being_erased(old.clinic_id) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'lab sample item: links cannot be changed or removed';
  end if;
  new.created_at := now();

  select * into v_item from public.lab_order_items i
  where i.id = new.order_item_id and i.clinic_id = new.clinic_id
  for update;
  select * into v_sample from public.lab_samples s
  where s.id = new.sample_id and s.clinic_id = new.clinic_id;

  if v_item.id is null or v_sample.id is null then
    raise exception 'lab sample item: unknown sample or order item';
  end if;
  if v_item.order_id <> v_sample.order_id or v_item.patient_id <> v_sample.patient_id then
    raise exception 'lab sample item: the sample and the order item belong to different orders';
  end if;
  if v_sample.status = 'rejected' then
    raise exception 'lab sample item: the sample was rejected';
  end if;
  if v_item.status in ('cancelled', 'verified') then
    raise exception 'lab sample item: the order item is %', v_item.status;
  end if;
  if exists (
    select 1
    from public.lab_sample_items si
    join public.lab_samples s on s.id = si.sample_id
    where si.order_item_id = new.order_item_id and s.status <> 'rejected'
  ) then
    raise exception 'lab sample item: the order item already has a sample';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_sample_items_validate() from public, anon, authenticated;

create trigger lab_sample_items_validate
  before insert or update or delete on public.lab_sample_items
  for each row execute function public.lab_sample_items_validate();

-- ---------------------------------------------------------------------------
-- Audit: ids and states only — never values or free text
-- ---------------------------------------------------------------------------

create or replace function public.lab_workflow_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_actor uuid;
  v_values jsonb;
begin
  if tg_table_name = 'lab_orders' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_created';
      v_actor := new.ordered_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_' || new.status::text;
      v_actor := coalesce(new.cancelled_by, auth.uid());
    else
      return null;
    end if;
    v_values := jsonb_build_object('status', new.status, 'source', new.source,
                                   'ordering_doctor_id', new.ordering_doctor_id, 'appointment_id', new.appointment_id);
  elsif tg_table_name = 'lab_order_items' then
    if tg_op = 'INSERT' then
      v_action := 'lab_order_item_created';
    elsif new.status is distinct from old.status then
      v_action := 'lab_order_item_status_changed';
    else
      return null;
    end if;
    v_actor := coalesce(new.status_changed_by, auth.uid());
    v_values := jsonb_build_object('order_id', new.order_id, 'test_id', new.test_id, 'status', new.status,
                                   'previous_status', case when tg_op = 'UPDATE' then old.status end);
  elsif tg_table_name = 'lab_samples' then
    if tg_op = 'INSERT' then
      v_action := 'lab_sample_collected';
      v_actor := new.collected_by;
    elsif new.status is distinct from old.status then
      v_action := 'lab_sample_' || new.status::text;
      v_actor := coalesce(new.rejected_by, new.received_by, auth.uid());
    else
      return null;
    end if;
    v_values := jsonb_build_object('order_id', new.order_id, 'status', new.status);
  else
    return null;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values (
    new.clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    v_action,
    tg_table_name,
    new.id::text,
    new.patient_id,
    v_values
  );
  return null;
end;
$$;

revoke all on function public.lab_workflow_audit() from public, anon, authenticated;

create trigger lab_orders_audit after insert or update on public.lab_orders
  for each row execute function public.lab_workflow_audit();
create trigger lab_order_items_audit after insert or update on public.lab_order_items
  for each row execute function public.lab_workflow_audit();
create trigger lab_samples_audit after insert or update on public.lab_samples
  for each row execute function public.lab_workflow_audit();

-- ---------------------------------------------------------------------------
-- Access: server only; RLS as the backstop
-- ---------------------------------------------------------------------------

alter table public.lab_orders enable row level security;
alter table public.lab_order_items enable row level security;
alter table public.lab_samples enable row level security;
alter table public.lab_sample_items enable row level security;

create policy "lab orders read for operational staff" on public.lab_orders
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab orders read for authorized doctors" on public.lab_orders
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab order items read for operational staff" on public.lab_order_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab order items read for authorized doctors" on public.lab_order_items
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab samples read for operational staff" on public.lab_samples
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));
create policy "lab samples read for authorized doctors" on public.lab_samples
  for select to authenticated
  using (public.doctor_can_read_patient(clinic_id, patient_id));

create policy "lab sample items read for operational staff" on public.lab_sample_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['owner', 'admin', 'manager', 'receptionist']::public.staff_role[]));

do $$
declare
  t text;
begin
  foreach t in array array['lab_orders', 'lab_order_items', 'lab_samples', 'lab_sample_items'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('grant select, insert, update on table public.%I to service_role', t);
  end loop;
end;
$$;
