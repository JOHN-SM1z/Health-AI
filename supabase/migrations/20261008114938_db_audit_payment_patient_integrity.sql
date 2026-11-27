-- Keep the existing FK name/delete behavior and PostgREST one-to-one shape.
set local lock_timeout = '5s';
do $migration$
declare payment_cols smallint[]; appointment_cols smallint[]; f record; target_delete text;
begin
  select array_agg(attnum order by array_position(array['appointment_id','clinic_id','patient_id'],attname::text))
  into payment_cols from pg_attribute where attrelid='public.payments'::regclass and attname in('appointment_id','clinic_id','patient_id') and not attisdropped;
  select array_agg(attnum order by array_position(array['id','clinic_id','patient_id'],attname::text))
  into appointment_cols from pg_attribute where attrelid='public.appointments'::regclass and attname in('id','clinic_id','patient_id') and not attisdropped;
  if cardinality(payment_cols)<>3 or cardinality(appointment_cols)<>3 then
    raise exception 'Unexpected payment/appointment schema';
  end if;
  if not exists(select 1 from pg_index where indrelid='public.appointments'::regclass and indisunique and indisvalid and indpred is null and indnkeyatts=3 and indkey::text=array_to_string(appointment_cols,' ')) then
    alter table public.appointments add constraint appointments_payment_patient_key unique(id,clinic_id,patient_id);
  end if;
  if not exists(select 1 from pg_index where indrelid='public.payments'::regclass and indisunique and indisvalid and indpred is null and indnkeyatts=3 and indkey::text=array_to_string(payment_cols,' ')) then
    alter table public.payments add constraint payments_appointment_patient_key unique(appointment_id,clinic_id,patient_id);
  end if;
  for f in select * from pg_constraint where conrelid='public.payments'::regclass and confrelid='public.appointments'::regclass and contype='f'
  loop
    if f.conkey=payment_cols and f.confkey=appointment_cols then continue; end if;
    if f.confdeltype not in ('c','r','a') or f.confupdtype<>'a' or f.condeferrable then
      raise exception 'Unexpected payment FK behavior; review before upgrading';
    end if;
    target_delete := case f.confdeltype when 'c' then 'cascade' when 'r' then 'restrict' else 'no action' end;
    execute format('alter table public.payments drop constraint %I',f.conname);
    execute format('alter table public.payments add constraint %I foreign key(appointment_id,clinic_id,patient_id) references public.appointments(id,clinic_id,patient_id) on delete %s',f.conname,target_delete);
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='public.payments'::regclass and confrelid='public.appointments'::regclass and contype='f' and conkey=payment_cols and confkey=appointment_cols) then
    raise exception 'Payment patient FK was not established';
  end if;
end;
$migration$;
notify pgrst,'reload schema';
