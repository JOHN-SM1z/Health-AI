create or replace function public.claim_due_notification_jobs(p_limit int)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'server role required' using errcode='42501'; end if;
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;

  -- A crashed sender may already have delivered the message. Quarantine
  -- ambiguous stale claims for review; never automatically send them twice.
  update public.notification_jobs set status='failed',error='delivery outcome unknown after worker timeout; review before retry'
  where status='in_progress' and updated_at<now()-interval '1 hour';
  return query
  update public.notification_jobs nj
    set status = 'in_progress'::public.notification_job_status,
        updated_at = now()
  where nj.id in (
    select id
    from public.notification_jobs
    where status = 'pending'::public.notification_job_status
      and scheduled_for <= now()
    order by scheduled_for asc
    limit p_limit
    for update skip locked
  )
  returning nj.*;
end;
$$;


revoke all on function public.claim_due_notification_jobs(integer) from public,anon,authenticated;
grant execute on function public.claim_due_notification_jobs(integer) to service_role;
