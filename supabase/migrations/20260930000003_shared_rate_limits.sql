-- A rate limit every server instance shares.
--
-- src/lib/rate-limit.ts counts requests in the memory of one server
-- instance, so with N Cloud Run instances a caller gets up to N times the
-- limit. That is acceptable for the public, IP-keyed limits (a load-balancer
-- policy covers those), but not for the limit that guards clinical data: the
-- per-doctor patient-record lookup limit, which slows down id guessing and
-- bulk reading of patients' records. consume_rate_limit() keeps that count in
-- Postgres, so it holds across instances.
--
-- One row per key (a doctor's account and what is limited), updated in place
-- with an atomic upsert: fixed windows, the count capped at limit + 1. Keys
-- are per staff account, so the table stays as small as the staff list.
--
-- Server-only: RLS on with no policies, no grants for anon/authenticated,
-- EXECUTE for service_role alone.
--
-- Rollback: drop function public.consume_rate_limit(text, integer, integer);
-- drop table public.rate_limit_buckets;

create table public.rate_limit_buckets (
  key text primary key check (length(key) between 1 and 200),
  window_started_at timestamptz not null,
  hits integer not null check (hits >= 0)
);

alter table public.rate_limit_buckets enable row level security;
revoke all on public.rate_limit_buckets from public, anon, authenticated;
grant select, insert, update, delete on public.rate_limit_buckets to service_role;

comment on table public.rate_limit_buckets is
  'Server-only request counters shared by every app instance (consume_rate_limit). No personal data: keys are an account id and a purpose.';

create or replace function public.consume_rate_limit(p_key text, p_limit integer, p_window_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_window interval;
  v_bucket public.rate_limit_buckets%rowtype;
begin
  if p_key is null or p_limit is null or p_limit < 1 or p_window_seconds is null or p_window_seconds < 1 then
    raise exception 'rate limit: invalid key, limit or window';
  end if;
  v_window := make_interval(secs => p_window_seconds);

  insert into public.rate_limit_buckets as b (key, window_started_at, hits)
  values (p_key, clock_timestamp(), 1)
  on conflict (key) do update
    set window_started_at = case when b.window_started_at + v_window <= clock_timestamp() then clock_timestamp() else b.window_started_at end,
        hits = case when b.window_started_at + v_window <= clock_timestamp() then 1 else least(b.hits + 1, p_limit + 1) end
  returning * into v_bucket;

  return jsonb_build_object(
    'allowed', v_bucket.hits <= p_limit,
    'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_bucket.window_started_at + v_window - clock_timestamp())))::integer)
  );
end;
$$;

revoke execute on function public.consume_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text, integer, integer) to service_role;

comment on function public.consume_rate_limit(text, integer, integer) is
  'Server-only. Counts one request against p_key (fixed window of p_window_seconds) and says whether it is within p_limit — shared by every app instance.';
