-- Audit 2026-11-14 P2-4 and P3 hygiene. Non-destructive: no rows or tables are
-- removed here (dropping the stray tables needs the owner's confirmation).

-- P3: align expire_due_referrals with every other function's search_path.
alter function public.expire_due_referrals(uuid) set search_path = public, pg_temp;

-- P3: the messages DELETE policy is dead (authenticated has no DELETE grant).
drop policy if exists "Clinic admins can delete messages" on public.messages;

-- P2-4: todos / todo_deps / inbox_entries are not part of the app. Take away
-- the browser-role grants so a future policy cannot expose them.
do $$
declare
  t text;
begin
  foreach t in array array['todos', 'todo_deps', 'inbox_entries'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end;
$$;
