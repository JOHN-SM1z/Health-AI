-- Creating and deleting a patient are audited.
--
-- The patient record is the key of the longitudinal clinic record: every visit,
-- referral and clinical record hangs off it, so who created it, through which
-- channel and when must be reconstructable — for finding duplicates later and
-- for the day two records have to be reconciled. Until now nothing recorded it.
--
-- A trigger writes the audit row in the same transaction as the insert, so no
-- creation path (reception, a walk-in, the Mini App, the website, a path added
-- later) can forget it, and a failed audit write undoes the creation. The same
-- goes for deletion: 'patient_deleted' is written by a trigger in the deleting
-- transaction (a delete the foreign keys refuse writes nothing), so a record
-- removed again — e.g. a registration whose booking was refused — never
-- leaves a creation without its end in the trail. A patient removed because
-- their whole clinic is deleted in the same statement gets no row of its own
-- (the clinic, and so the audit's tenant, is gone; a clinic with audit rows
-- cannot be deleted at all since 20261001000003).
--
--   * patients.created_by  — the staff profile that registered the patient
--                            (null for a patient who registered themselves).
--   * patients.created_via — the channel: reception, walk_in, telegram, website.
--                            Both are written by the server; null on rows that
--                            predate this migration.
--   * audit 'patient_created' — ids and channel only. Never the name, phone or
--                            any Telegram detail: the audit trail holds no
--                            personal data beyond identifiers.
--
-- Reversible: drop triggers patients_audit_created and patients_audit_deleted
-- on public.patients; drop functions public.patients_audit_created() and
-- public.patients_audit_deleted(); alter table public.patients drop
-- column created_by, drop column created_via. Existing rows are untouched.

alter table public.patients
  add column created_by uuid references public.profiles(id) on delete set null,
  add column created_via text;

alter table public.patients
  add constraint patients_created_via_check
  check (created_via is null or created_via in ('reception', 'walk_in', 'telegram', 'website'));

comment on column public.patients.created_by is
  'Staff profile that registered the patient (reception or a walk-in); null when the patient registered themselves or the row predates 20261002000002. Set by the server only.';
comment on column public.patients.created_via is
  'Channel that created the record: reception, walk_in, telegram or website; null for rows that predate 20261002000002.';

create or replace function public.patients_audit_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A staff creator must work in the patient's clinic (the audit row is
  -- tenant-checked too, but a clear message is better than a guard's).
  if new.created_by is not null and not exists (
    select 1 from public.staff_roles sr
     where sr.profile_id = new.created_by and sr.clinic_id = new.clinic_id
  ) then
    raise exception 'patient: created_by is not staff of the patient''s clinic';
  end if;

  insert into public.audit_events (
    clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values, metadata
  ) values (
    new.clinic_id,
    new.created_by,
    case
      when new.created_by is not null then 'staff'::public.actor_type
      when new.created_via = 'telegram' then 'telegram'::public.actor_type
      else 'system'::public.actor_type
    end,
    'patient_created',
    'patients',
    new.id::text,
    new.id,
    jsonb_build_object('created_via', new.created_via),
    jsonb_build_object(
      'created_via', new.created_via,
      'has_phone', new.phone is not null,
      'has_telegram_identity', new.telegram_user_id is not null
    )
  );
  return null;
end;
$$;

revoke all on function public.patients_audit_created() from public, anon, authenticated;

create trigger patients_audit_created
  after insert on public.patients
  for each row execute function public.patients_audit_created();

create or replace function public.patients_audit_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.clinics c where c.id = old.clinic_id) then
    insert into public.audit_events (
      clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values, metadata
    ) values (
      old.clinic_id,
      null,
      'system'::public.actor_type,
      'patient_deleted',
      'patients',
      old.id::text,
      old.id,
      null,
      jsonb_build_object(
        'created_via', old.created_via,
        'created_by', old.created_by,
        'created_at', old.created_at
      )
    );
  end if;
  return old;
end;
$$;

revoke all on function public.patients_audit_deleted() from public, anon, authenticated;

create trigger patients_audit_deleted
  before delete on public.patients
  for each row execute function public.patients_audit_deleted();
