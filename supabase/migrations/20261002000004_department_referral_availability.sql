-- A department referral needs a doctor who can receive it.
--
-- A referral to a department is seen by the department's active doctors until
-- one of them takes it (20261002000001). With no such doctor it would sit
-- pending, unseen by anyone, while the referring doctor believes the handoff
-- was made. So:
--
--   * creating one for a department with no receiving doctor is refused —
--     active, with a doctor login, in the department, and not the referring
--     doctor (their own department never receives their own referral);
--   * a referral whose department LATER loses its last receiving doctor stays
--     as it is (it is the patient's record, and the doctors may return) but
--     is reported to the referring doctor as awaiting a doctor
--     (src/lib/referrals/service.ts), so they can revoke it or refer
--     elsewhere; when a doctor becomes available it appears for them without
--     anyone re-creating it, and otherwise it ends at its expires_at.
--
-- Reversible: drop trigger referrals_department_receivable on public.referrals;
-- drop function public.referrals_department_receivable();
-- drop function public.department_has_receiving_doctor(uuid, uuid, uuid).

create or replace function public.department_has_receiving_doctor(
  p_clinic_id uuid,
  p_specialty_id uuid,
  p_excluding_doctor_id uuid default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.doctors d
     where d.clinic_id = p_clinic_id
       and d.specialty_id = p_specialty_id
       and d.active
       and d.id is distinct from p_excluding_doctor_id
       -- Not another record of the same login either (a login never receives its own referral).
       and d.profile_id is distinct from (select e.profile_id from public.doctors e where e.id = p_excluding_doctor_id)
       and exists (
         select 1 from public.staff_roles sr
          where sr.profile_id = d.profile_id and sr.clinic_id = d.clinic_id and sr.role = 'doctor'
       )
  );
$$;

comment on function public.department_has_receiving_doctor(uuid, uuid, uuid) is
  'Whether a department (specialty) of the clinic has an active doctor with a doctor login other than the excluded doctor (and other than that doctor''s own login) — i.e. someone who can receive a department referral. Server-only.';

revoke all on function public.department_has_receiving_doctor(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.department_has_receiving_doctor(uuid, uuid, uuid) to service_role;

create or replace function public.referrals_department_receivable()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- A department that is not this clinic's is the composite foreign key's to refuse.
  if new.referred_to_doctor_id is null
     and new.referred_to_specialty_id is not null
     and exists (select 1 from public.specialties s where s.id = new.referred_to_specialty_id and s.clinic_id = new.clinic_id)
     and not public.department_has_receiving_doctor(new.clinic_id, new.referred_to_specialty_id, new.referring_doctor_id) then
    raise exception 'referral: the department has no active doctor to receive it';
  end if;
  return new;
end;
$$;

revoke all on function public.referrals_department_receivable() from public, anon, authenticated;

create trigger referrals_department_receivable
  before insert on public.referrals
  for each row execute function public.referrals_department_receivable();
