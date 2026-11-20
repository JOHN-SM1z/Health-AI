create or replace function public.claim_webhook_update(p_source text, p_external_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'server role required' using errcode='42501'; end if;
  insert into public.processed_webhooks (source, external_id, status)
  values (p_source, p_external_id, 'processing')
  on conflict (source, external_id) do update
    set status = 'processing', processed_at = now()
  where
    public.processed_webhooks.status = 'processing'
    and public.processed_webhooks.processed_at < now() - interval '5 minutes';
  return found;
end;
$$;


create or replace function public.finish_webhook_update(p_source text,p_external_id text) returns void language plpgsql security definer set search_path=public as $$ begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'server role required' using errcode='42501'; end if;
 update public.processed_webhooks set status='processed',processed_at=now() where source=p_source and external_id=p_external_id and status='processing';
end $$;

create or replace function public.release_webhook_update(p_source text,p_external_id text) returns void language plpgsql security definer set search_path=public as $$ begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'server role required' using errcode='42501'; end if;
 delete from public.processed_webhooks where source=p_source and external_id=p_external_id and status='processing';
end $$;

revoke all on function public.claim_webhook_update(text,text) from public,anon,authenticated;
grant execute on function public.claim_webhook_update(text,text) to service_role;

revoke all on function public.finish_webhook_update(text,text) from public,anon,authenticated;
grant execute on function public.finish_webhook_update(text,text) to service_role;

revoke all on function public.release_webhook_update(text,text) from public,anon,authenticated;
grant execute on function public.release_webhook_update(text,text) to service_role;
