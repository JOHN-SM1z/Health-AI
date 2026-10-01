-- Laboratory module, phase 4: a doctor's order is written atomically and idempotently.
--
-- The order and its items must exist together or not at all, and a repeated submission (double click,
-- network retry, two tabs) must resolve to the first order. PostgREST cannot span statements in one
-- transaction, so this function does both. It adds NO authorization of its own beyond what the tables
-- enforce — the order trigger requires the ordering doctor's own login and consultation, the item trigger
-- snapshots the catalog and refuses inactive tests — and is callable by the server only, which has already
-- authorized the doctor against the patient (doctor_patient_access) before calling.
--
-- Returns { order_id, replayed, patient_id, appointment_id }: on a replay the server compares patient and
-- consultation with the request before answering (a reused key for different content is a conflict).
--
-- Reversible: drop function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb).

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

  return jsonb_build_object('order_id', v_order, 'replayed', false, 'patient_id', p_patient_id, 'appointment_id', p_appointment_id);
end;
$$;

revoke all on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.lab_create_order(uuid, uuid, uuid, uuid, uuid, uuid, public.lab_priority, text, uuid, jsonb) to service_role;
