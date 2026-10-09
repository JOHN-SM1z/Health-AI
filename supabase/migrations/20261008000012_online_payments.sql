-- Pay online, get the queue number online (Slice C, owner decision 2026-10-08).
--
-- An online booking is an appointment with its own payment row (server-priced when it was booked). Online payment:
--   1. create_online_invoice(): one live invoice per payment, for exactly the amount the server priced.
--   2. The provider's webhook — signature verified by the server before anything here runs — calls
--      settle_online_payment(). Each provider event is claimed once (payment_provider_events); the amount and currency
--      must equal the invoice. In ONE transaction the payment becomes paid, the appointment confirmed, and a visit is
--      created for the slot's day with the next queue number of that day (status 'booked': paid, not yet arrived) and
--      the Telegram ticket queued. A second payment, or a payment for a slot that is gone, becomes a refund request.
--   3. At the clinic, reception marks the patient arrived (mark_booked_arrived): 'booked' → 'waiting'. The doctor's
--      queue orders booked patients by their slot time, walk-ins by when they paid (src/lib/operations/outpatient.ts).
--   4. Cancelling the appointment cancels its booked visit and requests a refund (appointments trigger).
--      mark_online_refund_done(): owner/manager confirm the money went back.
--
-- Online money is recorded in the visit ledger with method 'online' (never cash or terminal), so the kassa's cash and
-- terminal totals stay exactly what the cashier holds. No raw provider payload is stored anywhere.

-- ---------------------------------------------------------------------------
-- Visits, charges and the ledger accept online rows
-- ---------------------------------------------------------------------------

alter table public.visits
  add column source text not null default 'desk' constraint visits_source_check check (source in ('desk', 'online'));

alter table public.visits drop constraint visits_status_check;
alter table public.visits add constraint visits_status_check
  check (status in ('booked', 'awaiting_payment', 'waiting', 'called', 'in_progress', 'completed', 'cancelled'));

-- A visit created by an online payment has no staff author and has not arrived yet.
alter table public.visits alter column created_by drop not null;
alter table public.visits alter column arrived_at drop not null;
alter table public.visits add constraint visits_online_actor_check check (created_by is not null or source = 'online');
alter table public.visits add constraint visits_arrival_check
  check (arrived_at is not null or (source = 'online' and status in ('booked', 'cancelled')));
alter table public.visits add constraint visits_booked_check check (status <> 'booked' or (source = 'online' and appointment_id is not null));

comment on column public.visits.status is
  'booked = paid online, not yet arrived (has its queue number, not in today''s waiting list until reception marks arrival).';

alter table public.visit_charges alter column created_by drop not null;
comment on column public.visit_charges.created_by is 'Staff who added the line; null only for the line settle_online_payment() adds.';

alter table public.visit_transactions drop constraint visit_transactions_method_check;
alter table public.visit_transactions add constraint visit_transactions_method_check check (method in ('cash', 'terminal', 'online'));
alter table public.visit_transactions alter column executed_by drop not null;
alter table public.visit_transactions alter column authorized_by drop not null;
alter table public.visit_transactions add constraint visit_transactions_actor_check
  check (method = 'online' or (executed_by is not null and authorized_by is not null));

-- ---------------------------------------------------------------------------
-- Invoices, provider events, refunds
-- ---------------------------------------------------------------------------

create table public.payment_invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  appointment_id uuid not null,
  patient_id uuid not null,
  provider public.payment_provider not null constraint payment_invoices_provider_check check (provider in ('rahmat', 'test_online')),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null,
  status text not null default 'open' constraint payment_invoices_status_check check (status in ('open', 'paid', 'expired', 'cancelled')),
  provider_invoice_id text,
  pay_url text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create unique index payment_invoices_one_open on public.payment_invoices (payment_id) where status = 'open';
create index payment_invoices_appointment_idx on public.payment_invoices (clinic_id, appointment_id);

create table public.payment_provider_events (
  provider public.payment_provider not null,
  event_id text not null check (char_length(event_id) between 1 and 200),
  invoice_id uuid,
  amount numeric(12, 2),
  currency text,
  outcome text,
  received_at timestamptz not null default now(),
  primary key (provider, event_id)
);

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete restrict,
  invoice_id uuid references public.payment_invoices(id) on delete restrict,
  visit_id uuid,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null,
  reason text not null constraint payment_refunds_reason_check
    check (reason in ('duplicate_payment', 'slot_unavailable', 'booking_cancelled')),
  status text not null default 'requested' constraint payment_refunds_status_check check (status in ('requested', 'done')),
  provider_reference text,
  requested_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references public.profiles(id),
  constraint payment_refunds_done_check check ((status = 'done') = (done_at is not null and done_by is not null))
);
create index payment_refunds_open_idx on public.payment_refunds (clinic_id, requested_at) where status = 'requested';

alter table public.payment_invoices enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.payment_refunds enable row level security;
revoke all on table public.payment_invoices, public.payment_provider_events, public.payment_refunds from public, anon, authenticated;
grant select, insert, update on table public.payment_invoices, public.payment_provider_events, public.payment_refunds to service_role;

-- ---------------------------------------------------------------------------
-- Numbering for any clinic day (the slot's day for an online visit)
-- ---------------------------------------------------------------------------

create or replace function public.visit_next_number(p_clinic uuid, p_date date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_number integer;
begin
  -- The same lock visit_enqueue() takes: one numbering at a time per clinic.
  perform pg_advisory_xact_lock(hashtextextended('visit-queue:' || p_clinic::text, 0));
  select coalesce(max(queue_number), 0) + 1 into v_number from public.visits where clinic_id = p_clinic and queue_date = p_date;
  return v_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_online_invoice
-- ---------------------------------------------------------------------------

create or replace function public.create_online_invoice(
  p_clinic uuid, p_patient uuid, p_appointment uuid, p_provider public.payment_provider, p_ttl_minutes integer default 15)
returns public.payment_invoices
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a public.appointments;
  p public.payments;
  i public.payment_invoices;
begin
  if p_provider not in ('rahmat', 'test_online') then
    raise exception using message = 'online payment: unknown provider', errcode = '22023', hint = 'provider_unavailable';
  end if;
  select * into a from public.appointments where id = p_appointment and clinic_id = p_clinic and patient_id = p_patient for update;
  if not found then
    raise exception using message = 'online payment: appointment not found', errcode = '22023', hint = 'appointment_not_found';
  end if;
  if a.status not in ('pending', 'confirmed') or a.start_at < now() then
    raise exception using message = 'online payment: this booking cannot be paid', errcode = '22023', hint = 'not_payable';
  end if;
  select * into p from public.payments where appointment_id = a.id and clinic_id = p_clinic for update;
  if not found or p.status not in ('unpaid', 'pending', 'failed') or p.amount <= 0 then
    raise exception using message = 'online payment: nothing to pay', errcode = '22023', hint = 'nothing_due';
  end if;

  update public.payment_invoices set status = 'expired' where payment_id = p.id and status = 'open' and expires_at < now();
  select * into i from public.payment_invoices where payment_id = p.id and status = 'open';
  if found and i.provider = p_provider then
    return i;
  end if;
  if found then
    update public.payment_invoices set status = 'cancelled' where id = i.id;
  end if;

  insert into public.payment_invoices (clinic_id, payment_id, appointment_id, patient_id, provider, amount, currency, expires_at)
  values (p_clinic, p.id, a.id, a.patient_id, p_provider, p.amount, p.currency,
          now() + make_interval(mins => greatest(5, least(coalesce(p_ttl_minutes, 15), 60))))
  returning * into i;
  return i;
end;
$$;

-- ---------------------------------------------------------------------------
-- settle_online_payment — the webhook, after the server verified the provider's signature
-- ---------------------------------------------------------------------------

create or replace function public.settle_online_payment(
  p_provider public.payment_provider, p_event_id text, p_invoice uuid, p_amount numeric, p_currency text,
  p_provider_reference text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  i public.payment_invoices;
  p public.payments;
  a public.appointments;
  v public.visits;
  v_tz text;
  v_day date;
  v_number integer;
  v_service record;
  v_tg bigint;
  v_outcome text;
  v_refund uuid;
  v_existing text;
begin
  -- 1. Each provider event once: a replay returns what the first delivery decided.
  insert into public.payment_provider_events (provider, event_id, invoice_id, amount, currency)
  values (p_provider, p_event_id, p_invoice, p_amount, p_currency)
  on conflict (provider, event_id) do nothing;
  if not found then
    select outcome into v_existing from public.payment_provider_events where provider = p_provider and event_id = p_event_id;
    return jsonb_build_object('outcome', 'replayed', 'first_outcome', v_existing);
  end if;

  select * into i from public.payment_invoices where id = p_invoice and provider = p_provider for update;
  if not found then
    v_outcome := 'unknown_invoice';
  elsif p_amount is distinct from i.amount or p_currency is distinct from i.currency then
    -- Never "paid" for a different amount: the payment goes to manual review for a person to resolve.
    v_outcome := 'amount_mismatch';
    update public.payments set status = 'manual_review', metadata = metadata || jsonb_build_object('online_review', 'amount_mismatch', 'invoice_id', i.id)
     where id = i.payment_id and status in ('unpaid', 'pending', 'failed');
  end if;
  if v_outcome is not null then
    update public.payment_provider_events set outcome = v_outcome where provider = p_provider and event_id = p_event_id;
    return jsonb_build_object('outcome', 'rejected', 'reason', v_outcome);
  end if;

  select * into p from public.payments where id = i.payment_id for update;
  select * into a from public.appointments where id = i.appointment_id for update;

  -- 2. Already paid (a second payment), or the slot is gone: the money goes back.
  if i.status = 'paid' or p.status in ('paid', 'refunded') then
    insert into public.payment_refunds (clinic_id, payment_id, invoice_id, amount, currency, reason, provider_reference)
    values (i.clinic_id, p.id, i.id, p_amount, p_currency, 'duplicate_payment', p_provider_reference)
    returning id into v_refund;
    v_outcome := 'refund_requested';
  elsif a.status not in ('pending', 'confirmed') or a.end_at < now() then
    update public.payment_invoices set status = 'paid', paid_at = now(), provider_invoice_id = coalesce(p_provider_reference, provider_invoice_id) where id = i.id;
    update public.payments set status = 'paid', provider = p_provider, provider_reference = p_provider_reference, paid_at = now(), paid_by = null
     where id = p.id;
    insert into public.payment_refunds (clinic_id, payment_id, invoice_id, amount, currency, reason, provider_reference)
    values (i.clinic_id, p.id, i.id, p_amount, p_currency, 'slot_unavailable', p_provider_reference)
    returning id into v_refund;
    v_outcome := 'refund_requested';
  else
    -- 3. Paid: payment, appointment, visit with its number, ticket — together.
    update public.payment_invoices set status = 'paid', paid_at = now(), provider_invoice_id = coalesce(p_provider_reference, provider_invoice_id) where id = i.id;
    update public.payments set status = 'paid', provider = p_provider, provider_reference = p_provider_reference, paid_at = now(), paid_by = null
     where id = p.id;
    update public.appointments set status = 'confirmed' where id = a.id and status = 'pending';

    select timezone into v_tz from public.clinics where id = a.clinic_id;
    v_day := (a.start_at at time zone v_tz)::date;
    select * into v from public.visits where appointment_id = a.id;
    if not found then
      v_number := public.visit_next_number(a.clinic_id, v_day);
      insert into public.visits (clinic_id, patient_id, doctor_id, kind, status, source, queue_date, queue_number, queued_at, arrived_at,
                                 appointment_id, created_by, idempotency_key, request_fingerprint)
      values (a.clinic_id, a.patient_id, a.doctor_id, 'doctor', 'booked', 'online', v_day, v_number, now(), null,
              a.id, null, i.id, 'online:' || p.id::text)
      returning * into v;

      select s.id, s.name into v_service from public.services s where s.id = a.service_id;
      insert into public.visit_charges (clinic_id, visit_id, patient_id, service_id, service_name, unit_price, quantity, amount, currency, created_by)
      values (a.clinic_id, v.id, a.patient_id, v_service.id, v_service.name, p_amount, 1, p_amount, p_currency, null);
      insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, executed_by, authorized_by,
                                             request_key, request_fingerprint)
      values (a.clinic_id, v.id, a.patient_id, 'collection', 'online', p_amount, p_currency, null, null, i.id, 'online:' || p_event_id);

      select telegram_user_id into v_tg from public.patients where id = a.patient_id;
      if v_tg is not null then
        insert into public.notification_jobs (clinic_id, visit_id, type, patient_telegram_user_id, scheduled_for, idempotency_key)
        values (a.clinic_id, v.id, 'queue_ticket', v_tg, now(), 'queue_ticket:' || v.id::text)
        on conflict (idempotency_key) do nothing;
      end if;
    end if;
    v_outcome := 'settled';
  end if;

  update public.payment_provider_events set outcome = v_outcome where provider = p_provider and event_id = p_event_id;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, metadata)
  values (i.clinic_id, null, 'system', 'online_payment_' || v_outcome, 'payments', p.id::text, i.patient_id,
          jsonb_build_object('provider', p_provider, 'invoice_id', i.id, 'visit_id', v.id, 'refund_id', v_refund, 'queue_number', v.queue_number));
  return jsonb_build_object('outcome', v_outcome, 'visit_id', v.id, 'queue_number', v.queue_number, 'queue_date', v.queue_date, 'refund_id', v_refund);
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_booked_arrived — reception: the online patient is here
-- ---------------------------------------------------------------------------

create or replace function public.mark_booked_arrived(p_clinic uuid, p_actor uuid, p_visit uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_today date;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager', 'admin', 'receptionist']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'operations: visit not found', errcode = '22023', hint = 'visit_not_found';
  end if;
  if v.status <> 'booked' then
    raise exception using message = 'operations: not an online booking waiting for arrival', errcode = '22023', hint = 'invalid_transition';
  end if;
  select (now() at time zone timezone)::date into v_today from public.clinics where id = p_clinic;
  if v.queue_date <> v_today then
    raise exception using message = 'operations: the booking is for another day', errcode = '22023', hint = 'not_today';
  end if;
  update public.visits set status = 'waiting', arrived_at = now(), updated_at = now() where id = v.id returning * into v;
  update public.appointments set status = 'checked_in' where id = v.appointment_id and status in ('pending', 'confirmed');
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id)
  values (p_clinic, p_actor, 'staff', 'visit_booked_arrived', 'visits', v.id::text, v.patient_id);
  return jsonb_build_object('visit_id', v.id, 'queue_number', v.queue_number);
end;
$$;

-- ---------------------------------------------------------------------------
-- A cancelled appointment cancels its booked visit and asks for the money back
-- ---------------------------------------------------------------------------

create or replace function public.appointments_cancel_online_visit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  p public.payments;
begin
  select * into v from public.visits where appointment_id = new.id and status = 'booked' for update;
  if not found then
    return new;
  end if;
  update public.visits
     set status = 'cancelled', cancelled_at = now(),
         cancel_reason = case when new.status = 'no_show' then 'Bemor kelmadi' else 'Onlayn yozuv bekor qilindi' end,
         updated_at = now()
   where id = v.id;
  -- Refund defaults (decision record): a cancelled booking is refunded in full; a no-show is not.
  select * into p from public.payments where appointment_id = new.id and status = 'paid';
  if found and new.status = 'cancelled' then
    insert into public.payment_refunds (clinic_id, payment_id, visit_id, amount, currency, reason)
    select p.clinic_id, p.id, v.id, p.amount, p.currency, 'booking_cancelled'
     where not exists (select 1 from public.payment_refunds r where r.payment_id = p.id and r.reason = 'booking_cancelled');
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id)
  values (new.clinic_id, null, 'system', 'online_visit_cancelled', 'visits', v.id::text, v.patient_id);
  return new;
end;
$$;

create trigger appointments_cancel_online_visit
  after update of status on public.appointments
  for each row when (new.status in ('cancelled', 'no_show') and old.status is distinct from new.status)
  execute function public.appointments_cancel_online_visit();

-- ---------------------------------------------------------------------------
-- mark_online_refund_done — owner/manager: the provider returned the money
-- ---------------------------------------------------------------------------

create or replace function public.mark_online_refund_done(p_clinic uuid, p_actor uuid, p_refund uuid, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.payment_refunds;
  v_visit uuid;
  v_patient uuid;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['owner', 'manager']::public.staff_role[]);
  if p_reference is null or char_length(btrim(p_reference)) not between 3 and 120 then
    raise exception using message = 'online payment: refund reference required', errcode = '22023', hint = 'reason_required';
  end if;
  select * into r from public.payment_refunds where id = p_refund and clinic_id = p_clinic for update;
  if not found then
    raise exception using message = 'online payment: refund not found', errcode = '22023', hint = 'refund_not_found';
  end if;
  if r.status = 'done' then
    return jsonb_build_object('refund_id', r.id, 'replayed', true);
  end if;
  update public.payment_refunds set status = 'done', done_at = now(), done_by = p_actor, provider_reference = btrim(p_reference) where id = r.id;

  -- The payment is refunded when this refund returned its (only) money; a duplicate payment's refund leaves it paid.
  if r.reason <> 'duplicate_payment' then
    update public.payments set status = 'refunded' where id = r.payment_id and status = 'paid';
    select v.id, v.patient_id into v_visit, v_patient from public.visits v join public.payments p on p.appointment_id = v.appointment_id
     where p.id = r.payment_id;
    if v_visit is not null then
      insert into public.visit_transactions (clinic_id, visit_id, patient_id, kind, method, amount, currency, reason, executed_by, authorized_by,
                                             request_key, request_fingerprint)
      values (p_clinic, v_visit, v_patient, 'refund', 'online', r.amount, r.currency, 'Onlayn to‘lov qaytarildi', p_actor, p_actor,
              r.id, 'online-refund:' || r.id::text);
    end if;
  end if;
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, metadata)
  values (p_clinic, p_actor, 'staff', 'online_refund_done', 'payment_refunds', r.id::text, jsonb_build_object('reason', r.reason));
  return jsonb_build_object('refund_id', r.id, 'replayed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- start_visit_consultation: an online visit starts its own appointment
-- ---------------------------------------------------------------------------

create or replace function public.start_visit_consultation(p_clinic uuid, p_actor uuid, p_visit uuid, p_expected text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.visits;
  v_service uuid;
  v_result jsonb;
  v_appointment uuid;
  v_status public.appointment_status;
begin
  perform public.ops_require_role(p_clinic, p_actor, array['doctor']::public.staff_role[]);
  select * into v from public.visits where id = p_visit and clinic_id = p_clinic for update;
  if not found or not exists (
    select 1 from public.doctors d where d.id = v.doctor_id and d.clinic_id = p_clinic and d.profile_id = p_actor and d.active
  ) then
    raise exception using message = 'operations: not your patient', errcode = '42501', hint = 'forbidden';
  end if;
  if v.status <> p_expected then
    raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
  end if;
  if v.status not in ('waiting', 'called') then
    raise exception using message = 'operations: this patient is not in the queue', errcode = '22023', hint = 'invalid_transition';
  end if;

  if v.appointment_id is not null then
    -- Booked online: the consultation is the booked appointment itself (no second appointment).
    select status into v_status from public.appointments where id = v.appointment_id;
    v_result := public.start_consultation(p_clinic, v.appointment_id, v_status, p_actor, 'doctor_queue', false, v.doctor_id);
    if not coalesce((v_result ->> 'started')::boolean, false) and v_status <> 'in_progress' then
      raise exception using message = 'operations: the queue changed; refresh', errcode = '40001', hint = 'stale';
    end if;
    v_appointment := v.appointment_id;
  else
    select service_id into v_service from public.visit_charges
     where visit_id = v.id and status = 'active' order by created_at, id limit 1;
    if v_service is null then
      raise exception using message = 'operations: the visit has no service', errcode = '22023', hint = 'invalid_services';
    end if;

    v_result := public.start_walk_in_consultation(
      p_clinic, v.patient_id, v.doctor_id, v_service, date_trunc('minute', now()) + interval '1 minute', p_actor
    );
    v_appointment := (v_result ->> 'appointment_id')::uuid;
    if v_appointment is null then
      raise exception using message = 'operations: the consultation could not start', errcode = '22023',
        hint = coalesce(v_result ->> 'error_code', 'booking_failed');
    end if;
    delete from public.payments where appointment_id = v_appointment and status = 'unpaid';
  end if;

  update public.visits set status = 'in_progress', started_at = now(), appointment_id = v_appointment, updated_at = now()
   where id = v.id returning * into v;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, new_values)
  values (p_clinic, p_actor, 'staff', 'visit_consultation_started', 'visits', v.id::text, jsonb_build_object('appointment_id', v_appointment));
  return jsonb_build_object('visit_id', v.id, 'appointment_id', v_appointment, 'referral_id', v_result ->> 'referral_id');
end;
$$;

revoke all on function public.visit_next_number(uuid, date) from public, anon, authenticated;
revoke all on function public.create_online_invoice(uuid, uuid, uuid, public.payment_provider, integer) from public, anon, authenticated;
revoke all on function public.settle_online_payment(public.payment_provider, text, uuid, numeric, text, text) from public, anon, authenticated;
revoke all on function public.mark_booked_arrived(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.appointments_cancel_online_visit() from public, anon, authenticated;
revoke all on function public.mark_online_refund_done(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.start_visit_consultation(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.visit_next_number(uuid, date) to service_role;
grant execute on function public.create_online_invoice(uuid, uuid, uuid, public.payment_provider, integer) to service_role;
grant execute on function public.settle_online_payment(public.payment_provider, text, uuid, numeric, text, text) to service_role;
grant execute on function public.mark_booked_arrived(uuid, uuid, uuid) to service_role;
grant execute on function public.mark_online_refund_done(uuid, uuid, uuid, text) to service_role;
grant execute on function public.start_visit_consultation(uuid, uuid, uuid, text) to service_role;
