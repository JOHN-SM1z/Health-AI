-- Patient merge (Lab Phase 14): one person, two patient records of the same
-- clinic, made one longitudinal record — without destroying or rewriting
-- anything.
--
-- The patient is the root of the longitudinal record, and much of what hangs
-- off it is immutable by design (clinical records, lab results and values,
-- documents, the append-only audit trail) and keyed by composite foreign
-- keys that include patient_id. Re-pointing those rows would rewrite who a
-- historical fact was recorded about. So a merge is a LINK, not a move:
--
--   * patients.merged_into_patient_id: the duplicate record points at the
--     canonical one. No appointment, payment, conversation, referral,
--     clinical record, lab order / result / document or audit row changes.
--     Every one keeps its author, time and the patient it was recorded for.
--   * patient_record_group(): the canonical record plus the records merged
--     into it. Doctor access (doctor_patient_access) and the server's
--     longitudinal reads use the group, so the person's history reads as
--     one. Per-appointment coverage is unchanged: a doctor still sees only
--     their own visits, referral-linked ones and shared histories.
--   * The unique identity a patient is reached by moves to the canonical
--     record when only the duplicate has it (Telegram identity, PINFL,
--     passport/ID number), so the bot and future imports find the canonical
--     record. Facts the canonical record lacks (date of birth, sex, phone,
--     name, consent) are COPIED from the duplicate. Everything moved or
--     copied is recorded on the merge.
--   * A merged record takes no new appointments, lab orders, referrals,
--     clinical records or conversations (trigger): new work goes to the
--     canonical record.
--   * unmerge_patients() undoes the link and moves the identity back (when
--     it is still as the merge left it). Copied facts stay on the canonical
--     record (the duplicate still has its own). What was created on the
--     canonical record after the merge stays there; the report says so.
--
-- A merge is refused (never guessed) when the two records contradict each
-- other — date of birth, sex, PINFL, document, two different Telegram
-- identities — or when the duplicate has live work: upcoming or ongoing
-- appointments, open referrals, active lab orders or unfinished results,
-- open conversations, pending notifications, or import rows waiting to be
-- imported. Finish or cancel those first.
--
-- patient_merge_preview() is the complete pre-merge preview (counts per
-- entity on both records, identity plan, blockers, warnings — including the
-- doctors whose access will extend to the combined record) with a
-- fingerprint; merge_patients() recomputes it under row locks and refuses if
-- anything changed since the preview the staff member confirmed.
--
-- Clinic-scoped (composite keys), server-only (service_role), transactional,
-- audited (patient_merged / patient_unmerged on both records — ids and field
-- names only, never identity values).

-- ---------------------------------------------------------------------------
-- The link
-- ---------------------------------------------------------------------------

alter table public.patients
  add column merged_into_patient_id uuid,
  add column merged_at timestamptz;

alter table public.patients
  add constraint patients_merged_into_fkey
    foreign key (merged_into_patient_id, clinic_id) references public.patients (id, clinic_id),
  add constraint patients_merged_into_check
    check (merged_into_patient_id is distinct from id
           and (merged_into_patient_id is null) = (merged_at is null));

create index patients_merged_into_idx on public.patients (merged_into_patient_id) where merged_into_patient_id is not null;
create index patients_clinic_birth_idx on public.patients (clinic_id, date_of_birth) where date_of_birth is not null;

comment on column public.patients.merged_into_patient_id is
  'Set when this record was merged into another record of the same clinic (patient_merges). The record and everything recorded for it stay as they were; reads of the longitudinal record use patient_record_group().';

create table public.patient_merges (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics(id) on delete cascade,
  canonical_patient_id uuid not null,
  duplicate_patient_id uuid not null,
  reason text not null,
  merged_by uuid not null references public.profiles(id),
  merged_at timestamptz not null default now(),
  -- The preview the staff member confirmed (counts, plan, warnings).
  preview jsonb not null,
  -- Identity moved from the duplicate to the canonical record: {field: value}.
  moved jsonb not null default '{}'::jsonb,
  -- Facts copied onto the canonical record (the duplicate keeps its own): {field: value}.
  copied jsonb not null default '{}'::jsonb,
  unmerged_by uuid references public.profiles(id),
  unmerged_at timestamptz,
  unmerge_reason text,
  unmerge_report jsonb,

  constraint patient_merges_canonical_fkey
    foreign key (canonical_patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint patient_merges_duplicate_fkey
    foreign key (duplicate_patient_id, clinic_id) references public.patients (id, clinic_id),
  constraint patient_merges_distinct_check check (canonical_patient_id <> duplicate_patient_id),
  constraint patient_merges_reason_check check (reason ~ '\S' and char_length(reason) between 3 and 500),
  constraint patient_merges_unmerge_check
    check ((unmerged_at is null) = (unmerged_by is null)
           and (unmerged_at is null) = (unmerge_reason is null)
           and (unmerge_reason is null or (unmerge_reason ~ '\S' and char_length(unmerge_reason) between 3 and 500)))
);

create unique index patient_merges_live_duplicate_key on public.patient_merges (duplicate_patient_id) where unmerged_at is null;
create index patient_merges_clinic_idx on public.patient_merges (clinic_id, merged_at desc);
create index patient_merges_canonical_idx on public.patient_merges (canonical_patient_id);

-- The merge log never changes, except to record its undoing once.
create or replace function public.patient_merges_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if public.lab_clinic_is_being_erased(old.clinic_id) then
      return old;
    end if;
    raise exception 'patient merge: the merge log cannot be deleted';
  end if;
  if old.unmerged_at is not null then
    raise exception 'patient merge: an undone merge cannot change';
  end if;
  if (to_jsonb(new) - array['unmerged_by', 'unmerged_at', 'unmerge_reason', 'unmerge_report'])
     <> (to_jsonb(old) - array['unmerged_by', 'unmerged_at', 'unmerge_reason', 'unmerge_report']) then
    raise exception 'patient merge: only its undoing is recorded';
  end if;
  return new;
end;
$$;

revoke all on function public.patient_merges_guard() from public, anon, authenticated;

create trigger patient_merges_guard
  before update or delete on public.patient_merges
  for each row execute function public.patient_merges_guard();

alter table public.patient_merges enable row level security;
revoke all on table public.patient_merges from public, anon, authenticated, service_role;
grant select, insert, update on table public.patient_merges to service_role;

-- ---------------------------------------------------------------------------
-- The record group
-- ---------------------------------------------------------------------------

create or replace function public.patient_canonical_id(p_patient_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p.merged_into_patient_id, p.id) from public.patients p where p.id = p_patient_id;
$$;

-- The canonical record of `p_patient_id` and every record merged into it.
-- Merges are one level deep (a merged record cannot be canonical), so this
-- is exact. Empty for an unknown id.
create or replace function public.patient_record_group(p_patient_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select x.id
    from public.patients x
    where x.id = c.canonical or x.merged_into_patient_id = c.canonical
    order by (x.id = c.canonical) desc, x.created_at
  ), '{}')
  from (select public.patient_canonical_id(p_patient_id) as canonical) c;
$$;

revoke all on function public.patient_canonical_id(uuid) from public, anon, authenticated;
revoke all on function public.patient_record_group(uuid) from public, anon, authenticated;
grant execute on function public.patient_canonical_id(uuid) to service_role;
grant execute on function public.patient_record_group(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Doctor access over the group (same rules, the person's records as one)
-- ---------------------------------------------------------------------------

create or replace function public.doctor_patient_access(p_doctor_id uuid, p_patient_id uuid)
returns table (
  clinic_id uuid,
  own_patient boolean,
  active_referral_ids uuid[],
  history_doctor_ids uuid[],
  referral_appointment_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    d.clinic_id,
    -- Own relationship: a live appointment, or a record the doctor wrote.
    exists (
      select 1
      from public.appointments a
      where a.clinic_id = d.clinic_id
        and a.patient_id = any (g.ids)
        and a.doctor_id = d.id
        and a.status <> 'cancelled'
    )
    or exists (
      select 1
      from public.clinical_records cr
      where cr.clinic_id = d.clinic_id
        and cr.patient_id = any (g.ids)
        and cr.author_doctor_id = d.id
    ),
    array(
      select r.id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      order by r.created_at
    ),
    array(
      select distinct r.referring_doctor_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('accepted', 'in_progress')
        and r.expires_at > now()
    ),
    array(
      -- The consultation an open referral to this doctor was raised from…
      select r.originating_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referred_to_doctor_id = d.id
        and r.status in ('pending', 'accepted', 'in_progress')
        and r.expires_at > now()
      union
      -- …and the follow-up of a referral this doctor made, while it stands.
      select r.follow_up_appointment_id
      from public.referrals r
      where r.clinic_id = d.clinic_id
        and r.patient_id = any (g.ids)
        and r.referring_doctor_id = d.id
        and r.follow_up_appointment_id is not null
        and r.status in ('accepted', 'in_progress', 'completed')
        and r.expires_at > now()
    )
  from public.doctors d
  join public.patients p
    on p.id = p_patient_id
   and p.clinic_id = d.clinic_id
  cross join lateral (select public.patient_record_group(p.id) as ids) g
  where d.id = p_doctor_id
    and d.active
    and exists (
      select 1
      from public.staff_roles sr
      where sr.profile_id = d.profile_id
        and sr.clinic_id = d.clinic_id
        and sr.role = 'doctor'
    );
$$;

comment on function public.doctor_patient_access(uuid, uuid) is
  'What an active doctor may see of a patient (see 20260929000001; over the merged record group since 20261005000016): own relationship (live appointment or authored record); open, unexpired referrals to them; referring doctors whose visits accepted/in-progress referrals share; referral-linked appointments. No row = no access. Server-only.';

-- ---------------------------------------------------------------------------
-- A merged record takes no new work
-- ---------------------------------------------------------------------------

create or replace function public.refuse_merged_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.patients p where p.id = new.patient_id and p.merged_into_patient_id is not null) then
    raise exception 'patient_merged: this patient record was merged into another; use that record';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_merged_patient() from public, anon, authenticated;

create trigger appointments_refuse_merged_patient before insert on public.appointments
  for each row execute function public.refuse_merged_patient();
create trigger lab_orders_refuse_merged_patient before insert on public.lab_orders
  for each row execute function public.refuse_merged_patient();
create trigger referrals_refuse_merged_patient before insert on public.referrals
  for each row execute function public.refuse_merged_patient();
create trigger clinical_records_refuse_merged_patient before insert on public.clinical_records
  for each row execute function public.refuse_merged_patient();
create trigger conversations_refuse_merged_patient before insert on public.conversations
  for each row execute function public.refuse_merged_patient();

-- ---------------------------------------------------------------------------
-- Preview
-- ---------------------------------------------------------------------------

create or replace function public.patient_entity_counts(p_clinic_id uuid, p_patient_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'appointments', (select count(*) from public.appointments a where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id),
    'appointments_active', (select count(*) from public.appointments a where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id
                              and a.status in ('pending', 'confirmed', 'checked_in', 'in_progress')),
    'payments', (select count(*) from public.payments x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'conversations', (select count(*) from public.conversations x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'conversations_open', (select count(*) from public.conversations x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                             and x.status in ('open', 'assigned')),
    'referrals', (select count(*) from public.referrals x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'referrals_open', (select count(*) from public.referrals x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                         and x.status in ('pending', 'accepted', 'in_progress')),
    'clinical_records', (select count(*) from public.clinical_records x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_orders', (select count(*) from public.lab_orders x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_orders_active', (select count(*) from public.lab_orders x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id and x.status = 'active'),
    'lab_results', (select count(*) from public.lab_results x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'lab_results_unfinished', (select count(*) from public.lab_results x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                                 and x.status in ('draft', 'submitted')),
    'lab_documents', (select count(*) from public.lab_documents x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'notifications_pending', (
      select count(*) from public.notification_jobs j
      where j.clinic_id = p_clinic_id and j.status in ('pending', 'in_progress')
        -- Appointment messages only: a pending "result ready" message still
        -- reaches the person (their Telegram identity moves with the merge).
        and j.appointment_id in (select a.id from public.appointments a where a.patient_id = p_patient_id)),
    'import_rows_pending', (select count(*) from public.lab_import_rows x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id
                              and x.status in ('ready', 'failed')),
    'audit_events', (select count(*) from public.audit_events x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id),
    'analytics_events', (select count(*) from public.analytics_events x where x.clinic_id = p_clinic_id and x.patient_id = p_patient_id)
  );
$$;

revoke all on function public.patient_entity_counts(uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_entity_counts(uuid, uuid) to service_role;

-- Doctors with their own relationship (live appointment or authored record) to a patient record.
create or replace function public.patient_relationship_doctors(p_clinic_id uuid, p_patient_id uuid)
returns uuid[]
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(array(
    select a.doctor_id from public.appointments a
    where a.clinic_id = p_clinic_id and a.patient_id = p_patient_id and a.status <> 'cancelled'
    union
    select cr.author_doctor_id from public.clinical_records cr
    where cr.clinic_id = p_clinic_id and cr.patient_id = p_patient_id
  ), '{}');
$$;

revoke all on function public.patient_relationship_doctors(uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_relationship_doctors(uuid, uuid) to service_role;

create or replace function public.patient_merge_preview(p_clinic_id uuid, p_canonical_id uuid, p_duplicate_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  c public.patients;
  d public.patients;
  v_blockers text[] := '{}';
  v_warnings text[] := '{}';
  v_plan jsonb := '{}'::jsonb;
  v_counts_c jsonb;
  v_counts_d jsonb;
  v_doctors_c uuid[];
  v_doctors_d uuid[];
  v_gain jsonb;
  v_body jsonb;
  v_field text;
  v_cv text;
  v_dv text;
begin
  select * into c from public.patients p where p.id = p_canonical_id and p.clinic_id = p_clinic_id;
  select * into d from public.patients p where p.id = p_duplicate_id and p.clinic_id = p_clinic_id;
  if c.id is null or d.id is null then
    raise exception 'patient_merge_not_found: both records must be patients of this clinic';
  end if;
  if c.id = d.id then
    v_blockers := array_append(v_blockers, ('same_patient')::text);
  end if;
  if c.merged_into_patient_id is not null then v_blockers := array_append(v_blockers, ('canonical_merged')::text); end if;
  if d.merged_into_patient_id is not null then v_blockers := array_append(v_blockers, ('duplicate_merged')::text); end if;
  if exists (select 1 from public.patients x where x.merged_into_patient_id = d.id) then
    v_blockers := array_append(v_blockers, ('duplicate_has_merged_records')::text);
  end if;

  -- Identity: contradictions stop the merge; what only the duplicate has moves (unique) or is copied.
  foreach v_field in array array['date_of_birth', 'sex', 'pinfl', 'document_number', 'telegram_user_id', 'full_name', 'phone'] loop
    v_cv := to_jsonb(c) ->> v_field;
    v_dv := to_jsonb(d) ->> v_field;
    v_plan := v_plan || jsonb_build_object(v_field,
      case
        when v_dv is null then 'keep'
        when v_cv is null then case when v_field in ('pinfl', 'document_number', 'telegram_user_id') then 'move' else 'copy' end
        when v_cv = v_dv then 'same'
        else 'differs'
      end);
    if v_cv is not null and v_dv is not null and v_cv <> v_dv then
      if v_field in ('date_of_birth', 'sex', 'pinfl', 'document_number') then
        v_blockers := array_append(v_blockers, ((case v_field when 'date_of_birth' then 'dob_differs' when 'document_number' then 'document_differs' else v_field || '_differs' end))::text);
      elsif v_field = 'telegram_user_id' then
        v_blockers := array_append(v_blockers, ('telegram_differs')::text);
      elsif v_field = 'full_name' then
        v_warnings := array_append(v_warnings, ('name_differs')::text);
      else
        v_warnings := array_append(v_warnings, ('phone_differs')::text);
      end if;
    end if;
  end loop;
  v_plan := v_plan || jsonb_build_object('consent', case when d.consent_given and not c.consent_given then 'copy' else 'keep' end);

  v_counts_c := public.patient_entity_counts(p_clinic_id, c.id);
  v_counts_d := public.patient_entity_counts(p_clinic_id, d.id);

  -- The duplicate's live work must be finished or cancelled first.
  if (v_counts_d ->> 'appointments_active')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_active_appointments')::text); end if;
  if (v_counts_d ->> 'referrals_open')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_open_referrals')::text); end if;
  if (v_counts_d ->> 'lab_orders_active')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_active_lab_orders')::text); end if;
  if (v_counts_d ->> 'lab_results_unfinished')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_unfinished_lab_results')::text); end if;
  if (v_counts_d ->> 'conversations_open')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_open_conversations')::text); end if;
  if (v_counts_d ->> 'notifications_pending')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_pending_notifications')::text); end if;
  if (v_counts_d ->> 'import_rows_pending')::int > 0 then v_blockers := array_append(v_blockers, ('duplicate_pending_import')::text); end if;

  -- Whose access extends: a doctor with their own relationship to one record
  -- will see the combined record (their own visits on both, as always).
  v_doctors_c := public.patient_relationship_doctors(p_clinic_id, c.id);
  v_doctors_d := public.patient_relationship_doctors(p_clinic_id, d.id);
  select coalesce(jsonb_agg(jsonb_build_object('doctor_id', dr.id, 'name', dr.name, 'from', case when dr.id = any (v_doctors_d) then 'duplicate' else 'canonical' end) order by dr.name), '[]'::jsonb)
  into v_gain
  from public.doctors dr
  where dr.clinic_id = p_clinic_id
    and ((dr.id = any (v_doctors_d) and not dr.id = any (v_doctors_c))
         or (dr.id = any (v_doctors_c) and not dr.id = any (v_doctors_d)));
  if jsonb_array_length(v_gain) > 0 then
    v_warnings := array_append(v_warnings, ('doctor_access_extends')::text);
  end if;

  v_body := jsonb_build_object(
    'canonical', jsonb_build_object('id', c.id, 'full_name', c.full_name, 'phone', c.phone, 'date_of_birth', c.date_of_birth, 'sex', c.sex,
                                    'has_pinfl', c.pinfl is not null, 'has_document', c.document_number is not null,
                                    'has_telegram', c.telegram_user_id is not null, 'created_at', c.created_at, 'updated_at', c.updated_at,
                                    'counts', v_counts_c),
    'duplicate', jsonb_build_object('id', d.id, 'full_name', d.full_name, 'phone', d.phone, 'date_of_birth', d.date_of_birth, 'sex', d.sex,
                                    'has_pinfl', d.pinfl is not null, 'has_document', d.document_number is not null,
                                    'has_telegram', d.telegram_user_id is not null, 'created_at', d.created_at, 'updated_at', d.updated_at,
                                    'counts', v_counts_d),
    'plan', v_plan,
    'doctors_gaining_access', v_gain,
    'blockers', to_jsonb(v_blockers),
    'warnings', to_jsonb(v_warnings)
  );
  -- The fingerprint covers everything the staff member decides on; the
  -- audit and analytics counts are informational (viewing the preview is
  -- itself audited, so they would never match).
  return v_body || jsonb_build_object('fingerprint', md5((
    v_body #- '{canonical,counts,audit_events}' #- '{duplicate,counts,audit_events}'
           #- '{canonical,counts,analytics_events}' #- '{duplicate,counts,analytics_events}')::text));
end;
$$;

revoke all on function public.patient_merge_preview(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.patient_merge_preview(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Merge
-- ---------------------------------------------------------------------------

create or replace function public.merge_patients(
  p_clinic_id uuid,
  p_canonical_id uuid,
  p_duplicate_id uuid,
  p_actor uuid,
  p_reason text,
  p_fingerprint text
)
returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_preview jsonb;
  v_merge uuid;
  c public.patients;
  d public.patients;
  v_moved jsonb := '{}'::jsonb;
  v_copied jsonb := '{}'::jsonb;
begin
  if not exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_actor and sr.role in ('owner', 'admin')
  ) then
    raise exception 'patient_merge_forbidden: only the clinic owner or an administrator merges patients';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'patient_merge_reason_required: give the reason for the merge';
  end if;

  -- Both records, in a fixed order (no deadlock between opposite merges).
  perform 1 from public.patients p
  where p.id in (p_canonical_id, p_duplicate_id) and p.clinic_id = p_clinic_id
  order by p.id
  for update;

  v_preview := public.patient_merge_preview(p_clinic_id, p_canonical_id, p_duplicate_id);
  if jsonb_array_length(v_preview -> 'blockers') > 0 then
    raise exception 'patient_merge_blocked: %', (select string_agg(b, ',') from jsonb_array_elements_text(v_preview -> 'blockers') b);
  end if;
  if p_fingerprint is distinct from v_preview ->> 'fingerprint' then
    raise exception 'patient_merge_preview_changed: the records changed since the preview';
  end if;

  select * into c from public.patients p where p.id = p_canonical_id;
  select * into d from public.patients p where p.id = p_duplicate_id;

  -- Unique identity moves (cleared on the duplicate first, then set).
  if d.telegram_user_id is not null and c.telegram_user_id is null then
    v_moved := v_moved || jsonb_build_object('telegram_user_id', d.telegram_user_id, 'telegram_username', d.telegram_username,
                                             'telegram_first_name', d.telegram_first_name, 'telegram_last_name', d.telegram_last_name);
  end if;
  if d.pinfl is not null and c.pinfl is null then
    v_moved := v_moved || jsonb_build_object('pinfl', d.pinfl);
  end if;
  if d.document_number is not null and c.document_number is null then
    v_moved := v_moved || jsonb_build_object('document_number', d.document_number);
  end if;
  if v_moved <> '{}'::jsonb then
    update public.patients
    set telegram_user_id = case when v_moved ? 'telegram_user_id' then null else telegram_user_id end,
        telegram_username = case when v_moved ? 'telegram_user_id' then null else telegram_username end,
        telegram_first_name = case when v_moved ? 'telegram_user_id' then null else telegram_first_name end,
        telegram_last_name = case when v_moved ? 'telegram_user_id' then null else telegram_last_name end,
        pinfl = case when v_moved ? 'pinfl' then null else pinfl end,
        document_number = case when v_moved ? 'document_number' then null else document_number end
    where id = d.id;
    update public.patients
    set telegram_user_id = coalesce((v_moved ->> 'telegram_user_id')::bigint, telegram_user_id),
        telegram_username = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_username' else telegram_username end,
        telegram_first_name = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_first_name' else telegram_first_name end,
        telegram_last_name = case when v_moved ? 'telegram_user_id' then v_moved ->> 'telegram_last_name' else telegram_last_name end,
        pinfl = coalesce(v_moved ->> 'pinfl', pinfl),
        document_number = coalesce(v_moved ->> 'document_number', document_number)
    where id = c.id;
  end if;

  -- Facts the canonical record lacks are copied (the duplicate keeps them too).
  if c.date_of_birth is null and d.date_of_birth is not null then v_copied := v_copied || jsonb_build_object('date_of_birth', d.date_of_birth); end if;
  if c.sex is null and d.sex is not null then v_copied := v_copied || jsonb_build_object('sex', d.sex); end if;
  if c.full_name is null and d.full_name is not null then v_copied := v_copied || jsonb_build_object('full_name', d.full_name); end if;
  if c.phone is null and d.phone is not null then v_copied := v_copied || jsonb_build_object('phone', d.phone); end if;
  if not c.consent_given and d.consent_given then
    v_copied := v_copied || jsonb_build_object('consent_given', true, 'consent_given_at', d.consent_given_at);
  end if;
  if v_copied <> '{}'::jsonb then
    update public.patients
    set date_of_birth = coalesce(date_of_birth, (v_copied ->> 'date_of_birth')::date),
        sex = coalesce(sex, (v_copied ->> 'sex')::public.patient_sex),
        full_name = coalesce(full_name, v_copied ->> 'full_name'),
        phone = coalesce(phone, v_copied ->> 'phone'),
        consent_given = consent_given or coalesce((v_copied ->> 'consent_given')::boolean, false),
        consent_given_at = case when v_copied ? 'consent_given' then (v_copied ->> 'consent_given_at')::timestamptz else consent_given_at end
    where id = c.id;
  end if;

  update public.patients set merged_into_patient_id = c.id, merged_at = now() where id = d.id;

  insert into public.patient_merges (clinic_id, canonical_patient_id, duplicate_patient_id, reason, merged_by, preview, moved, copied)
  values (p_clinic_id, c.id, d.id, btrim(p_reason), p_actor, v_preview, v_moved, v_copied)
  returning id into v_merge;

  -- Ids and field names only — never identity values or the reason text.
  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values
    (p_clinic_id, p_actor, 'staff', 'patient_merged', 'patient_merges', v_merge::text, c.id,
     jsonb_build_object('role', 'canonical', 'canonical_patient_id', c.id, 'duplicate_patient_id', d.id,
                        'moved_fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v_moved) k),
                        'copied_fields', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(v_copied) k))),
    (p_clinic_id, p_actor, 'staff', 'patient_merged', 'patient_merges', v_merge::text, d.id,
     jsonb_build_object('role', 'duplicate', 'canonical_patient_id', c.id, 'duplicate_patient_id', d.id));
  return v_merge;
end;
$$;

revoke all on function public.merge_patients(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.merge_patients(uuid, uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Unmerge
-- ---------------------------------------------------------------------------

create or replace function public.unmerge_patients(p_clinic_id uuid, p_merge_id uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  m public.patient_merges;
  c public.patients;
  d public.patients;
  v_restored text[] := '{}';
  v_left text[] := '{}';
  v_report jsonb;
  v_since jsonb;
begin
  if not exists (
    select 1 from public.staff_roles sr
    where sr.clinic_id = p_clinic_id and sr.profile_id = p_actor and sr.role in ('owner', 'admin')
  ) then
    raise exception 'patient_merge_forbidden: only the clinic owner or an administrator undoes a merge';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'patient_merge_reason_required: give the reason';
  end if;

  select * into m from public.patient_merges x where x.id = p_merge_id and x.clinic_id = p_clinic_id for update;
  if not found then
    raise exception 'patient_merge_not_found: no such merge in this clinic';
  end if;
  if m.unmerged_at is not null then
    raise exception 'patient_merge_already_undone: this merge was already undone';
  end if;

  perform 1 from public.patients p where p.id in (m.canonical_patient_id, m.duplicate_patient_id) order by p.id for update;
  select * into c from public.patients p where p.id = m.canonical_patient_id;
  select * into d from public.patients p where p.id = m.duplicate_patient_id;

  -- Identity goes back only while it is exactly as the merge left it.
  if m.moved ? 'telegram_user_id' then
    if c.telegram_user_id = (m.moved ->> 'telegram_user_id')::bigint and d.telegram_user_id is null then
      update public.patients set telegram_user_id = null, telegram_username = null, telegram_first_name = null, telegram_last_name = null where id = c.id;
      update public.patients
      set telegram_user_id = (m.moved ->> 'telegram_user_id')::bigint, telegram_username = m.moved ->> 'telegram_username',
          telegram_first_name = m.moved ->> 'telegram_first_name', telegram_last_name = m.moved ->> 'telegram_last_name'
      where id = d.id;
      v_restored := array_append(v_restored, ('telegram_user_id')::text);
    else
      v_left := array_append(v_left, ('telegram_user_id')::text);
    end if;
  end if;
  if m.moved ? 'pinfl' then
    if c.pinfl = m.moved ->> 'pinfl' and d.pinfl is null then
      update public.patients set pinfl = null where id = c.id;
      update public.patients set pinfl = m.moved ->> 'pinfl' where id = d.id;
      v_restored := array_append(v_restored, ('pinfl')::text);
    else
      v_left := array_append(v_left, ('pinfl')::text);
    end if;
  end if;
  if m.moved ? 'document_number' then
    if c.document_number = m.moved ->> 'document_number' and d.document_number is null then
      update public.patients set document_number = null where id = c.id;
      update public.patients set document_number = m.moved ->> 'document_number' where id = d.id;
      v_restored := array_append(v_restored, ('document_number')::text);
    else
      v_left := array_append(v_left, ('document_number')::text);
    end if;
  end if;

  update public.patients set merged_into_patient_id = null, merged_at = null where id = d.id;

  -- What was created on the canonical record after the merge stays there.
  v_since := jsonb_build_object(
    'appointments', (select count(*) from public.appointments a where a.patient_id = c.id and a.created_at >= m.merged_at),
    'lab_orders', (select count(*) from public.lab_orders o where o.patient_id = c.id and o.created_at >= m.merged_at),
    'conversations', (select count(*) from public.conversations x where x.patient_id = c.id and x.created_at >= m.merged_at),
    'referrals', (select count(*) from public.referrals x where x.patient_id = c.id and x.created_at >= m.merged_at),
    'clinical_records', (select count(*) from public.clinical_records x where x.patient_id = c.id and x.created_at >= m.merged_at));
  v_report := jsonb_build_object(
    'restored_fields', to_jsonb(v_restored),
    'left_on_canonical', to_jsonb(v_left),
    'copied_fields_kept', (select coalesce(jsonb_agg(k), '[]') from jsonb_object_keys(m.copied) k),
    'created_on_canonical_since_merge', v_since);

  update public.patient_merges
  set unmerged_by = p_actor, unmerged_at = now(), unmerge_reason = btrim(p_reason), unmerge_report = v_report
  where id = m.id;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, new_values)
  values
    (p_clinic_id, p_actor, 'staff', 'patient_unmerged', 'patient_merges', m.id::text, c.id,
     jsonb_build_object('role', 'canonical', 'restored_fields', to_jsonb(v_restored), 'left_on_canonical', to_jsonb(v_left))),
    (p_clinic_id, p_actor, 'staff', 'patient_unmerged', 'patient_merges', m.id::text, d.id,
     jsonb_build_object('role', 'duplicate'));
  return v_report;
end;
$$;

revoke all on function public.unmerge_patients(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.unmerge_patients(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Possible duplicates (suggestions for staff review — never merged automatically)
-- ---------------------------------------------------------------------------

create or replace function public.patient_name_key(p_name text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select nullif(array_to_string(array(
    select t from unnest(regexp_split_to_array(lower(regexp_replace(coalesce(p_name, ''), '[ʻʼ‘’`''"]', '', 'g')), '[^[:alpha:]]+')) t
    where t <> '' order by t), ' '), '');
$$;

create or replace function public.patient_duplicate_candidates(p_clinic_id uuid, p_limit integer default 100)
returns table (patient_a uuid, patient_b uuid, reasons text[])
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with live as (
    select p.id, p.date_of_birth,
           public.patient_name_key(coalesce(p.full_name, concat_ws(' ', p.telegram_first_name, p.telegram_last_name))) as name_key,
           nullif(right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 9), '') as phone_key
    from public.patients p
    where p.clinic_id = p_clinic_id and p.merged_into_patient_id is null
  ), pairs as (
    select a.id as patient_a, b.id as patient_b,
           array_remove(array[
             case when a.date_of_birth = b.date_of_birth and a.name_key = b.name_key then 'same_name_and_birth_date' end,
             case when a.date_of_birth = b.date_of_birth and length(a.phone_key) = 9 and a.phone_key = b.phone_key then 'same_phone_and_birth_date' end,
             -- Name and phone agree, and no birth dates contradict them.
             case when a.name_key = b.name_key and length(a.phone_key) = 9 and a.phone_key = b.phone_key
                       and not (a.date_of_birth is not null and b.date_of_birth is not null and a.date_of_birth <> b.date_of_birth)
                  then 'same_name_and_phone' end
           ], null) as reasons
    from live a
    join live b on a.id < b.id
      and ((a.date_of_birth = b.date_of_birth) or (a.name_key = b.name_key and a.phone_key = b.phone_key))
  )
  select patient_a, patient_b, reasons from pairs
  where cardinality(reasons) > 0
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

revoke all on function public.patient_name_key(text) from public, anon, authenticated;
grant execute on function public.patient_name_key(text) to service_role;
revoke all on function public.patient_duplicate_candidates(uuid, integer) from public, anon, authenticated;
grant execute on function public.patient_duplicate_candidates(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- "Result ready" reaches the person's Telegram identity, wherever the merge put it.
-- ---------------------------------------------------------------------------

create or replace function public.lab_results_notify_patient()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_telegram bigint;
begin
  if new.source = 'import' then
    return null; -- historical data brought in by an import: not news to the patient
  end if;
  if not public.lab_release_to_patient(new.clinic_id) then
    return null;
  end if;
  select p.telegram_user_id into v_telegram
  from public.patients p
  where p.id = public.patient_canonical_id(new.patient_id) and p.clinic_id = new.clinic_id;
  if v_telegram is null then
    return null; -- no Telegram identity: the result is still in the Mini App once linked
  end if;

  insert into public.notification_jobs (clinic_id, type, lab_result_id, patient_telegram_user_id, scheduled_for, idempotency_key)
  values (new.clinic_id, 'lab_result_ready', new.id, v_telegram, now(), 'lab_result_ready:' || new.id::text)
  on conflict (idempotency_key) do nothing;
  return null;
end;
$$;

revoke all on function public.lab_results_notify_patient() from public, anon, authenticated;
