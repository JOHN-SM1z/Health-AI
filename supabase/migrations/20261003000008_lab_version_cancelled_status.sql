-- Laboratory module, phase 6 amendment (1/2): a draft can be ABANDONED, never deleted.
--
-- Adds the `cancelled` value to lab_version_status. Its own migration: a new enum value cannot be used in the transaction
-- that adds it (20261003000009 uses it). Not reversible by migration (an enum value cannot be removed); no row uses it until
-- an abandon is recorded.

do $$
begin
  if not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'lab_version_status' and e.enumlabel = 'cancelled'
  ) then
    alter type public.lab_version_status add value 'cancelled' after 'superseded';
  end if;
end $$;
