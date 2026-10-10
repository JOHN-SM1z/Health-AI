-- Laboratory (Phase 17): role-specific dashboards.
--
-- The dashboards read the existing tables through the server (service role,
-- after the route's role check); nothing new is exposed to signed-in roles.
-- This migration adds:
--   * lab_doctor_accessible_patients(): which patients of a candidate set a
--     doctor may see — exactly doctor_patient_access() (own patient or an
--     active, unexpired referral), evaluated in the database for the whole
--     set, so the doctor's dashboard never widens a doctor's scope and never
--     relies on a list computed elsewhere;
--   * indexes for the dashboard reads (orders by date and by ordering doctor,
--     current verified results by time).

create or replace function public.lab_doctor_accessible_patients(p_clinic_id uuid, p_doctor_id uuid, p_patient_ids uuid[])
returns setof uuid
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if cardinality(p_patient_ids) > 5000 then
    raise exception 'too many patients';
  end if;
  -- The doctor must be an active doctor of this clinic.
  if not exists (select 1 from public.doctors d where d.id = p_doctor_id and d.clinic_id = p_clinic_id and d.active) then
    return;
  end if;
  return query
  select p.id
  from (select distinct unnest(p_patient_ids) as id) p
  where p.id is not null
    and exists (
      select 1
      from public.doctor_patient_access(p_doctor_id, p.id) x
      where x.clinic_id = p_clinic_id
        and (x.own_patient or cardinality(x.active_referral_ids) > 0)
    );
end;
$$;

revoke all on function public.lab_doctor_accessible_patients(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.lab_doctor_accessible_patients(uuid, uuid, uuid[]) to service_role;

create index if not exists lab_orders_created_idx
  on public.lab_orders (clinic_id, created_at);
create index if not exists lab_orders_ordering_doctor_idx
  on public.lab_orders (clinic_id, ordering_doctor_id, created_at desc) where ordering_doctor_id is not null;
create index if not exists lab_results_verified_idx
  on public.lab_results (clinic_id, verified_at desc) where status = 'verified';
