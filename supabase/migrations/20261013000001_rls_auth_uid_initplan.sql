-- RLS performance: evaluate auth.uid() once per statement instead of once per row.
-- Wrapping it in a scalar subquery lets Postgres run it as an InitPlan (Supabase advisor
-- 0003 auth_rls_initplan). The predicates are otherwise unchanged, so access is identical.

alter policy "profile read own" on public.profiles
  using (id = (select auth.uid()));

alter policy "profile insert own" on public.profiles
  with check (id = (select auth.uid()));

alter policy "profile update own" on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy "profile read for clinic staff" on public.profiles
  using (exists (
    select 1
    from public.staff_roles reader_roles
    where reader_roles.profile_id = (select auth.uid())
      and reader_roles.clinic_id in (
        select target_roles.clinic_id
        from public.staff_roles target_roles
        where target_roles.profile_id = profiles.id
      )
  ));

alter policy "platform_admins read own" on public.platform_admins
  using (profile_id = (select auth.uid()));

alter policy "Clinic admins can delete messages" on public.messages
  using (exists (
    select 1
    from public.conversations c
    join public.staff_roles sr on sr.clinic_id = c.clinic_id
    where c.id = messages.conversation_id
      and sr.profile_id = (select auth.uid())
      and sr.role = any (array['owner'::public.staff_role, 'admin'::public.staff_role])
  ));
