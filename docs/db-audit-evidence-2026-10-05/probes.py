from pathlib import Path
import subprocess,json
out=Path('/private/tmp/health-ai-db-audit.0xe3j2')
base=['psql','-X','-q','-A','-t','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1']
def u(n):return f"'00000000-0000-4000-8000-{n:012d}'"
def run(sql):return subprocess.run(base,input=sql,capture_output=True,text=True)
def auth(n):return f"set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub={u(n)};"
fixture=f"""
insert into clinics(id,name,slug,timezone) values ({u(1)},'Synthetic A','audit-a','UTC'),({u(2)},'Synthetic B','audit-b','UTC');
insert into auth.users(id) values {','.join('('+u(n)+')' for n in range(11,16))};
insert into profiles(id) select id from auth.users;
insert into staff_roles(clinic_id,profile_id,role) values ({u(1)},{u(11)},'owner'),({u(1)},{u(12)},'manager'),({u(1)},{u(13)},'doctor'),({u(1)},{u(14)},'doctor'),({u(1)},{u(15)},'receptionist');
insert into doctors(id,clinic_id,profile_id,name) values ({u(21)},{u(1)},{u(13)},'Synthetic doctor A'),({u(22)},{u(1)},{u(14)},'Synthetic doctor A2'),({u(23)},{u(2)},null,'Synthetic doctor B');
insert into patients(id,clinic_id,full_name) values ({u(31)},{u(1)},'Synthetic patient A'),({u(32)},{u(2)},'Synthetic patient B'),({u(33)},{u(1)},'Synthetic unrelated patient');
insert into services(id,clinic_id,name,duration_minutes,price) values ({u(41)},{u(1)},'Synthetic service A',30,100),({u(42)},{u(2)},'Synthetic service B',30,200);
insert into specialties(id,clinic_id,name) values ({u(51)},{u(2)},'Synthetic department B');
insert into doctor_working_hours(clinic_id,doctor_id,weekday,start_time,end_time) select clinic_id,id,day,'08:00','17:00' from doctors cross join generate_series(1,7) day;
insert into appointments(id,clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values
({u(61)},{u(1)},{u(21)},{u(31)},{u(41)},'2030-01-07 10:00+00','2030-01-07 10:30+00','pending'),
({u(62)},{u(2)},{u(23)},{u(32)},{u(42)},'2030-01-07 10:00+00','2030-01-07 10:30+00','pending'),
({u(63)},{u(1)},{u(22)},{u(33)},{u(41)},'2030-01-07 10:00+00','2030-01-07 10:30+00','pending');
insert into payments(id,clinic_id,appointment_id,patient_id,amount) values ({u(72)},{u(2)},{u(62)},{u(32)},200);
insert into conversations(id,clinic_id,patient_id) values ({u(81)},{u(1)},{u(31)}),({u(82)},{u(2)},{u(32)});
insert into notification_jobs(id,clinic_id,appointment_id,type,scheduled_for,idempotency_key,patient_telegram_user_id) values ({u(91)},{u(1)},{u(61)},'reminder_2h',now()-interval '1 hour','audit-job-a',100000001),({u(92)},{u(2)},{u(62)},'reminder_2h',now()-interval '1 hour','audit-job-b',100000002);
insert into referrals(id,clinic_id,patient_id,referring_doctor_id,referred_to_doctor_id,referral_reason,clinical_handoff_note) values ({u(101)},{u(1)},{u(31)},{u(21)},{u(22)},'Synthetic reason','SYNTHETIC_CLINICAL_CONTENT');
insert into storage.objects(bucket_id,name) values ('voice-messages','00000000-0000-4000-8000-000000000001/synthetic-voice');
"""
r=run('begin;'+fixture+'commit;');assert r.returncode==0,r.stderr
probes={
'01_rpc_public_execute':"select proname,has_function_privilege('authenticated',p.oid,'EXECUTE'),has_function_privilege('anon',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('claim_due_notification_jobs','claim_webhook_update','finish_webhook_update','release_webhook_update','book_appointment','reschedule_appointment') order by proname;",
'02_anonymous_claim_all_tenants':"set local role anon;select clinic_id,count(*) from claim_due_notification_jobs(200) group by clinic_id;",
'03_anonymous_webhook_poison':"set local role anon;select claim_webhook_update('synthetic-telegram','999');select finish_webhook_update('synthetic-telegram','999');reset role;select status from processed_webhooks where source='synthetic-telegram';",
'04_browser_insert_paid':auth(12)+f"insert into payments(clinic_id,appointment_id,patient_id,amount,status) values ({u(1)},{u(61)},{u(31)},1,'paid');select status,amount,paid_at is null from payments where appointment_id={u(61)};",
'05_cross_clinic_conversation':auth(12)+f"insert into conversations(clinic_id,patient_id,channel) values ({u(1)},{u(32)},'mini_app');select count(*) from conversations where clinic_id={u(1)} and patient_id={u(32)};",
'06_cross_clinic_time_block':auth(12)+f"insert into doctor_time_blocks(clinic_id,doctor_id,starts_at,ends_at) values ({u(1)},{u(23)},'2030-01-07 11:00+00','2030-01-07 12:00+00');select count(*) from doctor_time_blocks where doctor_id={u(23)};",
'07_cross_clinic_cancelled_appointment':auth(12)+f"insert into appointments(clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values ({u(1)},{u(23)},{u(32)},{u(42)},'2030-01-07 12:00+00','2030-01-07 12:30+00','cancelled');select count(*) from appointments where clinic_id={u(1)} and patient_id={u(32)};",
'08_cross_clinic_specialty':auth(12)+f"update services set specialty_id={u(51)} where id={u(41)};select specialty_id={u(51)} from services where id={u(41)};",
'09_notification_foreign_appointment_and_recipient':auth(12)+f"update notification_jobs set appointment_id={u(62)},patient_telegram_user_id=100000003 where id={u(91)};select appointment_id={u(62)},patient_telegram_user_id=100000003 from notification_jobs where id={u(91)};",
'10_referral_forged_authorship_and_access':auth(13)+f"select count(*) as before_access from patients where id={u(33)};insert into referrals(clinic_id,patient_id,referring_doctor_id,referred_to_doctor_id,referral_reason) values ({u(1)},{u(33)},{u(22)},{u(21)},'Synthetic forged reason');select count(*) as after_access from patients where id={u(33)};",
'11_receiver_rewrites_terminal_referral':f"update referrals set status='accepted' where id={u(101)};update referrals set status='completed' where id={u(101)};"+auth(14)+f"update referrals set clinical_handoff_note='SYNTHETIC_REPLACEMENT',expires_at=null where id={u(101)};select status,clinical_handoff_note='SYNTHETIC_REPLACEMENT',expires_at is null from referrals where id={u(101)};",
'12_reception_reads_clinical_handoff':auth(15)+f"select clinical_handoff_note='SYNTHETIC_CLINICAL_CONTENT' from referrals where id={u(101)};",
'13_doctor_reads_private_voice_objects':auth(13)+"select count(*) from storage.objects;",
'14_inactive_doctor_retains_direct_access':f"update doctors set active=false where id={u(21)};"+auth(13)+f"select count(*) from patients where id={u(31)};select count(*) from appointments where id={u(61)};",
'15_manager_appointment_notes_denied':auth(12)+f"update appointments set notes='Synthetic operational note' where id={u(61)};",
'16_reactivate_invalid_slot':f"insert into appointments(id,clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values ({u(64)},{u(1)},{u(21)},{u(31)},{u(41)},'2030-01-07 23:00+00','2030-01-07 23:30+00','cancelled');"+auth(11)+f"update appointments set status='confirmed' where id={u(64)};select status from appointments where id={u(64)};",
'17_multiday_slot_accepted':auth(11)+f"insert into appointments(clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values ({u(1)},{u(21)},{u(31)},{u(41)},'2030-01-08 10:00+00','2030-01-09 10:30+00','confirmed');select count(*) from appointments where end_at-start_at>interval '24 hours';",
'18_audit_copies_clinical_text':auth(12)+f"select count(*) from audit_events where new_values->>'clinical_handoff_note'='SYNTHETIC_CLINICAL_CONTENT';",
'19_payment_patient_mismatch':auth(12)+f"insert into payments(clinic_id,appointment_id,patient_id,amount) values ({u(1)},{u(61)},{u(32)},100);select patient_id={u(32)} from payments where appointment_id={u(61)};",
'20_hung_notification_never_reclaimed':f"update notification_jobs set status='in_progress',updated_at=now()-interval '1 day' where id={u(91)};select count(*) from claim_due_notification_jobs(200) where id={u(91)};",
'21_existing_booking_rpcs_denied':auth(12)+f"select * from book_appointment({u(1)},{u(31)},{u(21)},{u(41)},'2030-01-09 11:00+00');",
'22_existing_payment_update_denied':auth(12)+f"update payments set status='paid' where id={u(72)};",
'23_no_public_tables_without_rls':"select tablename from pg_tables where schemaname='public' and not rowsecurity;",
'24_cross_clinic_doctor_service_denied':auth(12)+f"insert into doctor_services(doctor_id,service_id) values ({u(21)},{u(42)});",
}
results=[]
for name,sql in probes.items():
 full='begin;\n'+sql+'\nrollback;\n';(out/(name+'.sql')).write_text(full);r=run(full)
 item={'probe':name,'exit':r.returncode,'result':r.stdout.strip(),'error':r.stderr.strip()};results.append(item);print(json.dumps(item))
(out/'probe-results.json').write_text(json.dumps(results,indent=2))
