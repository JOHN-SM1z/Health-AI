set local lock_timeout = '5s';
-- RLS does not protect TRUNCATE. Browser roles never administer schema objects.
do $$ declare t record; begin
  for t in select c.oid::regclass as name from pg_class c
    where c.relnamespace='public'::regnamespace and c.relkind in('r','p')
  loop
    execute format('revoke truncate,references,trigger on table %s from public,anon,authenticated',t.name);
    if current_setting('server_version_num')::integer>=170000 then
      execute format('revoke maintain on table %s from public,anon,authenticated',t.name);
    end if;
  end loop;
  alter default privileges in schema public revoke truncate,references,trigger on tables from public,anon,authenticated;
  if current_setting('server_version_num')::integer>=170000 then
    execute 'alter default privileges in schema public revoke maintain on tables from public,anon,authenticated';
  end if;
end $$;

-- The doctor_services child trigger checks inserts/updates, but cannot protect
-- against moving its parent catalogue records into a different tenant later.
create function public.catalog_clinic_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin
  if new.clinic_id is distinct from old.clinic_id then
    raise exception 'catalog clinic identity is immutable' using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.catalog_clinic_immutable() from public,anon,authenticated;
create trigger catalog_clinic_immutable before update of clinic_id on public.doctors
for each row execute function public.catalog_clinic_immutable();
create trigger catalog_clinic_immutable before update of clinic_id on public.services
for each row execute function public.catalog_clinic_immutable();
