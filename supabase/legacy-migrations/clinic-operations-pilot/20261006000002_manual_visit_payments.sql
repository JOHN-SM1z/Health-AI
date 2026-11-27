-- A visit's charge is created from the catalog in register_walk_in. Only
-- authorized staff can record a manual settlement; receipt copies add no charge.
create function public.set_manual_visit_payment(p_clinic uuid,p_actor uuid,p_payment uuid,p_expected public.payment_status,p_status public.payment_status,p_method text,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v public.payments; v_visit public.visits;
begin
 perform public.operations_require_actor(p_clinic,p_actor,array['owner','admin','manager']::public.staff_role[]);
 select encounter.* into v_visit from public.visits encounter join public.payments p on p.visit_id=encounter.id and p.clinic_id=encounter.clinic_id where p.id=p_payment and p.clinic_id=p_clinic for update of encounter;
 if not found then raise exception 'visit not found'; end if;
 if p_status='paid' and v_visit.status='cancelled' then raise exception 'visit cancelled'; end if;
 select * into v from public.payments where id=p_payment and clinic_id=p_clinic and visit_id is not null for update;
 if not found then raise exception 'payment not found'; end if;
 if v.provider<>'manual' then raise exception 'provider managed payment'; end if;
 if v.status<>p_expected then raise exception 'payment changed; refresh' using errcode='40001'; end if;
 if not ((v.status='unpaid' and p_status='paid') or (v.status='paid' and p_status='refunded')) then raise exception 'invalid manual transition'; end if;
 if p_status='paid' and (p_method is null or p_method not in('cash','terminal')) then raise exception 'payment method required'; end if;
 if p_status='refunded' and (p_reason is null or char_length(trim(p_reason)) not between 3 and 500) then raise exception 'refund reason required'; end if;
 update public.payments set status=p_status,
 paid_at=case when p_status='paid' then now() else paid_at end,
 paid_by=case when p_status='paid' then p_actor else paid_by end,
 metadata=coalesce(metadata,'{}'::jsonb)||case when p_status='paid' then jsonb_build_object('settlement_method',p_method) else jsonb_build_object('refund_reason',p_reason,'refunded_at',now(),'refunded_by',p_actor) end
 where id=v.id returning * into v;
 insert into public.audit_events(clinic_id,actor_id,actor_type,action,entity_type,entity_id,old_values,new_values)
 values(p_clinic,p_actor,'staff','manual_visit_payment','payments',v.id::text,jsonb_build_object('status',p_expected),jsonb_build_object('status',p_status,'amount',v.amount,'currency',v.currency));
 return jsonb_build_object('id',v.id,'status',v.status);
end $$;
revoke all on function public.set_manual_visit_payment(uuid,uuid,uuid,public.payment_status,public.payment_status,text,text) from public,anon,authenticated;
grant execute on function public.set_manual_visit_payment(uuid,uuid,uuid,public.payment_status,public.payment_status,text,text) to service_role;
