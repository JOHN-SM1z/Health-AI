-- Clinics sign up on the website, pay by invoice, and run their staff from one web app (owner decision 2026-10-10).
--
--   * profiles.login — every employee signs in with a login + password (no email needed). Auth still keys accounts
--     by email, so a login maps to the internal address <login>@staff.health-ai.invalid (src/lib/auth/login.ts).
--     Logins are unique across the platform: one web app, one login page.
--   * profiles.must_change_password — set when an account is created or its password is reset by the owner;
--     every panel sends the employee to /account/password until they set their own.
--   * departments — the clinic's own units (Terapiya, Laboratoriya, Qabulxona, Kassa…). They organise staff;
--     access stays by role (staff_roles.department_id).
--   * subscription_plans / clinic_subscriptions / subscription_invoices — a 14-day trial, then a monthly invoice
--     paid by bank transfer. Only a platform admin confirms a payment (confirm_subscription_invoice); the browser
--     never marks anything paid. Card payment comes later, with a signed merchant contract.
--   * platform_billing — the payee details printed on invoices; edited by platform admins.
--   * provision_clinic() — creates the clinic, its owner, its default departments, the trial and the first invoice
--     in one transaction, after the server has created the owner's login.
--
-- Clinic and profile rows are now written by the server only (service role). Owners keep editing their clinic's
-- display details; activation, identity/SMS switches and slugs are no longer writable from a browser session.

-- ---------- Logins ----------
alter table public.profiles
  add column login text,
  add column must_change_password boolean not null default false;
alter table public.profiles
  add constraint profiles_login_format check (login is null or login ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
create unique index profiles_login_key on public.profiles (login) where login is not null;
comment on column public.profiles.login is 'Sign-in login (lowercase). Maps to the auth email <login>@staff.health-ai.invalid.';

-- Profiles are written by the server only (account creation, password change). Staff keep reading them.
revoke insert, update, delete on table public.profiles from authenticated;

-- Clinics: display details stay editable by the owner (policy "clinic update for owner"); everything that
-- controls access, billing or patient-facing switches is server-only.
revoke insert, update, delete on table public.clinics from authenticated;
grant update (name, address, phone, email, opening_hours, privacy_notice, timezone, currency, updated_at)
  on table public.clinics to authenticated;

alter table public.clinics add column city text;
alter table public.clinics add constraint clinics_city_length check (city is null or char_length(city) <= 80);

-- ---------- Departments ----------
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  name text not null constraint departments_name_check check (char_length(btrim(name)) between 2 and 80),
  kind text not null default 'clinical'
    constraint departments_kind_check check (kind in ('clinical', 'laboratory', 'reception', 'cashier', 'management', 'other')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint departments_id_clinic_id_key unique (id, clinic_id)
);
create unique index departments_clinic_name_key on public.departments (clinic_id, lower(btrim(name)));
alter table public.departments enable row level security;
revoke all on table public.departments from public, anon, authenticated;
grant select on table public.departments to authenticated;
grant select, insert, update, delete on table public.departments to service_role;
create policy "departments read for clinic staff"
  on public.departments for select
  to authenticated
  using (public.is_clinic_staff(clinic_id));

alter table public.staff_roles add column department_id uuid;
alter table public.staff_roles add constraint staff_roles_department_fkey
  foreign key (department_id, clinic_id) references public.departments (id, clinic_id) on delete set null (department_id);
create index staff_roles_department_idx on public.staff_roles (department_id) where department_id is not null;

-- ---------- Plans ----------
create table public.subscription_plans (
  id uuid primary key default gen_random_uuid(),
  code text not null unique constraint subscription_plans_code_check check (code ~ '^[a-z0-9_-]{2,32}$'),
  name text not null constraint subscription_plans_name_check check (char_length(btrim(name)) between 2 and 60),
  tagline text not null default '' constraint subscription_plans_tagline_check check (char_length(tagline) <= 160),
  monthly_price_uzs bigint not null constraint subscription_plans_price_check check (monthly_price_uzs >= 0),
  max_staff integer constraint subscription_plans_max_staff_check check (max_staff is null or max_staff > 0),
  max_doctors integer constraint subscription_plans_max_doctors_check check (max_doctors is null or max_doctors > 0),
  features text[] not null default '{}',
  is_public boolean not null default true,
  -- A price the platform owner has not confirmed yet: shown on the landing page as "taxminiy".
  price_is_draft boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- Subscriptions ----------
create table public.clinic_subscriptions (
  clinic_id uuid primary key references public.clinics(id) on delete cascade,
  plan_id uuid not null references public.subscription_plans(id),
  status text not null constraint clinic_subscriptions_status_check check (status in ('trialing', 'active', 'past_due', 'cancelled')),
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create sequence public.subscription_invoice_number_seq;

create table public.subscription_invoices (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  plan_id uuid not null references public.subscription_plans(id),
  number text not null unique,
  amount_uzs bigint not null constraint subscription_invoices_amount_check check (amount_uzs >= 0),
  months integer not null default 1 constraint subscription_invoices_months_check check (months between 1 and 12),
  status text not null default 'issued' constraint subscription_invoices_status_check check (status in ('issued', 'paid', 'void')),
  issued_at timestamptz not null default now(),
  due_at timestamptz not null,
  paid_at timestamptz,
  confirmed_by uuid references public.profiles(id),
  payment_reference text constraint subscription_invoices_reference_check check (payment_reference is null or char_length(payment_reference) <= 120),
  created_at timestamptz not null default now()
);
create index subscription_invoices_clinic_idx on public.subscription_invoices (clinic_id, issued_at desc);
-- One open invoice per clinic at a time.
create unique index subscription_invoices_one_open on public.subscription_invoices (clinic_id) where status = 'issued';

create table public.platform_billing (
  id boolean primary key default true constraint platform_billing_singleton check (id),
  legal_name text not null default '',
  tin text not null default '',
  bank_name text not null default '',
  bank_account text not null default '',
  mfo text not null default '',
  contact_phone text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.platform_billing (id) values (true);

alter table public.subscription_plans enable row level security;
alter table public.clinic_subscriptions enable row level security;
alter table public.subscription_invoices enable row level security;
alter table public.platform_billing enable row level security;
revoke all on table public.subscription_plans, public.clinic_subscriptions, public.subscription_invoices, public.platform_billing
  from public, anon, authenticated;
grant select, insert, update, delete on table public.subscription_plans, public.clinic_subscriptions,
  public.subscription_invoices, public.platform_billing to service_role;
revoke all on sequence public.subscription_invoice_number_seq from public, anon, authenticated;
grant usage on sequence public.subscription_invoice_number_seq to service_role;

-- Draft plans: the platform owner sets the real prices in /platform (price_is_draft turns false when saved).
insert into public.subscription_plans (code, name, tagline, monthly_price_uzs, max_staff, max_doctors, features, sort_order) values
  ('start', 'Start', 'Kichik klinika yoki xususiy kabinet uchun', 990000, 8, 3,
   array['Telegram orqali onlayn qabul', 'Pasport/ID bilan bemorni aniqlash', 'Qabulxona, navbat va kassa', 'Shifokor ish joyi', 'Eslatmalar'], 1),
  ('klinika', 'Klinika', 'Ko‘p tarmoqli klinika uchun', 2490000, 30, 12,
   array['Start rejasidagi hammasi', 'Laboratoriya: buyurtma, natija, PDF', 'Yo‘llanmalar va bo‘limlar', 'Moliya va tahlillar', 'SMS (Eskiz shartnomasi bilan)'], 2),
  ('tarmoq', 'Tarmoq', 'Bir nechta filial va katta jamoa uchun', 5900000, null, null,
   array['Klinika rejasidagi hammasi', 'Cheksiz xodim va shifokor', 'Ustuvor yordam', 'Ma’lumotlarni ko‘chirishda yordam'], 3),
  ('pilot', 'Pilot', 'Pilot klinikalar uchun', 0, null, null, array[]::text[], 99);
update public.subscription_plans set is_public = false, price_is_draft = false where code = 'pilot';

-- Clinics that exist before sign-up opened are pilot clinics: active, no end date.
insert into public.clinic_subscriptions (clinic_id, plan_id, status)
select c.id, p.id, 'active' from public.clinics c cross join public.subscription_plans p where p.code = 'pilot'
on conflict (clinic_id) do nothing;

-- ---------- provision_clinic ----------
-- Called by the server after it has created the owner's auth account (the auth API is not reachable from SQL).
-- Everything else is one transaction: if it fails, the server deletes that account again.
create or replace function public.provision_clinic(
  p_owner_id uuid,
  p_owner_name text,
  p_owner_login text,
  p_owner_phone text,
  p_clinic_name text,
  p_slug text,
  p_clinic_phone text,
  p_city text,
  p_address text,
  p_plan_code text
) returns table (clinic_id uuid, invoice_id uuid, invoice_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.subscription_plans;
  v_clinic uuid;
  v_invoice uuid;
  v_number text;
  v_trial_end timestamptz := now() + interval '14 days';
begin
  select * into v_plan from public.subscription_plans where code = p_plan_code and is_public;
  if not found then
    raise exception 'unknown plan' using errcode = 'P0001', detail = 'plan_not_found';
  end if;

  insert into public.clinics (name, slug, phone, city, address, is_active)
  values (btrim(p_clinic_name), p_slug, nullif(btrim(p_clinic_phone), ''), nullif(btrim(p_city), ''), nullif(btrim(p_address), ''), true)
  returning id into v_clinic;

  insert into public.profiles (id, full_name, phone, login, must_change_password)
  values (p_owner_id, btrim(p_owner_name), nullif(btrim(p_owner_phone), ''), p_owner_login, false)
  on conflict (id) do update set full_name = excluded.full_name, phone = excluded.phone, login = excluded.login;

  insert into public.staff_roles (clinic_id, profile_id, role) values (v_clinic, p_owner_id, 'owner');

  insert into public.departments (clinic_id, name, kind, sort_order) values
    (v_clinic, 'Rahbariyat', 'management', 1),
    (v_clinic, 'Qabulxona', 'reception', 2),
    (v_clinic, 'Kassa', 'cashier', 3),
    (v_clinic, 'Terapiya', 'clinical', 4),
    (v_clinic, 'Laboratoriya', 'laboratory', 5);

  update public.staff_roles set department_id = (select d.id from public.departments d where d.clinic_id = v_clinic and d.kind = 'management')
  where staff_roles.clinic_id = v_clinic and profile_id = p_owner_id;

  insert into public.clinic_subscriptions (clinic_id, plan_id, status, trial_ends_at)
  values (v_clinic, v_plan.id, 'trialing', v_trial_end);

  v_number := 'HA-' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY') || '-' || lpad(nextval('public.subscription_invoice_number_seq')::text, 5, '0');
  insert into public.subscription_invoices (clinic_id, plan_id, number, amount_uzs, months, due_at)
  values (v_clinic, v_plan.id, v_number, v_plan.monthly_price_uzs, 1, v_trial_end)
  returning id into v_invoice;

  insert into public.audit_events (clinic_id, actor_type, actor_id, action, entity_type, entity_id, new_values, metadata)
  values (v_clinic, 'staff', p_owner_id, 'clinic_signed_up', 'clinics', v_clinic::text,
          jsonb_build_object('plan', v_plan.code, 'status', 'trialing'), jsonb_build_object('source', 'website'));

  return query select v_clinic, v_invoice, v_number;
end;
$$;

-- ---------- confirm_subscription_invoice ----------
-- A platform admin confirms that the bank transfer arrived. Extends the subscription by the invoice's months from
-- the later of now and the current period end. Idempotent: a paid invoice is not paid twice.
create or replace function public.confirm_subscription_invoice(p_invoice_id uuid, p_admin_id uuid, p_reference text)
returns table (clinic_id uuid, period_end timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.subscription_invoices;
  v_sub public.clinic_subscriptions;
  v_end timestamptz;
begin
  if not exists (select 1 from public.platform_admins where profile_id = p_admin_id) then
    raise exception 'not a platform admin' using errcode = '42501';
  end if;

  select * into v_inv from public.subscription_invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'invoice not found' using errcode = 'P0001', detail = 'invoice_not_found';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'invoice is not open' using errcode = 'P0001', detail = 'invoice_not_open';
  end if;

  select * into v_sub from public.clinic_subscriptions where clinic_subscriptions.clinic_id = v_inv.clinic_id for update;
  v_end := greatest(now(), coalesce(v_sub.current_period_end, now()), coalesce(v_sub.trial_ends_at, now()))
           + make_interval(months => v_inv.months);

  update public.subscription_invoices
     set status = 'paid', paid_at = now(), confirmed_by = p_admin_id, payment_reference = nullif(btrim(p_reference), '')
   where id = v_inv.id;

  insert into public.clinic_subscriptions (clinic_id, plan_id, status, current_period_end)
  values (v_inv.clinic_id, v_inv.plan_id, 'active', v_end)
  on conflict on constraint clinic_subscriptions_pkey do update
    set plan_id = excluded.plan_id, status = 'active', current_period_end = excluded.current_period_end, updated_at = now();

  update public.clinics set is_active = true where id = v_inv.clinic_id and not is_active;

  insert into public.audit_events (clinic_id, actor_type, actor_id, action, entity_type, entity_id, new_values, metadata)
  values (v_inv.clinic_id, 'system', p_admin_id, 'subscription_invoice_paid', 'subscription_invoices', v_inv.id::text,
          jsonb_build_object('status', 'paid', 'months', v_inv.months), jsonb_build_object('by', 'platform_admin'));

  return query select v_inv.clinic_id, v_end;
end;
$$;

-- ---------- issue_subscription_invoice ----------
-- The next month's invoice (the clinic's current plan) when none is open. Called by the owner's billing page and by
-- the platform admin.
create or replace function public.issue_subscription_invoice(p_clinic_id uuid, p_months integer)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub public.clinic_subscriptions;
  v_plan public.subscription_plans;
  v_id uuid;
begin
  select id into v_id from public.subscription_invoices where clinic_id = p_clinic_id and status = 'issued';
  if found then
    return v_id;
  end if;
  select * into v_sub from public.clinic_subscriptions where clinic_id = p_clinic_id;
  if not found then
    raise exception 'no subscription' using errcode = 'P0001', detail = 'subscription_not_found';
  end if;
  select * into v_plan from public.subscription_plans where id = v_sub.plan_id;
  insert into public.subscription_invoices (clinic_id, plan_id, number, amount_uzs, months, due_at)
  values (p_clinic_id, v_plan.id,
          'HA-' || to_char(now() at time zone 'Asia/Tashkent', 'YYYY') || '-' || lpad(nextval('public.subscription_invoice_number_seq')::text, 5, '0'),
          v_plan.monthly_price_uzs * greatest(1, least(12, p_months)), greatest(1, least(12, p_months)),
          greatest(now(), coalesce(v_sub.current_period_end, v_sub.trial_ends_at, now())) + interval '3 days')
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.provision_clinic(uuid, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.confirm_subscription_invoice(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.issue_subscription_invoice(uuid, integer) from public, anon, authenticated;
grant execute on function public.provision_clinic(uuid, text, text, text, text, text, text, text, text, text) to service_role;
grant execute on function public.confirm_subscription_invoice(uuid, uuid, text) to service_role;
grant execute on function public.issue_subscription_invoice(uuid, integer) to service_role;
