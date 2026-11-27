-- Security review 2026-11-27 (docs/SECURITY_ASSESSMENT_2026-11-27.md, finding DB-1).
--
-- Every clinical access decision keys on doctors.profile_id: whoever the
-- doctor record is linked to IS that doctor — reads the doctor's patients and
-- writes records under the doctor's name. The link is changed by the clinic's
-- management through the server, and until now nothing recorded that it
-- happened. From here every change of the link leaves an audit row (ids only),
-- written by the database so no code path can skip it.
--
-- This records; it does not restrict. Whether a doctor record that already has
-- clinical history may be re-linked to another account at all is an owner
-- decision (see the assessment); the trigger makes any such change visible.

create or replace function public.doctors_account_link_audit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.profile_id is distinct from old.profile_id then
    insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, old_values, new_values, metadata)
    values (
      new.clinic_id,
      auth.uid(),
      case when auth.uid() is null then 'system'::public.actor_type else 'staff'::public.actor_type end,
      'doctor_account_link_changed',
      'doctors',
      new.id::text,
      jsonb_build_object('profile_id', old.profile_id),
      jsonb_build_object('profile_id', new.profile_id),
      -- How much the new account inherits: the doctor record's own clinical records so far.
      jsonb_build_object('clinical_record_count', (select count(*) from public.clinical_records cr where cr.author_doctor_id = new.id))
    );
  end if;
  return new;
end;
$$;

revoke all on function public.doctors_account_link_audit() from public, anon, authenticated;

create trigger doctors_account_link_audit
  after update of profile_id on public.doctors
  for each row execute function public.doctors_account_link_audit();
