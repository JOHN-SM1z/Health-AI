-- Outpatient pilot, Phase 3: laboratory tests on the visit bill and a walk-in
-- lab queue (owner decisions 2026-10-08: walk-in lab queue first; tests are
-- paid before the sample is taken — the clinic's lab setting
-- paymentPolicy = "before_collection" holds the tests until the bill is paid).
--
--   * A lab walk-in (register_lab_arrival) is a visit of kind 'lab': the order
--     is created with create_lab_order() as before and its tests become lines
--     of the visit's bill — one bill, one kassa. The order's own lab payment
--     row is not created for visit-billed orders (no double bill).
--   * Tests a doctor orders during a walk-in consultation are billed to that
--     visit the same way (the order's appointment is the visit's consultation).
--   * Full payment releases the visit's tests for collection.
--   * Cancelling a test in the laboratory voids its line; money already paid
--     for it shows as due back (a refund at the kassa), like a cancelled paid
--     lab order today. A lab line cannot be removed at the desk.
--   * Lab staff call, start and complete lab visits; samples use the existing
--     collection flow. Lab visits share the clinic-day queue numbers.
--   * Cancelling a lab walk-in at the desk (nothing paid, no sample taken)
--     cancels its lab order, so the tests leave the lab's work queue.

-- ---------------------------------------------------------------------------
-- Schema
-- ---------------------------------------------------------------------------

alter table public.visits
  add column kind text not null default 'doctor' check (kind in ('doctor', 'lab')),
  add column lab_order_id uuid;
alter table public.visits alter column doctor_id drop not null;
alter table public.visits
  add constraint visits_kind_doctor_check check ((kind = 'doctor') = (doctor_id is not null)),
  add constraint visits_lab_order_fkey foreign key (lab_order_id, clinic_id) references public.lab_orders (id, clinic_id) on delete restrict;
create unique index visits_lab_order_key on public.visits (lab_order_id) where lab_order_id is not null;

alter table public.lab_orders add column visit_id uuid;
alter table public.lab_orders
  add constraint lab_orders_visit_fkey foreign key (visit_id, clinic_id, patient_id) references public.visits (id, clinic_id, patient_id) on delete restrict;
create index lab_orders_visit_idx on public.lab_orders (visit_id) where visit_id is not null;
comment on column public.lab_orders.visit_id is 'Set when the order is billed on a walk-in visit (lab walk-in, or ordered in that visit''s consultation): its tests are lines of the visit''s bill and it has no lab payment row of its own.';

alter table public.visit_charges alter column service_id drop not null;
alter table public.visit_charges add column lab_order_item_id uuid;
alter table public.visit_charges
  add constraint visit_charges_lab_item_fkey foreign key (lab_order_item_id, clinic_id) references public.lab_order_items (id, clinic_id) on delete restrict,
  add constraint visit_charges_subject_check check (num_nonnulls(service_id, lab_order_item_id) = 1);
create unique index visit_charges_lab_item_key on public.visit_charges (lab_order_item_id) where lab_order_item_id is not null;

-- The charge guard also keeps the lab item fixed.
create or replace function public.visit_charges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visit charges are never deleted; void them' using errcode = '42501';
  end if;
  if old.status = 'active' and new.status = 'voided'
     and (new.id, new.clinic_id, new.visit_id, new.patient_id, new.service_id, new.lab_order_item_id, new.service_name, new.unit_price,
          new.quantity, new.amount, new.currency, new.created_by, new.created_at, new.idempotency_key)
         is not distinct from
         (old.id, old.clinic_id, old.visit_id, old.patient_id, old.service_id, old.lab_order_item_id, old.service_name, old.unit_price,
          old.quantity, old.amount, old.currency, old.created_by, old.created_at, old.idempotency_key) then
    return new;
  end if;
  raise exception 'visit charges cannot be changed; void and add a new line' using errcode = '42501';
end;
$$;

-- ---------------------------------------------------------------------------
-- Billing lab orders on a visit
-- ---------------------------------------------------------------------------

-- Which visit an order is billed on: the lab walk-in being registered (set
-- for this transaction by register_lab_arrival), or the walk-in visit whose
-- consultation the order was placed in.
create or replace function public.lab_orders_bill_to_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lab_visit uuid := nullif(current_setting('health_ai.lab_visit_id', true), '')::uuid;
begin
  if new.visit_id is null then
    if v_lab_visit is not null then
      new.visit_id := v_lab_visit;
    elsif new.appointment_id is not null then
      select v.id into new.visit_id
        from public.visits v
       where v.appointment_id = new.appointment_id and v.clinic_id = new.clinic_id and v.status <> 'cancelled';
    end if;
  end if;
  return new;
end;
$$;

create trigger lab_orders_bill_to_visit
  before insert on public.lab_orders
  for each row execute function public.lab_orders_bill_to_visit();

-- Each test of a visit-billed order becomes a line of the visit's bill,
-- priced from the item's own stored price.
create or replace function public.lab_items_charge_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.visit_charges (clinic_id, visit_id, patient_id, lab_order_item_id, service_name, unit_price, quantity, amount, currency, created_by)
  select new.clinic_id, o.visit_id, new.patient_id, new.id, new.test_name_snapshot, new.price_snapshot, 1, new.price_snapshot, c.currency, o.ordered_by
    from public.lab_orders o
    join public.clinics c on c.id = o.clinic_id
   where o.id = new.order_id and o.visit_id is not null;
  return null;
end;
$$;

create trigger lab_order_items_charge_visit
  after insert on public.lab_order_items
  for each row execute function public.lab_items_charge_visit();

-- No separate lab bill for a visit-billed order (no double charge).
create or replace function public.payments_skip_visit_billed_lab_order()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is not null
     and exists (select 1 from public.lab_orders o where o.id = new.lab_order_id and o.visit_id is not null) then
    return null;
  end if;
  return new;
end;
$$;

-- Named to run before payments_lab_amount_guard (triggers fire in name order).
create trigger payments_a_skip_visit_billed_lab
  before insert on public.payments
  for each row execute function public.payments_skip_visit_billed_lab_order();

-- A test cancelled in the laboratory leaves the bill: its line is voided.
-- Money already paid for it then shows as due back at the kassa.
create or replace function public.lab_items_void_visit_charge()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.visit_charges ch
     set status = 'voided',
         voided_at = now(),
         void_reason = 'Tahlil bekor qilindi',
         voided_by = coalesce(new.status_changed_by, o.cancelled_by, o.ordered_by)
    from public.lab_orders o
   where ch.lab_order_item_id = new.id and ch.status = 'active' and o.id = new.order_id;
  return null;
end;
$$;

create trigger lab_order_items_void_visit_charge
  after update of status on public.lab_order_items
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_items_void_visit_charge();

-- ---------------------------------------------------------------------------
-- Lab walk-in registration
-- ---------------------------------------------------------------------------

create or replace function public.register_lab_arrival(
  p_clinic uuid,
  p_actor uuid,
  p_key uuid,
  p_patient uuid,
  p_new_patient jsonb,
  p_test_ids uuid[],
  p_panel_ids uuid[]
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
  v_order uuid;
  v_total numeric;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  if p_key is null then
    raise exception using message = 'operations: request key required', errcode = '22023', hint = 'invalid_request';
  end if;
  v_fingerprint := md5(jsonb_build_array(
    p_actor, p_patient, p_new_patient, 'lab',
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(coalesce(p_test_ids, '{}')) x),
    (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(coalesce(p_panel_ids, '{}')) x)
  )::text);

  perform pg_advisory_xact_lock(hashtextextended('visit-register:' || p_clinic::text, 0));

  select * into v from public.visits where clinic_id = p_clinic and idempotency_key = p_key;
  if found then
    if v.request_fingerprint <> v_fingerprint then
      raise exception using message = 'operations: request key reused for a different request', errcode = '22023', hint = 'idempotency_conflict';
    end if;
    return jsonb_build_object('visit_id', v.id, 'replayed', true);
  end if;

  select * into v_clinic from public.clinics where id = p_clinic;

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
    if v_name is null or char_length(v_name) not between 2 and 120 or v_dob is null then
      raise exception using message = 'operations: patient name and date of birth required', errcode = '22023', hint = 'invalid_patient';
    end if;
    if v_phone is not null and v_phone !~ '^\+?[0-9 ()-]{7,24}$' then
      raise exception using message = 'operations: invalid phone', errcode = '22023', hint = 'invalid_patient';
    end if;
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
     where clinic_id = p_clinic and patient_id = v_patient and kind = 'lab'
       and status in ('awaiting_payment', 'waiting', 'called', 'in_progress')
  ) then
    raise exception using message = 'operations: this patient is already registered for the laboratory', errcode = '22023', hint = 'already_registered_lab';
  end if;

  insert into public.visits (clinic_id, patient_id, doctor_id, kind, created_by, idempotency_key, request_fingerprint)
  values (p_clinic, v_patient, null, 'lab', p_actor, p_key, v_fingerprint)
  returning * into v;

  -- The order is billed on this visit (lab_orders_bill_to_visit reads this).
  perform set_config('health_ai.lab_visit_id', v.id::text, true);
  select o.lab_order_id into v_order
    from public.create_lab_order(p_clinic, v_patient, p_actor, 'walk_in'::public.lab_order_source,
                                 coalesce(p_test_ids, '{}'), coalesce(p_panel_ids, '{}'), p_key, null, null) o;
  perform set_config('health_ai.lab_visit_id', '', true);

  update public.visits set lab_order_id = v_order where id = v.id returning * into v;

  select coalesce(sum(amount), 0) into v_total from public.visit_charges where visit_id = v.id and status = 'active';
  if not v_clinic.queue_after_payment or v_total = 0 then
    v := public.visit_enqueue(v.id);
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'lab_visit_registered', 'visits', v.id::text,
          jsonb_build_object('patient_id', v_patient, 'lab_order_id', v_order, 'charge_total', v_total, 'new_patient', p_patient is null));

  return jsonb_build_object('visit_id', v.id, 'lab_order_id', v_order, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Redefined: payment releases lab tests; lab lines are not voided at the desk;
-- lab staff run lab visits
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

  -- Paid in full (the only kind of payment): the visit's lab tests that were
  -- waiting for payment (clinic lab setting "before_collection") can now be
  -- collected — the same release payments_release_lab_items does for a lab
  -- order's own bill.
  update public.lab_order_items i
     set status = 'ready_for_collection', status_changed_by = p_actor
    from public.lab_orders o
   where o.id = i.order_id and o.visit_id = v.id and o.clinic_id = p_clinic and i.status = 'ordered';

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_payment_recorded', 'visits', v.id::text,
          jsonb_build_object('amount', v_sum, 'methods', to_jsonb(v_methods), 'queue_number', v.queue_number));

  return jsonb_build_object('visit_id', v.id, 'replayed', false, 'queue_number', v.queue_number);
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
  -- A lab test is cancelled in the laboratory (its line is then voided
  -- automatically); removing only the money line would leave a test the lab
  -- could still collect unpaid.
  if c.lab_order_item_id is not null then
    raise exception using message = 'operations: cancel the lab test in the laboratory', errcode = '22023', hint = 'cancel_lab_test';
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
  v_lab boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor', 'lab']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  -- Laboratory staff run the lab queue (lab visits only).
  v_lab := v.kind = 'lab' and public.ops_has_role(p_clinic, p_actor, array['lab']::public.staff_role[]);
  if not v_desk and not v_own_doctor and not v_lab then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'in_progress' and v.status in ('waiting', 'called') and v_lab then
    -- Sample collection begins (the samples themselves go through the lab's own flow).
    update public.visits set status = 'in_progress', started_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_lab then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    -- The consultation ends now, not when its booked duration would: a
    -- completed appointment still occupies its slot (no_overlapping_active_
    -- appointments), and a walk-in queue must let the doctor start the next
    -- patient at once. Never shorter than one minute (end > start).
    update public.appointments
       set status = 'completed', end_at = greatest(now(), start_at + interval '1 minute')
     where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    -- A cancelled lab walk-in takes its tests out of the laboratory's work
    -- too; once a sample is taken the lab decides (reject or result) instead.
    if v.lab_order_id is not null and exists (
      select 1 from public.lab_order_items i
       where i.order_id = v.lab_order_id and i.status not in ('ordered', 'ready_for_collection', 'cancelled')
    ) then
      raise exception using message = 'operations: a sample was already taken', errcode = '22023', hint = 'lab_sample_taken';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.lab_orders set status = 'cancelled', cancelled_by = p_actor, cancel_reason = 'Tashrif bekor qilindi'
     where id = v.lab_order_id and clinic_id = p_clinic and status = 'active';
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

revoke all on function public.lab_orders_bill_to_visit() from public, anon, authenticated;
revoke all on function public.lab_items_charge_visit() from public, anon, authenticated;
revoke all on function public.payments_skip_visit_billed_lab_order() from public, anon, authenticated;
revoke all on function public.lab_items_void_visit_charge() from public, anon, authenticated;
revoke all on function public.register_lab_arrival(uuid, uuid, uuid, uuid, jsonb, uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.register_lab_arrival(uuid, uuid, uuid, uuid, jsonb, uuid[], uuid[]) to service_role;
