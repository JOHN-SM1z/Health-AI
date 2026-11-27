-- Canonical main sets this to public,pg_temp after an earlier local audit
-- hardened it to pg_catalog. A forward migration gives clean installs and
-- upgrades the same definition without rewriting canonical migration history.
alter function public.set_updated_at() set search_path = pg_catalog;
