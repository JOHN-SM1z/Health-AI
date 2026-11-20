-- Telegram queue follow-up for walk-ins (owner decisions 2026-10-08).
--
-- The walk-in patient is registered at reception by passport/JSHSHIR and date
-- of birth, pays at the kassa, and then follows the queue in the clinic's
-- Telegram bot. A reception-made card has no Telegram account, and linking one
-- permanently would hand that card's history (lab results included) to
-- whoever scans a code. So the owner chose the least-privilege form:
--
--   * After payment the kassa (or reception) shows a QR code: a one-time link
--     t.me/<clinic bot>?start=v_<token>. Only the token's SHA-256 is stored.
--   * Scanning it makes that Telegram user a FOLLOWER of that one visit: the
--     current ticket (number, doctor or laboratory, how many are ahead) and a
--     "you are called" message. No identity link, no access to records or
--     results, no patient row created, nothing merged or moved.
--   * A token is claimed once, by one Telegram user (the same user may repeat
--     it); it expires after 24 hours, is refused for a finished visit, and a
--     new link for the visit replaces an unused one.
--   * transition_visit → called enqueues 'queue_called' for the patient's own
--     linked Telegram and every follower, in the same transaction.
--
-- Tables are server-only (RLS on, no policies, no grants to signed-in roles);
-- every function re-checks the caller as before.

create table public.visit_follow_tokens (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by_telegram_user_id bigint,
  constraint visit_follow_tokens_visit_fkey foreign key (visit_id, clinic_id) references public.visits (id, clinic_id) on delete restrict,
  constraint visit_follow_tokens_claim_check check ((claimed_at is null) = (claimed_by_telegram_user_id is null)),
  constraint visit_follow_tokens_id_clinic_id_key unique (id, clinic_id)
);
create index visit_follow_tokens_visit_idx on public.visit_follow_tokens (visit_id);
alter table public.visit_follow_tokens enable row level security;
revoke all on public.visit_follow_tokens from anon, authenticated;

create table public.visit_followers (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete restrict,
  visit_id uuid not null,
  telegram_user_id bigint not null check (telegram_user_id > 0),
  token_id uuid not null,
  created_at timestamptz not null default now(),
  constraint visit_followers_visit_fkey foreign key (visit_id, clinic_id) references public.visits (id, clinic_id) on delete restrict,
  constraint visit_followers_token_fkey foreign key (token_id, clinic_id) references public.visit_follow_tokens (id, clinic_id) on delete restrict,
  constraint visit_followers_one_per_user unique (visit_id, telegram_user_id)
);
create index visit_followers_user_idx on public.visit_followers (clinic_id, telegram_user_id);
alter table public.visit_followers enable row level security;
revoke all on public.visit_followers from anon, authenticated;

comment on table public.visit_followers is 'Telegram users following ONE walk-in visit''s queue (number, position, called). Grants no access to the patient''s card, records or results.';

-- Queue notifications carry the visit.
alter table public.notification_jobs drop constraint notification_jobs_visit_check;
alter table public.notification_jobs
  add constraint notification_jobs_visit_check
    check ((type in ('queue_ticket', 'queue_called')) = (visit_id is not null));

-- ---------------------------------------------------------------------------
-- "You are called"
-- ---------------------------------------------------------------------------

-- One job per recipient for this call (a later re-call is a new call). The
-- caller holds the visit row lock.
create or replace function public.visit_notify_called(p_visit uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
begin
  select * into v from public.visits where id = p_visit;
  insert into public.notification_jobs (clinic_id, visit_id, type, patient_telegram_user_id, scheduled_for, idempotency_key)
  select v.clinic_id, v.id, 'queue_called', r.tg, now(),
         'queue_called:' || v.id::text || ':' || r.tg::text || ':' || to_char(v.called_at at time zone 'UTC', 'YYYYMMDDHH24MISSUS')
    from (
      select p.telegram_user_id as tg from public.patients p where p.id = v.patient_id and p.telegram_user_id is not null
      union
      select f.telegram_user_id from public.visit_followers f where f.visit_id = v.id
    ) r
  on conflict (idempotency_key) do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- Follow links
-- ---------------------------------------------------------------------------

create or replace function public.create_visit_follow_token(p_clinic uuid, p_actor uuid, p_visit uuid, p_token_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  t public.visit_follow_tokens;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'cashier']::public.staff_role[]);
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using message = 'operations: invalid follow token', errcode = '22023', hint = 'invalid_request';
  end if;
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;
  if v.status in ('completed', 'cancelled') then
    raise exception using message = 'operations: the visit is finished', errcode = '22023', hint = 'visit_finished';
  end if;

  -- A new link replaces an unused one.
  update public.visit_follow_tokens set expires_at = now()
   where visit_id = v.id and claimed_at is null and expires_at > now();
  insert into public.visit_follow_tokens (clinic_id, visit_id, token_hash, created_by, expires_at)
  values (p_clinic, v.id, p_token_hash, p_actor, now() + interval '24 hours')
  returning * into t;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_follow_link_created', 'visits', v.id::text, jsonb_build_object('token_id', t.id));
  return jsonb_build_object('token_id', t.id, 'expires_at', t.expires_at);
end;
$$;

-- Called by the server for the clinic's own bot (the webhook resolved the
-- clinic). Never raises for a bad token: the answer is a status the bot turns
-- into one neutral message.
create or replace function public.claim_visit_follow_token(p_clinic uuid, p_token_hash text, p_telegram_user_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_visit uuid;
  v public.visits;
  t public.visit_follow_tokens;
  v_follower uuid;
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' or p_telegram_user_id is null or p_telegram_user_id <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select visit_id into v_visit from public.visit_follow_tokens where token_hash = p_token_hash and clinic_id = p_clinic;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;
  -- Same lock order as create_visit_follow_token and transition_visit (visit,
  -- then token): a call that races this claim waits and then sees the follower.
  select * into v from public.visits where id = v_visit and clinic_id = p_clinic for share;
  select * into t from public.visit_follow_tokens where token_hash = p_token_hash and clinic_id = p_clinic for update;

  if t.claimed_at is not null then
    if t.claimed_by_telegram_user_id = p_telegram_user_id then
      return jsonb_build_object('status', 'already', 'visit_id', v.id);
    end if;
    return jsonb_build_object('status', 'invalid');
  end if;
  if t.expires_at <= now() or v.status in ('completed', 'cancelled') then
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.visit_follow_tokens set claimed_at = now(), claimed_by_telegram_user_id = p_telegram_user_id where id = t.id;
  insert into public.visit_followers (clinic_id, visit_id, telegram_user_id, token_id)
  values (p_clinic, v.id, p_telegram_user_id, t.id)
  on conflict (visit_id, telegram_user_id) do nothing
  returning id into v_follower;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, null, 'telegram', 'visit_followed', 'visits', v.id::text, jsonb_build_object('token_id', t.id, 'follower_id', v_follower));
  return jsonb_build_object('status', 'subscribed', 'visit_id', v.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Redefined: calling a number notifies the patient and the visit's followers
-- ---------------------------------------------------------------------------

create or replace function public.transition_visit(
  p_clinic uuid,
  p_actor uuid,
  p_visit uuid,
  p_expected text,
  p_status text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  b record;
  v_desk boolean;
  v_own_doctor boolean;
  v_lab boolean;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist', 'doctor', 'lab']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;

  v_desk := public.ops_has_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  v_own_doctor := exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) and public.ops_has_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  -- Laboratory staff run the lab queue (lab visits only).
  v_lab := v.kind = 'lab' and public.ops_has_role(p_clinic, p_actor, array['lab']::public.staff_role[]);
  if not v_desk and not v_own_doctor and not v_lab then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;

  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;

  if p_status = 'called' and v.status = 'waiting' then
    update public.visits set status = 'called', called_at = now(), updated_at = now() where id = v.id returning * into v;
    -- "You are called": to the patient's own linked Telegram and to whoever
    -- follows this visit (20261008000003).
    perform public.visit_notify_called(v.id);
  elsif p_status = 'waiting' and v.status = 'called' then
    update public.visits set status = 'waiting', updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'in_progress' and v.status in ('waiting', 'called') and v_lab then
    -- Sample collection begins (the samples themselves go through the lab's own flow).
    update public.visits set status = 'in_progress', started_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_lab then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_status = 'completed' and v.status = 'in_progress' and v_own_doctor then
    update public.visits set status = 'completed', completed_at = now(), updated_at = now() where id = v.id returning * into v;
    -- The consultation ends now, not when its booked duration would: a
    -- completed appointment still occupies its slot (no_overlapping_active_
    -- appointments), and a walk-in queue must let the doctor start the next
    -- patient at once. Never shorter than one minute (end > start).
    update public.appointments
       set status = 'completed', end_at = greatest(now(), start_at + interval '1 minute')
     where id = v.appointment_id and status = 'in_progress';
  elsif p_status = 'cancelled' and v.status in ('awaiting_payment', 'waiting', 'called') and v_desk then
    if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
      raise exception using message = 'operations: a reason is required', errcode = '22023', hint = 'reason_required';
    end if;
    select * into b from public.visit_balance(v.id);
    if b.collected - b.refunded > 0 then
      raise exception using message = 'operations: refund the payment before cancelling', errcode = '22023', hint = 'refund_first';
    end if;
    -- A cancelled lab walk-in takes its tests out of the laboratory's work
    -- too; once a sample is taken the lab decides (reject or result) instead.
    if v.lab_order_id is not null and exists (
      select 1 from public.lab_order_items i
       where i.order_id = v.lab_order_id and i.status not in ('ordered', 'ready_for_collection', 'cancelled')
    ) then
      raise exception using message = 'operations: a sample was already taken', errcode = '22023', hint = 'lab_sample_taken';
    end if;
    update public.visit_charges set status = 'voided', voided_by = p_actor, voided_at = now(), void_reason = 'Tashrif bekor qilindi'
     where visit_id = v.id and status = 'active';
    update public.lab_orders set status = 'cancelled', cancelled_by = p_actor, cancel_reason = 'Tashrif bekor qilindi'
     where id = v.lab_order_id and clinic_id = p_clinic and status = 'active';
    update public.visits set status = 'cancelled', cancelled_at = now(), cancel_reason = btrim(p_reason), updated_at = now()
     where id = v.id returning * into v;
  else
    raise exception using message = 'operations: this change is not allowed', errcode = '22023', hint = 'invalid_transition';
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_status_changed', 'visits', v.id::text,
          jsonb_build_object('status', p_expected), jsonb_build_object('status', v.status));
  return jsonb_build_object('visit_id', v.id, 'status', v.status);
end;
$$;

revoke all on function public.visit_notify_called(uuid) from public, anon, authenticated;
revoke all on function public.create_visit_follow_token(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_visit_follow_token(uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.create_visit_follow_token(uuid, uuid, uuid, text) to service_role;
grant execute on function public.claim_visit_follow_token(uuid, text, bigint) to service_role;
