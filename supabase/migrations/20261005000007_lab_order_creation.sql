-- Laboratory (Phase 5): creating a lab order, atomically, in the database.
--
-- create_lab_order() is the only way the application creates an order with
-- its items. In one transaction it:
--   * replays an earlier order placed with the same creation key (same
--     orderer, same patient, same tests and panels) instead of creating a
--     second one; the same key with a different content is refused;
--   * inserts the order and one item per test — the item trigger takes code,
--     name and list price from the catalog and refuses inactive tests;
--   * splits each panel's price across its tests in proportion to their
--     standalone prices (owner decision O2). The split is in whole so'm when
--     the panel price is whole (else in 0.01), and the rounding remainder goes
--     to the test with the largest list price (ties: the panel's sort order),
--     so the items always add up to exactly the panel price. If every member
--     test is free, the panel price is split equally the same way. The
--     allocated amounts are stored on the items and never recalculated;
--   * makes the items ready for collection unless the clinic's lab payment
--     policy is "before_collection" (O6: payment is not required by default).
-- A test may appear once per order: selecting a test that a chosen panel
-- already contains is refused rather than silently charged twice.
--
-- SECURITY INVOKER: it runs as the calling server (service_role), so every
-- table trigger and constraint still applies; signed-in roles cannot call it.

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

comment on function public.create_lab_order(uuid, uuid, uuid, public.lab_order_source, uuid[], uuid[], uuid, uuid, uuid) is
  'Creates a lab order and its items atomically: idempotent on the creation key, proportional panel price allocation (O2), ready for collection unless payment is required first (O6). Server only.';
