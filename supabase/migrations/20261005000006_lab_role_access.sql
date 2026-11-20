-- Laboratory (Phase 3, 2 of 2): the lab role in the database access model.
--
-- Lab work tables stay server-only (no table privileges for signed-in roles,
-- 20261005000003); these policies are the backstop that matches the
-- AGENTS.md access model if a privilege is ever granted:
--   * lab staff see their clinic's orders, items, samples and sample links —
--     the lab work queue;
--   * result tables keep RLS without policies (20261005000004): nobody signed
--     in reads them directly, lab staff included — the server authorizes and
--     audits every result read.
-- The catalog is already readable by every staff member of the clinic.

create policy "lab orders read for lab staff" on public.lab_orders
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab order items read for lab staff" on public.lab_order_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab samples read for lab staff" on public.lab_samples
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));

create policy "lab sample items read for lab staff" on public.lab_sample_items
  for select to authenticated
  using (public.is_clinic_staff(clinic_id, array['lab']::public.staff_role[]));
