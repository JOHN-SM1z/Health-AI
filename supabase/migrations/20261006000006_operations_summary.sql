-- Monthly operational facts; no payroll assumptions or profit estimates.
create function public.operations_summary(p_clinic uuid,p_actor uuid,p_month date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_start timestamptz; v_end timestamptz; v_money boolean; v_result jsonb;
begin
 perform public.operations_require_actor(p_clinic,p_actor,array['owner','admin','manager']::public.staff_role[]);
 select date_trunc('month',p_month::timestamp) at time zone timezone,(date_trunc('month',p_month::timestamp)+interval '1 month') at time zone timezone into v_start,v_end from public.clinics where id=p_clinic;
 select exists(select 1 from public.staff_roles where clinic_id=p_clinic and profile_id=p_actor and role in('owner','admin')) into v_money;
 select jsonb_build_object('visits',count(*),'completed',count(*) filter(where status='completed'),'cancelled',count(*) filter(where status='cancelled')) into v_result from public.visits where clinic_id=p_clinic and arrived_at>=v_start and arrived_at<v_end;
 v_result:=v_result||jsonb_build_object('activeQueue',(select count(*) from public.visits where clinic_id=p_clinic and status in('waiting','called','in_progress')),'canViewMoney',v_money,'refreshedAt',now());
 v_result:=v_result||jsonb_build_object('doctors',coalesce((select jsonb_agg(x) from (
 select d.id,d.name,count(*) arrivals,count(*) filter(where v.status='completed') completed from public.visits v join public.doctors d on d.id=v.doctor_id and d.clinic_id=v.clinic_id where v.clinic_id=p_clinic and v.arrived_at>=v_start and v.arrived_at<v_end group by d.id,d.name order by count(*) desc
 )x),'[]'::jsonb));
 if v_money then
 v_result:=v_result||jsonb_build_object('money',coalesce((select jsonb_agg(x) from (
 select currency,coalesce(sum(amount) filter(where paid_at>=v_start and paid_at<v_end),0) collected,
 coalesce(sum(amount) filter(where status='refunded' and (metadata->>'refunded_at')::timestamptz>=v_start and (metadata->>'refunded_at')::timestamptz<v_end),0) refunded
 from public.payments where clinic_id=p_clinic and visit_id is not null and ((paid_at>=v_start and paid_at<v_end) or (status='refunded' and (metadata->>'refunded_at')::timestamptz>=v_start and (metadata->>'refunded_at')::timestamptz<v_end)) group by currency
 )x),'[]'::jsonb));
 else v_result:=v_result||jsonb_build_object('money',null); end if;
 return v_result;
end $$;
revoke all on function public.operations_summary(uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.operations_summary(uuid,uuid,date) to service_role;
-- Role writes use the locked owner RPC; direct browser writes cannot bypass it.
drop policy if exists "staff_roles manage for owner" on public.staff_roles;
