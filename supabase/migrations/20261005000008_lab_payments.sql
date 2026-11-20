-- Laboratory (Phase 6): lab orders in the existing payment engine.
--
-- No second payment system: public.payments gains a second possible subject.
-- A payment belongs to exactly one appointment OR one lab order; every
-- existing path keeps finding appointment payments by appointment_id, so the
-- booking engine, the Click webhook, the Mini App and analytics are
-- untouched. Status changes still go only through the server
-- (payments_block_direct_write, transitionPaymentStatus); order status and
-- payment status stay separate (lab_orders.status vs payments.status).
--
--   * create_lab_order() now also creates the order's bill: one 'manual'
--     payment, status 'unpaid', amount = the sum of the items' stored prices
--     (catalog price or allocated panel share — never a client value).
--   * payments_lab_amount_guard: a lab payment's amount must always equal its
--     order's non-cancelled item total while it is unpaid (or failed), and can
--     never change once pending, paid or refunded — so it cannot be forged
--     even by a server bug.
--   * Cancelling an item of an unpaid order lowers the bill to match.
--   * When a lab payment becomes paid, items still waiting for payment
--     ('ordered', clinic policy "before_collection") become ready for
--     collection. Under the default policy they already are (O6).
--   * Refunds use the existing transition paid → refunded (whole payment):
--     the existing Kassa has no partial refunds, and item prices are stored
--     per item for when it does.
-- Lab payments never cascade-delete: a lab order with a bill keeps it.

alter table public.payments
  alter column appointment_id drop not null,
  add column lab_order_id uuid;

alter table public.payments
  add constraint payments_one_subject_check
    check (num_nonnulls(appointment_id, lab_order_id) = 1),
  add constraint payments_lab_order_fkey
    foreign key (lab_order_id, clinic_id, patient_id) references public.lab_orders (id, clinic_id, patient_id);

create unique index payments_lab_order_key on public.payments (lab_order_id) where lab_order_id is not null;

comment on column public.payments.lab_order_id is
  'The lab order this payment bills (exactly one of appointment_id / lab_order_id). Amount = the order''s stored item prices.';

-- ---------- Amount guard ----------

create or replace function public.lab_order_bill_total(p_order_id uuid)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(sum(i.price_snapshot), 0)
  from public.lab_order_items i
  where i.order_id = p_order_id and i.status <> 'cancelled';
$$;

revoke all on function public.lab_order_bill_total(uuid) from public, anon, authenticated;

create or replace function public.payments_lab_amount_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.lab_order_id is null then
    if tg_op = 'UPDATE' and old.lab_order_id is not null then
      raise exception 'payment: the subject of a payment cannot change';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and (old.lab_order_id is distinct from new.lab_order_id or old.appointment_id is distinct from new.appointment_id) then
    raise exception 'payment: the subject of a payment cannot change';
  end if;
  if tg_op = 'UPDATE' and old.status not in ('unpaid', 'failed') then
    if new.amount is distinct from old.amount then
      raise exception 'payment: the amount of a % lab payment cannot change', old.status;
    end if;
    return new;
  end if;
  if new.amount is distinct from public.lab_order_bill_total(new.lab_order_id) then
    raise exception 'payment: a lab payment''s amount must equal its order''s item prices';
  end if;
  return new;
end;
$$;

revoke all on function public.payments_lab_amount_guard() from public, anon, authenticated;

create trigger payments_lab_amount_guard
  before insert or update on public.payments
  for each row execute function public.payments_lab_amount_guard();

-- ---------- Cancelled items leave an unpaid bill ----------

create or replace function public.lab_items_rebill()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.payments
  set amount = public.lab_order_bill_total(new.order_id), updated_at = now()
  where lab_order_id = new.order_id and status in ('unpaid', 'failed');
  return null;
end;
$$;

revoke all on function public.lab_items_rebill() from public, anon, authenticated;

create trigger lab_order_items_rebill
  after update of status on public.lab_order_items
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_items_rebill();

-- ---------- Paid releases items waiting for payment ----------

create or replace function public.payments_release_lab_items()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.lab_order_items
  set status = 'ready_for_collection', status_changed_by = new.paid_by
  where order_id = new.lab_order_id and status = 'ordered';
  return null;
end;
$$;

revoke all on function public.payments_release_lab_items() from public, anon, authenticated;

create trigger payments_release_lab_items
  after update of status on public.payments
  for each row when (new.lab_order_id is not null and new.status = 'paid' and old.status is distinct from new.status)
  execute function public.payments_release_lab_items();

-- ---------- create_lab_order() now bills the order ----------

create or replace function public.create_lab_order(
  p_clinic_id uuid,
  p_patient_id uuid,
  p_ordered_by uuid,
  p_source public.lab_order_source,
  p_test_ids uuid[],
  p_panel_ids uuid[],
  p_creation_key uuid default null,
  p_ordering_doctor_id uuid default null,
  p_appointment_id uuid default null
)
returns table (lab_order_id uuid, replayed boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tests uuid[] := coalesce(p_test_ids, '{}');
  v_panels uuid[] := coalesce(p_panel_ids, '{}');
  v_order uuid;
  v_existing public.lab_orders;
  v_panel public.lab_panels;
  v_unit numeric;
  v_units bigint;
  v_total numeric;
  v_count integer;
  v_assigned bigint;
  v_share bigint;
  v_test uuid;
  v_policy text;
  r record;
begin
  if cardinality(v_tests) + cardinality(v_panels) = 0 then
    raise exception 'lab_order_empty: choose at least one test or panel';
  end if;
  if cardinality(v_tests) + cardinality(v_panels) > 50 then
    raise exception 'lab_order_too_large: at most 50 tests and panels per order';
  end if;
  if (select count(distinct t) from unnest(v_tests) t) <> cardinality(v_tests)
     or (select count(distinct p) from unnest(v_panels) p) <> cardinality(v_panels) then
    raise exception 'lab_order_duplicate_test: a test or panel is chosen twice';
  end if;

  -- Idempotent replay.
  if p_creation_key is not null then
    select * into v_existing
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if found then
      if v_existing.patient_id <> p_patient_id
         or (select coalesce(array_agg(i.test_id order by i.test_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is null)
            <> (select coalesce(array_agg(t order by t), '{}') from unnest(v_tests) t)
         or (select coalesce(array_agg(distinct i.panel_id order by i.panel_id), '{}') from public.lab_order_items i where i.order_id = v_existing.id and i.panel_id is not null)
            <> (select coalesce(array_agg(p order by p), '{}') from unnest(v_panels) p) then
        raise exception 'lab_order_key_reused: this request key was already used for a different order';
      end if;
      return query select v_existing.id, true;
      return;
    end if;
  end if;

  begin
    insert into public.lab_orders (clinic_id, patient_id, source, ordered_by, ordering_doctor_id, appointment_id, creation_key)
    values (p_clinic_id, p_patient_id, p_source, p_ordered_by, p_ordering_doctor_id, p_appointment_id, p_creation_key)
    returning id into v_order;
  exception when unique_violation then
    -- A concurrent request with the same key won the race: replay it.
    select o.id into v_order
    from public.lab_orders o
    where o.clinic_id = p_clinic_id and o.ordered_by = p_ordered_by and o.creation_key = p_creation_key;
    if v_order is null then
      raise;
    end if;
    return query select v_order, true;
    return;
  end;

  -- Single tests: the item trigger prices them from the catalog.
  foreach v_test in array v_tests loop
    insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
    values (p_clinic_id, v_order, p_patient_id, v_test, '', '', 0, 0);
  end loop;

  -- Panels: proportional allocation of the panel price (O2).
  foreach v_test in array v_panels loop
    select * into v_panel from public.lab_panels p where p.id = v_test and p.clinic_id = p_clinic_id;
    if not found then
      raise exception 'lab_order_unknown_panel: the panel is not in this clinic';
    end if;
    if not v_panel.active then
      raise exception 'lab_order_inactive_panel: panel % is inactive and cannot be ordered', v_panel.code;
    end if;

    v_unit := case when v_panel.price = trunc(v_panel.price) then 1 else 0.01 end;
    v_units := (v_panel.price / v_unit)::bigint;

    select coalesce(sum(t.price), 0), count(*) into v_total, v_count
    from public.lab_panel_tests pt
    join public.lab_tests t on t.id = pt.test_id
    where pt.panel_id = v_panel.id;
    if v_count = 0 then
      raise exception 'lab_order_empty_panel: panel % has no tests', v_panel.code;
    end if;

    v_assigned := 0;
    for r in
      select pt.test_id,
             t.price,
             case when v_total = 0 then floor(v_units::numeric / v_count)
                  else floor(v_units * t.price / v_total) end::bigint as share,
             row_number() over (order by t.price desc, pt.sort_order, pt.test_id) as rank
      from public.lab_panel_tests pt
      join public.lab_tests t on t.id = pt.test_id
      where pt.panel_id = v_panel.id
      order by rank desc
    loop
      -- Every test but the first-ranked takes its floor share; the first
      -- (largest list price) takes what remains, so the sum is exact.
      v_share := case when r.rank = 1 then v_units - v_assigned else r.share end;
      v_assigned := v_assigned + v_share;
      begin
        insert into public.lab_order_items (clinic_id, order_id, patient_id, test_id, panel_id, test_code_snapshot, test_name_snapshot, list_price_snapshot, price_snapshot)
        values (p_clinic_id, v_order, p_patient_id, r.test_id, v_panel.id, '', '', 0, v_share * v_unit);
      exception when unique_violation then
        raise exception 'lab_order_duplicate_test: a test is ordered twice (on its own and in a panel, or in two panels)';
      end;
    end loop;
  end loop;

  -- The bill: one manual payment for the order, the sum of the stored item
  -- prices (Phase 6). The amount guard on payments re-checks it.
  if p_source <> 'external_import' then
    insert into public.payments (clinic_id, patient_id, lab_order_id, amount, status, provider)
    select p_clinic_id, p_patient_id, v_order, coalesce(sum(i.price_snapshot), 0), 'unpaid', 'manual'
    from public.lab_order_items i
    where i.order_id = v_order;
  end if;

  -- O6: unless the clinic requires payment first, the items are ready for
  -- collection right away. Imports keep their own lifecycle.
  if p_source <> 'external_import' then
    select s.value ->> 'paymentPolicy' into v_policy
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab';
    if v_policy is distinct from 'before_collection' then
      update public.lab_order_items
      set status = 'ready_for_collection', status_changed_by = p_ordered_by
      where order_id = v_order;
    end if;
  end if;

  return query select v_order, false;
end;
$$;

revoke all on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid)
  to service_role;
