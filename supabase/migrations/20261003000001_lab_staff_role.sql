-- Laboratory module, phase 3: the laboratory staff role.
--
-- A technician enters results and handles samples without any admin, finance, booking or clinical-history
-- access, which none of owner/admin/manager/receptionist/doctor express (docs/labs/PHASE_1_AUDIT.md §7).
-- A separate verifier role is NOT added: verification is a permission of lab_staff, and whether a second
-- person must verify is a per-clinic setting (app_settings key 'lab', phase 3).
--
-- Fail-closed by construction: every route and RLS policy lists the roles it admits, so a new value gains
-- nothing until it is named; the only "any staff" policies are the read-only configuration tables
-- (clinics, services, doctors, specialties, working hours, faqs, app_settings, staff_roles and the lab
-- catalog), which a lab technician may read like every other staff role. Nothing about patients,
-- appointments, payments, conversations, referrals or clinical records is granted.
--
-- It must be its own migration: a new enum value cannot be used in the transaction that adds it (the
-- lab triggers of the next migration use it). Not reversible by migration (an enum value cannot be removed);
-- remove the staff_roles rows and stop assigning it.

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'staff_role' and e.enumlabel = 'lab_staff'
  ) then
    alter type public.staff_role add value 'lab_staff' after 'doctor';
  end if;
end $$;
