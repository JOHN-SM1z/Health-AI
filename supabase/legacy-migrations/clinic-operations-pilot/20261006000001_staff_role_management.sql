-- Serialize membership changes with actor revalidation inside the lock.
create function public.manage_clinic_staff(p_clinic uuid,p_actor uuid,p_target uuid,p_role public.staff_role,p_action text)
returns void language plpgsql security definer set search_path=public as $$
begin
 perform pg_advisory_xact_lock(hashtextextended('staff:'||p_clinic::text,0));
 perform public.operations_require_actor(p_clinic,p_actor,array['owner']::public.staff_role[]);
 if p_target=p_actor then raise exception 'cannot change own membership'; end if;
 if p_action not in ('add','change','remove') then raise exception 'invalid action'; end if;
 if p_action<>'remove' and p_role is null then raise exception 'role required'; end if;
 if p_action='add' then
   if exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_target) then raise exception 'membership exists'; end if;
 else
   if not exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_target) then raise exception 'membership not found'; end if;
   delete from public.staff_roles where clinic_id=p_clinic and profile_id=p_target;
 end if;
 if p_action<>'remove' then insert into public.staff_roles(clinic_id,profile_id,role) values(p_clinic,p_target,p_role); end if;
 if p_action='remove' or p_role<>'doctor' then update public.doctors set active=false where clinic_id=p_clinic and profile_id=p_target; end if;
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id,new_values)
 values(p_clinic,p_actor,'staff','staff_'||p_action,'profiles',p_target::text,jsonb_build_object('role',p_role));
end $$;
revoke all on function public.manage_clinic_staff(uuid,uuid,uuid,public.staff_role,text) from public,anon,authenticated;
grant execute on function public.manage_clinic_staff(uuid,uuid,uuid,public.staff_role,text) to service_role;
