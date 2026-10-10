-- The updated_at trigger function was the one function without a fixed search_path
-- (Supabase security advisor: function_search_path_mutable). It only assigns
-- now() to NEW.updated_at, so pinning the path changes nothing it does.
alter function public.set_updated_at() set search_path = public, pg_temp;
