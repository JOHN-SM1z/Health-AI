-- Operational (front-desk) notes about a patient: logistics only — e.g.
-- "prefers morning slots", "needs a translator", "hard to reach by phone".
-- Never a clinical/diagnostic record. Editable by clinic operational staff
-- (owner/admin/manager/receptionist) via the service-role API route only;
-- no new RLS policy is needed since it is a column on an already row-level
-- clinic/role-scoped table.
alter table public.patients
  add column operational_notes text;

alter table public.patients
  add constraint patients_operational_notes_length
  check (operational_notes is null or char_length(operational_notes) <= 1000);
