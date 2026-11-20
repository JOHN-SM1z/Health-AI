-- PostgREST detects one-to-one relationships from the complete FK column set.
-- Preserve the appointment API's single payment object after tenant hardening.
alter table public.payments add constraint payments_appointment_tenant_unique unique(appointment_id,clinic_id,patient_id);
alter table public.payments add constraint payments_visit_tenant_unique unique(visit_id,clinic_id,patient_id);
notify pgrst, 'reload schema';
