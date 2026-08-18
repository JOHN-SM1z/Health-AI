-- 0023: Role-based authorization — roles and platform-admin schema.
--
-- The original role model had only owner/admin/doctor. This migration adds:
--   * manager      — same clinic operations as admin (analytics, catalog,
--                    conversations, bot monitoring)
--   * receptionist — appointments, patients, conversations and takeover;
--                    NEVER revenue analytics, catalog or bot configuration
--   * platform_admin (separate table — has no clinic, so it cannot live in
--     staff_roles which requires clinic_id) — platform-level clinic
--     administration; never clinic data through the browser client
--
-- NOTE: PostgreSQL forbids *using* a new enum value in the same migration
-- that adds it, so all RLS policy rewrites referencing 'manager'/'receptionist'
-- live in the follow-up migration 0024.

-- ---------- 1. staff_role extensions ----------

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'manager'
  ) then
    alter type public.staff_role add value 'manager' before 'admin';
  end if;
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'receptionist'
  ) then
    alter type public.staff_role add value 'receptionist' before 'doctor';
  end if;
end $$;

-- ---------- 2. Platform administrators ----------
-- No clinic_id: platform staff are not clinic staff and never see clinic
-- data through the browser client (all platform access is server-side).

create table public.platform_admins (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

-- The row only proves platform-admin membership to the user themselves;
-- management (insert/delete) is service-role-only (platform routes).
create policy "platform_admins read own"
  on public.platform_admins for select
  to authenticated
  using (profile_id = auth.uid());

-- No other policies: platform access is service-role-only.

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.platform_admins where profile_id = auth.uid());
$$;
