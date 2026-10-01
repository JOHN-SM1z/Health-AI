-- Retention categories are independent. Parent erasure cannot substitute for
-- a confirmed per-category retention decision. No retention executor is added.
do $$
declare fk record;
begin
  for fk in
    select conrelid::regclass as relation, conname, pg_get_constraintdef(oid) as definition
    from pg_constraint
    where contype = 'f' and confdeltype = 'c' and (
      (confrelid = 'public.clinics'::regclass and conrelid in (
        'public.clinical_records'::regclass, 'public.referrals'::regclass,
        'public.appointments'::regclass, 'public.payments'::regclass,
        'public.conversations'::regclass, 'public.messages'::regclass,
        'public.voice_messages'::regclass, 'public.audit_events'::regclass,
        'public.retention_policies'::regclass
      )) or
      (confrelid = 'public.patients'::regclass and conrelid = 'public.conversations'::regclass) or
      (confrelid = 'public.appointments'::regclass and conrelid = 'public.payments'::regclass)
    )
  loop
    execute format('alter table %s drop constraint %I', fk.relation, fk.conname);
    execute format('alter table %s add constraint %I %s', fk.relation, fk.conname,
      replace(fk.definition, 'ON DELETE CASCADE', 'ON DELETE RESTRICT'));
  end loop;
end;
$$;
