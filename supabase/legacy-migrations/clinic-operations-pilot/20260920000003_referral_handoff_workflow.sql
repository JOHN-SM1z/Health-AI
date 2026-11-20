-- Clinical note linkage and legacy referral status support. Enum addition committed in preceding migration.
-- ---------- 2. Add referral_id to clinical_notes ----------

alter table public.clinical_notes
  add column if not exists referral_id uuid
    references public.referrals(id) on delete set null;

create index if not exists clinical_notes_referral_id_idx
  on public.clinical_notes (referral_id)
  where referral_id is not null;

-- ---------- 3. Extend clinical_notes.note_type ----------
-- The existing column is a plain text field with a CHECK constraint.
-- We drop the old constraint and recreate it with the full set.

alter table public.clinical_notes
  drop constraint if exists clinical_notes_note_type_check;

alter table public.clinical_notes
  add constraint clinical_notes_note_type_check
    check (note_type in (
      'encounter',           -- general consultation note (legacy, kept for compatibility)
      'referral_summary',    -- summary written by referring doctor at referral time (legacy)
      'follow_up',           -- follow-up note (legacy)
      'historical_diagnosis',-- pre-existing diagnosis authored by another doctor
      'current_assessment',  -- receiving doctor's working assessment
      'new_diagnosis',       -- formal new diagnosis authored by receiving doctor
      'clinical_note',       -- general clinical note
      'prescription',        -- medication order
      'laboratory_order',    -- lab test order
      'follow_up_referral'   -- follow-up or onward referral note
    ));

-- ---------- 4. Update status-transition trigger ----------
-- Replace the existing function to allow the full lifecycle:
--   pending     → accepted | declined | revoked | expired
--   accepted    → in_progress | completed | revoked | expired
--   in_progress → completed | revoked | expired
-- All other state changes raise an exception.

create or replace function public.referrals_validate_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending'::public.referral_status then
      raise exception 'referrals: new referrals must be created with status pending, got %', new.status;
    end if;
    return new;
  end if;

  -- On UPDATE: no-op if status unchanged
  if old.status = new.status then
    return new;
  end if;

  case old.status
    when 'pending'::public.referral_status then
      if new.status = 'accepted'::public.referral_status then
        if new.accepted_at is null then
          new.accepted_at := now();
        end if;
      elsif new.status = 'declined'::public.referral_status then
        null;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from pending to %', new.status;
      end if;

    when 'accepted'::public.referral_status then
      if new.status = 'in_progress'::public.referral_status then
        null; -- consultation started; tracked via audit event, not a timestamp column
      elsif new.status = 'completed'::public.referral_status then
        if new.completed_at is null then
          new.completed_at := now();
        end if;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from accepted to %', new.status;
      end if;

    when 'in_progress'::public.referral_status then
      if new.status = 'completed'::public.referral_status then
        if new.completed_at is null then
          new.completed_at := now();
        end if;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from in_progress to %', new.status;
      end if;

    when 'completed'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status completed';

    when 'declined'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status declined';

    when 'revoked'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status revoked';

    when 'expired'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status expired';

    else
      raise exception 'referrals: unrecognized status %', old.status;
  end case;

  return new;
end;
$$;

-- ---------- 5. Update patients RLS policy for referral-based doctor access ----------
-- Extend the existing doctor read policy (created in migration 0024) so that
-- receiving doctors with in_progress referrals also pass.

drop policy if exists "patients read for doctors" on public.patients;

create policy "patients read for doctors"
  on public.patients for select
  to authenticated
  using (
    -- Direct: doctor has an appointment with this patient in the same clinic
    exists (
      select 1 from public.staff_roles sr
      join public.doctors d on d.profile_id = sr.profile_id
      join public.appointments a
        on a.doctor_id = d.id
        and a.patient_id = public.patients.id
      where sr.profile_id = auth.uid()
        and sr.role = 'doctor'
        and sr.clinic_id = public.patients.clinic_id
    )
    or
    -- Referral-based: active non-revoked referral (pending | accepted | in_progress)
    exists (
      select 1 from public.referrals r
      join public.doctors d on d.profile_id = auth.uid()
      where r.patient_id = public.patients.id
        and r.referred_to_doctor_id = d.id
        and r.clinic_id = public.patients.clinic_id
        and r.status in (
          'pending'::public.referral_status,
          'accepted'::public.referral_status,
          'in_progress'::public.referral_status
        )
        and r.revoked_at is null
        and (r.expires_at is null or r.expires_at > now())
    )
  );
