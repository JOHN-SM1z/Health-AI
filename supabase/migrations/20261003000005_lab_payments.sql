-- Laboratory module, phase 5a: a laboratory order is a second billable entity of the EXISTING payments table.
--
-- Decision D2 (docs/labs/DECISIONS.md): no `lab_payments`, no second payment engine. `payments` keeps its
-- statuses, its legal transitions (src/lib/payments/status.ts), its audit and its "server-managed" guard;
-- a payment row now belongs to exactly one billable entity: an appointment OR a lab order.
--
--   * appointment_id becomes nullable, lab_order_id is new, and a check requires exactly one of them.
--     The existing unique (appointment_id) stays: every consumer that reads `appointments → payments` still
--     sees at most one payment per appointment (a lab payment has no appointment and is never matched).
--   * A lab payment is tied to its order, patient and clinic by a composite same-clinic FK, is always the
--     `manual` provider (the only production-usable one) and its owner, patient, clinic, amount, currency
--     and provider never change afterwards — only its status moves, through the existing engine.
--   * The AMOUNT is computed here, from the order's price snapshots, never from a request: the sum of the
--     active items, except that a panel with a fixed price replaces its tests' prices when ALL of the panel's
--     tests are on the order as that panel's items.
--   * lab_create_order() (phase 4) now also creates the order's payment — `unpaid`, truthfully — in the same
--     transaction, like the booking engine does for appointments. Orders that already exist get one.
--
-- Whether payment is required before a sample is collected is the clinic's setting (see 20261003000006).
--
-- Reversible while no lab payment exists: delete the lab payments, drop payments_lab_immutable / the
-- constraints / the column, `alter column appointment_id set not null`, restore lab_create_order() from
-- 20261003000004.

alter table public.payments alter column appointment_id drop not null;
alter table public.payments add column lab_order_id uuid;

-- Added NOT VALID and validated separately: validation takes only a SHARE UPDATE EXCLUSIVE lock, so a large
-- payments table is not blocked while it is scanned.
alter table public.payments
  add constraint payments_one_owner_check check (num_nonnulls(appointment_id, lab_order_id) = 1) not valid;
alter table public.payments validate constraint payments_one_owner_check;

alter table public.payments
  add constraint payments_lab_manual_only_check check (lab_order_id is null or provider = 'manual') not valid;
alter table public.payments validate constraint payments_lab_manual_only_check;

alter table public.payments
  add constraint payments_lab_order_fkey foreign key (lab_order_id, clinic_id, patient_id)
  references public.lab_orders (id, clinic_id, patient_id) on delete restrict;

create unique index payments_lab_order_key on public.payments (lab_order_id) where lab_order_id is not null;

comment on column public.payments.lab_order_id is
  'The laboratory order this payment settles (exactly one of appointment_id / lab_order_id). Set only by lab_create_order().';

-- What a lab payment is, once written, cannot be rewritten: only its status (and the engine's bookkeeping) moves.
create or replace function public.payments_lab_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is distinct from old.lab_order_id then
    raise exception 'payments: the billable entity of a payment cannot change';
  end if;
  if old.lab_order_id is not null and (
       new.clinic_id is distinct from old.clinic_id
    or new.patient_id is distinct from old.patient_id
    or new.amount is distinct from old.amount
    or new.currency is distinct from old.currency
    or new.provider is distinct from old.provider
  ) then
    raise exception 'payments: the amount, currency, patient and provider of a lab payment cannot change';
  end if;
  return new;
end;
$$;

create trigger payments_lab_immutable before update on public.payments
  for each row execute function public.payments_lab_immutable();

-- The amount of an order, from its snapshots. Fixed-price panel: only when every test of the panel is on the
-- order as that panel's item (otherwise the order is not "the panel", and its tests are priced one by one).
create or replace function public.lab_order_amount(p_order uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  with items as (
    select i.test_id, i.panel_id, i.price_snapshot
      from public.lab_order_items i
     where i.order_id = p_order and i.status = 'active'
  ),
  whole_panels as (
    select p.id, p.price
      from public.lab_panels p
     where p.price is not null
       and p.id in (select panel_id from items where panel_id is not null)
       and not exists (
         select 1 from public.lab_panel_tests pt
          where pt.panel_id = p.id
            and not exists (select 1 from items i2 where i2.test_id = pt.test_id and i2.panel_id = p.id)
       )
  )
  select coalesce((select sum(price_snapshot) from items
                    where panel_id is null or panel_id not in (select id from whole_panels)), 0)
       + coalesce((select sum(price) from whole_panels), 0);
$$;

revoke all on function public.lab_order_amount(uuid) from public, anon, authenticated;
grant execute on function public.lab_order_amount(uuid) to service_role;

-- The order's payment, created with the order.
create or replace function public.lab_create_order(
  p_clinic_id uuid,
  p_actor uuid,
  p_patient_id uuid,
  p_doctor_id uuid,
  p_appointment_id uuid,
  p_referral_id uuid,
  p_priority public.lab_priority,
  p_notes text,
  p_creation_key uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_item jsonb;
  v_existing record;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'lab order: an order needs at least one test';
  end if;

  if p_creation_key is not null then
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if found then
      return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, ordering_doctor_id, appointment_id, referral_id, priority, notes, creation_key, created_by)
    values (p_clinic_id, p_patient_id, p_doctor_id, p_appointment_id, p_referral_id, coalesce(p_priority, 'routine'), p_notes, p_creation_key, p_actor)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent submission with the same key won: answer with its order.
    select o.id, o.patient_id, o.appointment_id into v_existing
      from public.lab_orders o
     where o.clinic_id = p_clinic_id and o.ordering_doctor_id = p_doctor_id and o.creation_key = p_creation_key;
    if not found then
      raise;
    end if;
    return jsonb_build_object('order_id', v_existing.id, 'replayed', true, 'patient_id', v_existing.patient_id, 'appointment_id', v_existing.appointment_id);
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    insert into public.lab_order_items (clinic_id, order_id, test_id, panel_id)
    values (p_clinic_id, v_order, (v_item ->> 'test_id')::uuid, nullif(v_item ->> 'panel_id', '')::uuid);
  end loop;

  -- The payment is part of the order: unpaid until staff confirm it, priced from the snapshots just written.
  insert into public.payments (clinic_id, lab_order_id, patient_id, amount, currency, status, provider)
  select p_clinic_id, v_order, p_patient_id, public.lab_order_amount(v_order), coalesce(c.currency, 'UZS'), 'unpaid', 'manual'
    from public.clinics c where c.id = p_clinic_id;

  return jsonb_build_object('order_id', v_order, 'replayed', false, 'patient_id', p_patient_id, 'appointment_id', p_appointment_id);
end;
$$;

revoke all on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) to service_role;

-- Orders that predate this migration (none in production: the module is not deployed) get their payment.
insert into public.payments (clinic_id, lab_order_id, patient_id, amount, currency, status, provider)
select o.clinic_id, o.id, o.patient_id, public.lab_order_amount(o.id), coalesce(c.currency, 'UZS'), 'unpaid', 'manual'
  from public.lab_orders o
  join public.clinics c on c.id = o.clinic_id
 where not exists (select 1 from public.payments p where p.lab_order_id = o.id);
