-- Laboratory module, phase 5b: sample collection, with the clinic's payment policy applied where it matters.
--
-- Order, payment and sample are three separate states (lab_orders.status, payments.status,
-- lab_samples.status). "Ready for collection" is not stored anywhere: it is what the worklist derives from
-- the three, so none of them can drift into being a copy of another.
--
-- The lifecycle itself is already enforced by the phase-2 triggers (awaiting_collection → collected →
-- processing; rejected; cancelled; no sample for a cancelled/completed order; created_by/collected_by must
-- be lab staff; one live sample per order and sample type). These functions add what a trigger cannot:
--
--   * lab_collection_requires_payment(clinic) — the clinic's policy (app_settings key `lab`,
--     collection.requiresPayment). Not hard-coded: absent or not an explicit JSON `true` means "not required".
--   * lab_create_samples() — one awaiting-collection sample per sample type for the order's active tests that
--     are not on a live sample yet; idempotent (a repeat creates nothing), race-safe through the order lock.
--   * lab_sample_transition() — every later step in ONE transaction that locks the sample row, so two staff
--     members collecting the same sample, or one repeating the request, resolve to one collection; and the
--     payment gate: when the policy requires payment, collection needs the order's payment to be `paid`
--     RIGHT NOW — the payment row is locked FOR SHARE so a refund cannot slip in between the check and the
--     collection (the engine's compare-and-set update waits for this transaction).
--
-- Callable by the server only; the server has authorised the caller as lab staff of the clinic, and the
-- phase-2 triggers re-check it. Reversible: drop the three functions.

create or replace function public.lab_collection_requires_payment(p_clinic uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when jsonb_typeof(s.value #> '{collection,requiresPayment}') = 'boolean'
                 then (s.value #>> '{collection,requiresPayment}')::boolean end
       from public.app_settings s where s.clinic_id = p_clinic and s.key = 'lab'),
    false);
$$;

revoke all on function public.lab_collection_requires_payment(uuid) from public, anon, authenticated;
grant execute on function public.lab_collection_requires_payment(uuid) to service_role;

create or replace function public.lab_create_samples(p_clinic uuid, p_actor uuid, p_order uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order record;
  v_type text;
  v_sample uuid;
  v_code text;
  v_tries int;
  v_created int := 0;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab sample: only lab staff of the clinic create samples';
  end if;

  -- The order lock serialises sample creation for one order: two requests cannot both decide "no sample yet".
  select o.id, o.patient_id, o.status into v_order
    from public.lab_orders o where o.id = p_order and o.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab sample: order not found';
  end if;

  for v_type in
    select distinct coalesce(nullif(btrim(i.sample_type), ''), 'boshqa')
      from public.lab_order_items i
     where i.order_id = p_order and i.clinic_id = p_clinic and i.status = 'active'
       and not exists (
         select 1 from public.lab_sample_items si
           join public.lab_samples s on s.id = si.sample_id
          where si.order_item_id = i.id and s.status in ('awaiting_collection', 'collected', 'processing')
       )
       and not exists (
         select 1 from public.lab_samples s
          where s.order_id = p_order and s.status in ('awaiting_collection', 'collected', 'processing')
            and s.sample_type = coalesce(nullif(btrim(i.sample_type), ''), 'boshqa')
       )
  loop
    v_tries := 0;
    loop
      -- A short code the technician can read off a tube: unambiguous characters, unique per clinic.
      v_code := 'S' || to_char(now(), 'YYMMDD') || '-' ||
        (select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '') from generate_series(1, 5));
      begin
        insert into public.lab_samples (clinic_id, order_id, patient_id, sample_type, sample_code, created_by)
        values (p_clinic, p_order, v_order.patient_id, v_type, v_code, p_actor)
        returning id into v_sample;
        exit;
      exception when unique_violation then
        v_tries := v_tries + 1;
        if v_tries >= 8 then raise; end if;
      end;
    end loop;

    insert into public.lab_sample_items (sample_id, order_item_id, clinic_id, order_id)
    select v_sample, i.id, p_clinic, p_order
      from public.lab_order_items i
     where i.order_id = p_order and i.clinic_id = p_clinic and i.status = 'active'
       and coalesce(nullif(btrim(i.sample_type), ''), 'boshqa') = v_type
       and not exists (
         select 1 from public.lab_sample_items si
           join public.lab_samples s on s.id = si.sample_id
          where si.order_item_id = i.id and s.status in ('awaiting_collection', 'collected', 'processing')
       );
    v_created := v_created + 1;
  end loop;

  return jsonb_build_object('order_id', p_order, 'created', v_created);
end;
$$;

revoke all on function public.lab_create_samples(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_create_samples(uuid, uuid, uuid) to service_role;

create or replace function public.lab_sample_transition(
  p_clinic uuid,
  p_actor uuid,
  p_sample uuid,
  p_to public.lab_sample_status,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sample record;
  v_payment public.payment_status;
begin
  if not public.lab_is_lab_staff(p_actor, p_clinic) then
    raise exception 'lab sample: only lab staff of the clinic move samples';
  end if;

  select s.id, s.order_id, s.status, s.collected_by into v_sample
    from public.lab_samples s where s.id = p_sample and s.clinic_id = p_clinic for update;
  if not found then
    raise exception 'lab sample: sample not found';
  end if;

  -- The same step asked twice is one step. Collected by someone else is not "the same step": it is a conflict.
  if v_sample.status = p_to then
    if p_to = 'collected' and v_sample.collected_by is distinct from p_actor then
      raise exception 'lab sample: already collected by another member of staff';
    end if;
    return jsonb_build_object('sample_id', p_sample, 'status', v_sample.status, 'unchanged', true);
  end if;

  if p_to = 'collected' and public.lab_collection_requires_payment(p_clinic) then
    -- Locked FOR SHARE until this transaction ends: a refund (an UPDATE of the row) waits for the collection.
    select p.status into v_payment
      from public.payments p where p.lab_order_id = v_sample.order_id and p.clinic_id = p_clinic for share;
    if not found or v_payment <> 'paid' then
      raise exception 'lab sample: payment required before collection';
    end if;
  end if;

  update public.lab_samples
     set status = p_to,
         collected_by = case when p_to = 'collected' then p_actor else collected_by end,
         rejected_reason = case when p_to = 'rejected' then nullif(btrim(p_reason), '') else null end
   where id = p_sample and clinic_id = p_clinic;

  return jsonb_build_object('sample_id', p_sample, 'status', p_to, 'unchanged', false);
end;
$$;

revoke all on function public.lab_sample_transition(uuid, uuid, uuid, public.lab_sample_status, text) from public, anon, authenticated;
grant execute on function public.lab_sample_transition(uuid, uuid, uuid, public.lab_sample_status, text) to service_role;
