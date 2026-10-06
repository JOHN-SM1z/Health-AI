-- Laboratory (Phase 16): lab lifecycle notifications on the existing
-- notification architecture (notification_jobs).
--
-- Two channels, one table:
--   * telegram — the patient's messages, claimed and sent by the existing
--     worker (claim_due_notification_jobs, SKIP LOCKED, retries, idempotency
--     key). LAB_RESULT_READY / CORRECTED (Phase 12) and, when the clinic
--     enables it, LAB_ORDER_CANCELLED.
--   * in_app — staff notifications (staff have no Telegram identity, and the
--     global admin chat is not per clinic). A row per recipient, delivered
--     on insert (status sent), read in the staff inbox; never claimed by
--     the Telegram worker.
--
-- Rows carry ids and an event type only — never names, test names, values
-- or clinical text. The inbox builds the wording when it is read, after
-- re-checking that the reader may still see the patient (doctors:
-- doctor_patient_access).
--
-- Who is notified (never the person who caused the event; imports never
-- notify anyone):
--   LAB_ORDER_CREATED     lab staff
--   LAB_SAMPLE_COLLECTED  lab staff
--   LAB_RESULT_ENTERED    the verifiers (clinic setting `verifiers`): lab
--                         staff and/or the ordering doctor
--   LAB_RESULT_VERIFIED   the ordering doctor
--   LAB_RESULT_CORRECTED  the ordering doctor
--   LAB_ORDER_CANCELLED   lab staff, managers (owner/manager/admin), the
--                         ordering doctor; the patient only if the clinic
--                         enables it (notifyPatientOnCancel, default off)
--   LAB_RESULT_READY      the patient (Phase 12; released results only)
-- Clinic configuration: app_settings lab.notifyStaff (default true) turns
-- all staff notifications off.
--
-- Idempotency: one job per (event, entity, recipient) — the unique
-- idempotency key — so a repeated event never notifies twice.

alter table public.notification_jobs
  add column recipient_profile_id uuid references public.profiles(id) on delete cascade,
  add column lab_order_id uuid,
  add column read_at timestamptz;

alter table public.notification_jobs
  drop constraint notification_jobs_lab_result_check,
  add constraint notification_jobs_lab_order_fkey
    foreign key (lab_order_id, clinic_id) references public.lab_orders (id, clinic_id) on delete cascade,
  add constraint notification_jobs_lab_refs_check
    check ((type in ('lab_result_ready', 'lab_result_entered', 'lab_result_verified', 'lab_result_corrected')) = (lab_result_id is not null)
           and (type not in ('lab_order_created', 'lab_sample_collected', 'lab_order_cancelled') or lab_order_id is not null)),
  add constraint notification_jobs_in_app_check
    check ((channel = 'in_app') = (recipient_profile_id is not null)
           and (channel <> 'in_app' or recipient_type = 'staff')
           and (read_at is null or channel = 'in_app'));

create index notification_jobs_inbox_idx
  on public.notification_jobs (recipient_profile_id, created_at desc) where channel = 'in_app';

-- The Telegram worker never claims in-app rows. An optional clinic filter
-- lets a run work on given clinics only (the scheduler passes none: all).
drop function public.claim_due_notification_jobs(int);

create or replace function public.claim_due_notification_jobs(p_limit int, p_clinic_ids uuid[] default null)
returns setof public.notification_jobs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_limit < 1 or p_limit > 200 then
    raise exception 'invalid claim limit';
  end if;

  return query
  update public.notification_jobs nj
    set status = 'in_progress'::public.notification_job_status,
        updated_at = now()
  where nj.id in (
    select id
    from public.notification_jobs
    where status = 'pending'::public.notification_job_status
      and channel = 'telegram'
      and scheduled_for <= now()
      and (p_clinic_ids is null or clinic_id = any (p_clinic_ids))
    order by scheduled_for asc
    limit p_limit
    for update skip locked
  )
  returning nj.*;
end;
$$;

revoke all on function public.claim_due_notification_jobs(int, uuid[]) from public, anon, authenticated;
grant execute on function public.claim_due_notification_jobs(int, uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Settings and recipients
-- ---------------------------------------------------------------------------

-- A boolean lab setting; only an explicit JSON boolean counts, anything else is the default.
create or replace function public.lab_setting_bool(p_clinic_id uuid, p_key text, p_default boolean)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case jsonb_typeof(s.value -> p_key) when 'boolean' then (s.value ->> p_key)::boolean end
    from public.app_settings s
    where s.clinic_id = p_clinic_id and s.key = 'lab'
  ), p_default);
$$;

revoke all on function public.lab_setting_bool(uuid, text, boolean) from public, anon, authenticated;

create or replace function public.lab_staff_with_roles(p_clinic_id uuid, p_roles public.staff_role[])
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct sr.profile_id), '{}')
  from public.staff_roles sr
  where sr.clinic_id = p_clinic_id and sr.role = any (p_roles);
$$;

revoke all on function public.lab_staff_with_roles(uuid, public.staff_role[]) from public, anon, authenticated;

-- The ordering doctor's account, while they are an active doctor of the clinic.
create or replace function public.lab_ordering_doctor_profile(p_order_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(d.profile_id), '{}')
  from public.lab_orders o
  join public.doctors d on d.id = o.ordering_doctor_id and d.clinic_id = o.clinic_id and d.active and d.profile_id is not null
  where o.id = p_order_id
    and exists (select 1 from public.staff_roles sr where sr.clinic_id = o.clinic_id and sr.profile_id = d.profile_id and sr.role = 'doctor');
$$;

revoke all on function public.lab_ordering_doctor_profile(uuid) from public, anon, authenticated;

-- One in-app notification per recipient (never the actor), idempotent per event.
create or replace function public.lab_notify_staff(
  p_clinic_id uuid,
  p_type public.notification_job_type,
  p_event_key text,
  p_recipients uuid[],
  p_actor uuid,
  p_lab_order_id uuid,
  p_lab_result_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.lab_clinic_is_being_erased(p_clinic_id) or not public.lab_setting_bool(p_clinic_id, 'notifyStaff', true) then
    return;
  end if;
  insert into public.notification_jobs
    (clinic_id, type, channel, recipient_type, recipient_profile_id, lab_order_id, lab_result_id,
     scheduled_for, status, sent_at, idempotency_key, max_attempts)
  select p_clinic_id, p_type, 'in_app', 'staff', r, p_lab_order_id, p_lab_result_id,
         now(), 'sent', now(), p_type::text || ':' || p_event_key || ':' || r::text, 1
  from (select distinct unnest(p_recipients) as r) recipients
  where r is not null and r is distinct from p_actor
    and exists (select 1 from public.staff_roles sr where sr.clinic_id = p_clinic_id and sr.profile_id = r)
  on conflict (idempotency_key) do nothing;
end;
$$;

revoke all on function public.lab_notify_staff(uuid, public.notification_job_type, text, uuid[], uuid, uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'external_import' then
    return null; -- historical data: not news
  end if;
  if tg_op = 'INSERT' then
    perform public.lab_notify_staff(new.clinic_id, 'lab_order_created', new.id::text,
      public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]), new.ordered_by, new.id, null);
    return null;
  end if;

  -- Cancelled.
  perform public.lab_notify_staff(new.clinic_id, 'lab_order_cancelled', new.id::text,
    public.lab_staff_with_roles(new.clinic_id, array['lab', 'owner', 'manager', 'admin']::public.staff_role[])
      || public.lab_ordering_doctor_profile(new.id),
    new.cancelled_by, new.id, null);

  if public.lab_setting_bool(new.clinic_id, 'notifyPatientOnCancel', false) then
    select p.telegram_user_id into v_telegram
    from public.patients p
    where p.id = public.patient_canonical_id(new.patient_id) and p.clinic_id = new.clinic_id;
    if v_telegram is not null then
      insert into public.notification_jobs (clinic_id, type, lab_order_id, patient_telegram_user_id, scheduled_for, idempotency_key)
      values (new.clinic_id, 'lab_order_cancelled', new.id, v_telegram, now(), 'lab_order_cancelled:' || new.id::text)
      on conflict (idempotency_key) do nothing;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function public.lab_orders_notify() from public, anon, authenticated;

create trigger lab_orders_notify_created
  after insert on public.lab_orders
  for each row execute function public.lab_orders_notify();
create trigger lab_orders_notify_cancelled
  after update of status on public.lab_orders
  for each row when (new.status = 'cancelled' and old.status is distinct from new.status)
  execute function public.lab_orders_notify();

create or replace function public.lab_samples_notify()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.lab_notify_staff(new.clinic_id, 'lab_sample_collected', new.id::text,
    public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]), new.collected_by, new.order_id, null);
  return null;
end;
$$;

revoke all on function public.lab_samples_notify() from public, anon, authenticated;

create trigger lab_samples_notify
  after insert on public.lab_samples
  for each row execute function public.lab_samples_notify();

create or replace function public.lab_results_notify_staff()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order uuid;
  v_verifiers text;
  v_recipients uuid[] := '{}';
begin
  if new.source = 'import' then
    return null;
  end if;
  select i.order_id into v_order from public.lab_order_items i where i.id = new.order_item_id;

  if new.status = 'submitted' then
    -- Whoever may verify it (clinic setting), never its author or submitter.
    select coalesce(s.value ->> 'verifiers', 'lab_and_doctor') into v_verifiers
    from public.app_settings s where s.clinic_id = new.clinic_id and s.key = 'lab';
    v_verifiers := coalesce(v_verifiers, 'lab_and_doctor');
    if v_verifiers <> 'doctor_only' then
      v_recipients := v_recipients || public.lab_staff_with_roles(new.clinic_id, array['lab']::public.staff_role[]);
    end if;
    if v_verifiers <> 'lab_only' then
      v_recipients := v_recipients || public.lab_ordering_doctor_profile(v_order);
    end if;
    v_recipients := array_remove(v_recipients, new.entered_by);
    perform public.lab_notify_staff(new.clinic_id, 'lab_result_entered', new.id::text, v_recipients, new.submitted_by, v_order, new.id);
  elsif new.status = 'verified' then
    perform public.lab_notify_staff(new.clinic_id,
      case when new.supersedes_result_id is null then 'lab_result_verified'::public.notification_job_type else 'lab_result_corrected'::public.notification_job_type end,
      new.id::text, public.lab_ordering_doctor_profile(v_order), new.verified_by, v_order, new.id);
  end if;
  return null;
end;
$$;

revoke all on function public.lab_results_notify_staff() from public, anon, authenticated;

create trigger lab_results_notify_staff
  after update of status on public.lab_results
  for each row
  when (new.status in ('submitted', 'verified') and old.status is distinct from new.status)
  execute function public.lab_results_notify_staff();
