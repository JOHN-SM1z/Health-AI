-- 20260822120000: Audit trigger header injection for service-role actor attribution.

create or replace function public.handle_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := coalesce(
    nullif(current_setting('app.current_user_id', true), '')::uuid,
    nullif(current_setting('request.header.x-actor-id', true), '')::uuid,
    auth.uid()
  );
  v_clinic_id uuid := coalesce(new.clinic_id, old.clinic_id);
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
    jsonb_build_object('ip', nullif(current_setting('request.ip', true), ''))
  );

  return coalesce(new, old);
end;
$$;

drop trigger if exists staff_roles_audit on public.staff_roles;
create trigger staff_roles_audit
  after insert or update or delete on public.staff_roles
  for each row execute function public.handle_audit_log();

drop trigger if exists appointments_audit on public.appointments;
create trigger appointments_audit
  after insert or update or delete on public.appointments
  for each row execute function public.handle_audit_log();

drop trigger if exists payments_audit on public.payments;
create trigger payments_audit
  after insert or update or delete on public.payments
  for each row execute function public.handle_audit_log();

drop trigger if exists doctor_time_blocks_audit on public.doctor_time_blocks;
create trigger doctor_time_blocks_audit
  after insert or update or delete on public.doctor_time_blocks
  for each row execute function public.handle_audit_log();

drop trigger if exists conversations_audit on public.conversations;
create trigger conversations_audit
  after insert or update or delete on public.conversations
  for each row execute function public.handle_audit_log();
