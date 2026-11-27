-- 20260822130000: reconcile migration drift, actor resolution, and multi-clinic RLS.

-- 1) Unify audit actor attribution on runtime audit_track_changes() and remove drift duplicates.
create or replace function public.audit_track_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clinic_id uuid := coalesce(new.clinic_id, old.clinic_id);
  v_actor uuid := coalesce(
    nullif(current_setting('app.current_user_id', true), '')::uuid,
    nullif(current_setting('request.header.x-actor-id', true), '')::uuid,
    auth.uid()
  );
begin
  insert into public.audit_events (
    clinic_id,
    actor_id,
    actor_type,
    action,
    entity_type,
    entity_id,
    old_values,
    new_values,
    metadata
  ) values (
    v_clinic_id,
    v_actor,
    case when v_actor is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
    TG_OP,
    TG_TABLE_NAME,
    coalesce(new.id::text, old.id::text),
    case when TG_OP in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when TG_OP in ('UPDATE', 'INSERT') then to_jsonb(new) else null end,
    jsonb_build_object(
      'ip', nullif(current_setting('request.ip', true), '')
    )
  );

  return coalesce(new, old);
end;
$$;



-- Rebind all relevant triggers to the canonical function name.
drop trigger if exists staff_roles_audit on public.staff_roles;
create trigger staff_roles_audit
  after insert or update or delete on public.staff_roles
  for each row execute function public.audit_track_changes();

drop trigger if exists appointments_audit on public.appointments;
create trigger appointments_audit
  after insert or update or delete on public.appointments
  for each row execute function public.audit_track_changes();

drop trigger if exists payments_audit on public.payments;
create trigger payments_audit
  after insert or update or delete on public.payments
  for each row execute function public.audit_track_changes();

drop trigger if exists doctor_time_blocks_audit on public.doctor_time_blocks;
create trigger doctor_time_blocks_audit
  after insert or update or delete on public.doctor_time_blocks
  for each row execute function public.audit_track_changes();

drop trigger if exists conversations_audit on public.conversations;
create trigger conversations_audit
  after insert or update or delete on public.conversations
  for each row execute function public.audit_track_changes();

-- 2) Fix RLS helpers to respect audit override and multi-clinic membership.
create or replace function public.is_clinic_staff(p_clinic_id uuid, p_roles public.staff_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.staff_roles sr
    where sr.profile_id = coalesce(
      -- auth.uid() is the cryptographic JWT identity; always prefer it
      -- for browser sessions. The header/session fallback only applies
      -- to service-role code (no JWT, so auth.uid() is null).
      auth.uid(),
      nullif(current_setting('app.current_user_id', true), '')::uuid,
      nullif(current_setting('request.header.x-actor-id', true), '')::uuid
    )
      and sr.clinic_id = p_clinic_id
      and (p_roles is null or sr.role = any (p_roles))
  );
$$;

-- 3) Fix scalar subqueries / multi-clinic profile visibility.
-- Replace the "limit 1" clinic lookup with an existence check across all shared clinics.
drop policy if exists "profile read for clinic staff" on public.profiles;
create policy "Staff can view profiles in their clinics"
on public.profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.staff_roles sr1
    join public.staff_roles sr2 on sr1.clinic_id = sr2.clinic_id
    where sr1.profile_id = auth.uid()
      and sr2.profile_id = profiles.id
  )
);

-- If a later migration/seed creates a different profile read policy, this migration
-- keeps the canonical shape explicit and set-based.

-- Remove only after all dependent triggers have been rebound.
drop function if exists public.handle_audit_log();
