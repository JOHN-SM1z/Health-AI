-- Forward-only hardening compatible with the production, staging and pilot schemas.
-- Retain each installation's claim filters and signature; do not replay baselines.
set local lock_timeout = '5s';
alter function public.set_updated_at() set search_path = pg_catalog;

-- Preserve existing claim logic (including staging clinic/channel filters and
-- pilot stale-claim handling). Add validation before any side effect.
do $migration$
declare f record; patched text; count_found integer := 0;
begin
  for f in
    select p.oid, p.prosrc, pg_get_functiondef(p.oid) as definition,
           p.oid::regprocedure as signature
    from pg_proc p join pg_language l on l.oid=p.prolang
    where p.pronamespace='public'::regnamespace
      and p.proname='claim_due_notification_jobs'
      and l.lanname='plpgsql'
  loop
    if f.prosrc !~* '(^|\n)[[:space:]]*begin[[:space:]]*(\n|$)' then
      raise exception 'Unexpected notification claim body; review before upgrading';
    end if;
    patched := regexp_replace(f.prosrc,
      '(^|\n)[[:space:]]*begin[[:space:]]*(\n|$)',
      E'\nbegin\n  if coalesce(auth.role(),'''') <> ''service_role'' then\n    raise exception ''server role required'' using errcode=''42501'';\n  end if;\n  if p_limit is null or p_limit < 1 or p_limit > 200 then\n    raise exception ''invalid claim limit'' using errcode=''22023'';\n  end if;\n', 'i');
    execute replace(f.definition, f.prosrc, patched);
    execute format('revoke all on function %s from public, anon, authenticated', f.signature);
    execute format('grant execute on function %s to service_role', f.signature);
    count_found := count_found + 1;
  end loop;
  if count_found <> 1 then raise exception 'Expected exactly one notification claim signature'; end if;
end;
$migration$;

create or replace function public.claim_webhook_update(p_source text,p_external_id text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'server role required' using errcode='42501';
  end if;
  insert into public.processed_webhooks(source,external_id,status)
  values(p_source,p_external_id,'processing')
  on conflict(source,external_id) do update set status='processing',processed_at=now()
  where public.processed_webhooks.status='processing'
    and public.processed_webhooks.processed_at<now()-interval '5 minutes';
  return found;
end;
$$;
create or replace function public.finish_webhook_update(p_source text,p_external_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'server role required' using errcode='42501';
  end if;
  update public.processed_webhooks set status='processed',processed_at=now()
  where source=p_source and external_id=p_external_id and status='processing';
end;
$$;
create or replace function public.release_webhook_update(p_source text,p_external_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'server role required' using errcode='42501';
  end if;
  delete from public.processed_webhooks
  where source=p_source and external_id=p_external_id and status='processing';
end;
$$;
revoke all on function public.claim_webhook_update(text,text),public.finish_webhook_update(text,text),public.release_webhook_update(text,text) from public,anon,authenticated;
grant execute on function public.claim_webhook_update(text,text),public.finish_webhook_update(text,text),public.release_webhook_update(text,text) to service_role;
