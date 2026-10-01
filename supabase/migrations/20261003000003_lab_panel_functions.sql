-- Laboratory configuration, phase 3: a panel and its tests are written atomically.
--
-- PostgREST cannot span two statements in one transaction; creating a panel and then replacing its tests as
-- two calls could leave a panel without tests if the second failed. These two functions do each in ONE
-- transaction, verify that the panel and every test belong to the clinic, and are callable by the server only.
-- The table triggers and audit run exactly as for direct writes.
--
-- Reversible: drop function public.lab_create_panel(...), public.lab_set_panel_tests(uuid, uuid, uuid[]).

create or replace function public.lab_set_panel_tests(p_clinic_id uuid, p_panel_id uuid, p_test_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_test_ids is null or cardinality(p_test_ids) = 0 then
    raise exception 'lab catalog: a panel needs at least one test';
  end if;
  if not exists (select 1 from public.lab_panels where id = p_panel_id and clinic_id = p_clinic_id) then
    raise exception 'lab catalog: the panel is not in this clinic';
  end if;
  if (select count(*) from public.lab_tests where clinic_id = p_clinic_id and id = any (p_test_ids)) <> cardinality(p_test_ids) then
    raise exception 'lab catalog: a test is not in this clinic';
  end if;
  delete from public.lab_panel_tests where panel_id = p_panel_id and clinic_id = p_clinic_id;
  insert into public.lab_panel_tests (panel_id, test_id, clinic_id, sort_order)
  select p_panel_id, t.id, p_clinic_id, (t.ord - 1)::int
    from unnest(p_test_ids) with ordinality as t(id, ord);
end;
$$;

create or replace function public.lab_create_panel(
  p_clinic_id uuid,
  p_actor uuid,
  p_code text,
  p_name text,
  p_description text,
  p_price numeric,
  p_active boolean,
  p_test_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.lab_panels (clinic_id, code, name, description, price, active, updated_by)
  values (p_clinic_id, p_code, p_name, p_description, p_price, coalesce(p_active, true), p_actor)
  returning id into v_id;
  perform public.lab_set_panel_tests(p_clinic_id, v_id, p_test_ids);
  return v_id;
end;
$$;

revoke all on function public.lab_set_panel_tests(uuid, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.lab_create_panel(uuid, uuid, text, text, text, numeric, boolean, uuid[]) from public, anon, authenticated;
grant execute on function public.lab_set_panel_tests(uuid, uuid, uuid[]) to service_role;
grant execute on function public.lab_create_panel(uuid, uuid, text, text, text, numeric, boolean, uuid[]) to service_role;
