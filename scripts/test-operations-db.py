"""Replay migrations and test authorization in a disposable local PostgreSQL DB.
Run with PGHOST=<local Unix socket directory> PGPORT=<port> python3 scripts/test-operations-db.py.
Requires psql and CREATEDB. Never uses application env files or a hosted database.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import json, os, subprocess, uuid
root = Path(__file__).resolve().parents[1]
host = os.environ.get('PGHOST', '')
if not host.startswith('/') or not Path(host).is_dir():
    raise SystemExit('PGHOST must be an existing local Unix socket directory')
database = 'health_ai_test_' + uuid.uuid4().hex[:12]
base = ['psql', '-X', '-q', '-A', '-t', '-h', host, '-p', os.environ.get('PGPORT', '5432'), '-v', 'ON_ERROR_STOP=1']
def sql(text, db=database):
    return subprocess.run(base + ['-d', db], input=text, capture_output=True, text=True)
def checked(text):
    r = sql(text)
    if r.returncode: raise AssertionError(r.stderr)
    return r.stdout.strip()
def u(n): return "'00000000-0000-4000-8000-%012d'" % n
service = "set local request.jwt.claim.role='service_role';"
def auth(n): return f"set local role authenticated;set local request.jwt.claim.role='authenticated';set local request.jwt.claim.sub={u(n)};"
def register(key=101, patient=31, name='NULL', doctor=21, clinic=1, actor=15):
    return f"select register_walk_in({u(clinic)},{u(actor)},{u(key)},{u(patient) if patient else 'NULL'},{name},NULL,{u(doctor)},{u(41)})"
results=[]
created=False
def test(name, statement, expected=None, denied=None, actor=service):
    r=sql('begin;'+actor+statement+';rollback;')
    if denied is not None: good=r.returncode!=0 and denied in r.stderr
    else: good=r.returncode==0 and (expected is None or r.stdout.strip().splitlines()[-1:]==[expected])
    results.append({'test':name,'passed':good})
    print(('PASS ' if good else 'FAIL ')+name)
    if not good: raise AssertionError(r.stderr or r.stdout)
try:
    r=sql(f'create database {database};','postgres')
    if r.returncode: raise SystemExit(r.stderr)
    created=True
    bootstrap=(root/'docs/db-audit-evidence-2026-10-05/bootstrap.sql').read_text()
    # Roles are cluster-wide; reuse them when this is a second local test run.
    bootstrap='\n'.join(line for line in bootstrap.splitlines() if not line.startswith('create role '))
    for role,extra in [('anon',''),('authenticated',''),('service_role','bypassrls')]:
        checked(f"do $$ begin if not exists(select 1 from pg_roles where rolname='{role}') then create role {role} nologin {extra}; end if; end $$;")
    checked(bootstrap)
    migrations=sorted((root/'supabase/migrations').glob('*.sql'))
    for f in migrations:
        r=sql('begin;\n'+f.read_text()+'\ncommit;')
        if r.returncode: raise AssertionError(f.name+': '+r.stderr)
    print(f'PASS all {len(migrations)} migrations, one transaction per file')
    checked("grant usage on schema public to authenticated,anon,service_role;grant select,insert,update,delete on all tables in schema public to authenticated,service_role;grant usage,select on all sequences in schema public to authenticated,service_role;")
    checked(f"""
insert into clinics(id,name,slug,timezone) values({u(1)},'Synthetic A','test-a','UTC'),({u(2)},'Synthetic B','test-b','UTC');
insert into auth.users(id) values {','.join('('+u(n)+')' for n in range(11,17))};
insert into profiles(id) select id from auth.users;
insert into staff_roles(clinic_id,profile_id,role) values({u(1)},{u(11)},'owner'),({u(1)},{u(12)},'manager'),({u(1)},{u(13)},'doctor'),({u(1)},{u(14)},'doctor'),({u(1)},{u(15)},'receptionist'),({u(2)},{u(16)},'doctor');
insert into doctors(id,clinic_id,profile_id,name) values({u(21)},{u(1)},{u(13)},'Synthetic A'),({u(22)},{u(1)},{u(14)},'Synthetic A2'),({u(23)},{u(2)},{u(16)},'Synthetic B');
insert into patients(id,clinic_id,full_name) values({u(31)},{u(1)},'Synthetic patient'),({u(32)},{u(2)},'Synthetic other clinic'),({u(33)},{u(1)},'Synthetic unrelated');
insert into services(id,clinic_id,name,duration_minutes,price) values({u(41)},{u(1)},'Synthetic service',30,100);
begin;{service}{register()};commit;
""")
    test('registration creates exactly one server-priced charge',f"select count(*)=1 and min(amount)=100 from payments where visit_id is not null",'t')
    test('retry reuses the ticket',register()+";select count(*) from visits",expected="1")
    test('retry with another patient is rejected',register(patient=33),denied='idempotency conflict')
    test('cross-clinic patient rejected',register(102,32),denied='patient not found')
    test('cross-clinic doctor rejected',register(102,31,doctor=23),denied='doctor unavailable')
    test('cross-clinic actor rejected',register(102,31,clinic=2),denied='clinic access denied')
    test('doctors cannot register arrivals',register(102,31,actor=13),denied='clinic access denied')
    test('browser cannot call arrival RPC',register(102),denied='permission denied',actor=auth(15))
    test('new-patient retry binds the original name',register(102,None,"'Synthetic new'")+";"+register(102,None,"'Different synthetic'"),denied='idempotency conflict')
    test('treating doctor can read history',f"select doctor_patient_access({u(1)},{u(31)},{u(13)})",'t')
    test('unrelated doctor cannot read history',f"select doctor_patient_access({u(1)},{u(31)},{u(14)})",'f')
    test('management has no clinical bypass',f"select doctor_patient_access({u(1)},{u(31)},{u(12)})",'f')
    test('browser cannot impersonate another doctor',f"select doctor_patient_access({u(1)},{u(31)},{u(13)})",'f',actor=auth(14))
    test('inactive doctor loses access',f"update doctors set active=false where id={u(21)};select doctor_patient_access({u(1)},{u(31)},{u(13)})",'f')
    referral=f"insert into referrals(id,clinic_id,patient_id,referring_doctor_id,referred_to_doctor_id,referral_reason,clinical_handoff_note,created_by,updated_by,expires_at) values({u(201)},{u(1)},{u(31)},{u(21)},{u(22)},'Synthetic referral','SYNTHETIC_NARRATIVE',{u(13)},{u(13)},now()+interval '30 days')"
    checked('begin;'+service+referral+';commit;')
    test('open referral immediately permits history',f"select doctor_patient_access({u(1)},{u(31)},{u(14)})",'t')
    test('cannot forge referral sender',referral.replace(u(201),u(202)).replace(u(13),u(14)),denied='referral author')
    test('direct browser referral insertion is denied',referral.replace(u(201),u(202)),denied='row-level security',actor=auth(13))
    test('completion needs no accept/start ceremony',f"update referrals set status='completed',updated_by={u(14)} where id={u(201)};select doctor_patient_access({u(1)},{u(31)},{u(14)})",'f')
    test('receiver cannot revoke',f"update referrals set status='revoked',updated_by={u(14)},revoked_by={u(14)} where id={u(201)}",denied='only sender')
    test('original referral content is immutable',f"update referrals set clinical_handoff_note='changed',updated_by={u(13)} where id={u(201)}",denied='immutable')
    test('referral audit contains no clinical narrative',"select count(*) from audit_events where new_values::text like '%SYNTHETIC_NARRATIVE%'",'0')
    test('reception cannot read clinical referrals',"select count(*) from referrals",'0',actor=auth(15))
    note=f"insert into clinical_notes(id,clinic_id,patient_id,doctor_id,title,content,is_private) values({u(301)},{u(1)},{u(31)},{u(21)},'Synthetic note','Synthetic content',true)"
    checked('begin;'+service+note+';commit;')
    test('receiving doctor cannot see private notes',"select count(*) from clinical_notes",'0',actor=auth(14))
    test('author sees own private note',"select count(*) from clinical_notes",'1',actor=auth(13))
    test('clinical notes cannot be overwritten',"update clinical_notes set content='changed'",denied='append-only')
    test('unrelated-patient note denied',note.replace(u(301),u(302)).replace(u(31),u(33)),denied='not authorized')
    test('reception cannot start clinical visit',f"select transition_visit({u(1)},{u(15)},(select id from visits limit 1),'waiting','in_progress')",denied='doctor action required')
    test('other doctor cannot move queue state',f"select transition_visit({u(1)},{u(14)},(select id from visits limit 1),'waiting','called')",denied='not your visit')
    test('stale queue write rejected',f"select transition_visit({u(1)},{u(13)},(select id from visits limit 1),'called','in_progress')",denied='visit changed')
    test('anonymous privileged RPC grants removed',"select bool_and(not has_function_privilege('anon',oid,'execute') and not has_function_privilege('authenticated',oid,'execute')) from pg_proc where proname in('claim_due_notification_jobs','claim_webhook_update','finish_webhook_update','release_webhook_update')",'t')
    test('every application table has RLS',"select count(*) from pg_tables where schemaname='public' and not rowsecurity",'0')
    test('owner cannot remove self',f"select manage_clinic_staff({u(1)},{u(11)},{u(11)},NULL,'remove')",denied='own membership')
    test('manager cannot change staff roles',f"select manage_clinic_staff({u(1)},{u(12)},{u(15)},'owner','change')",denied='clinic access denied')
    test('removing doctor removes clinical access',f"select manage_clinic_staff({u(1)},{u(11)},{u(14)},NULL,'remove');select doctor_patient_access({u(1)},{u(31)},{u(14)})",expected=None)
    payment="(select id from payments where visit_id=(select id from visits limit 1))"
    def settle(actor=12,expected='unpaid',status='paid',method="'cash'",reason='NULL'):
        return f"select set_manual_visit_payment({u(1)},{u(actor)},{payment},'{expected}','{status}',{method},{reason})"
    test('reception cannot collect money',settle(actor=15),denied='clinic access denied')
    test('cash collection records the method',settle()+";select metadata->>'settlement_method' from payments",expected="cash")
    test('stale payment transition rejected',settle()+";"+settle(),denied='payment changed')
    test('cannot refund an unpaid charge',settle(status='refunded',reason="'Synthetic refund'"),denied='invalid manual transition')
    test('refund requires a reason',settle()+";"+settle(expected='paid',status='refunded'),denied='refund reason required')
    test('full refund is recorded atomically',settle()+";"+settle(expected='paid',status='refunded',reason="'Synthetic refund'")+";select status from payments",expected="refunded")
    test('cancelled waiting visit voids its unpaid charge',f"select transition_visit({u(1)},{u(15)},(select id from visits limit 1),'waiting','cancelled');select status from payments",expected="voided")
    test('cancelled visit cannot collect money',f"select transition_visit({u(1)},{u(15)},(select id from visits limit 1),'waiting','cancelled');"+settle(),denied='visit cancelled')
    test('browser cannot insert a paid visit charge',f"insert into payments(clinic_id,visit_id,patient_id,amount,status) values({u(1)},(select id from visits limit 1),{u(31)},1,'paid')",denied='row-level security',actor=auth(12))
    test('cross-clinic conversation rejected',f"insert into conversations(clinic_id,patient_id) values({u(1)},{u(32)})",denied='foreign key')
    test('cross-clinic time block rejected',f"insert into doctor_time_blocks(clinic_id,doctor_id,starts_at,ends_at) values({u(1)},{u(23)},'2030-01-07 11:00+00','2030-01-07 12:00+00')",denied='foreign key')
    test('tenant reassignment rejected',f"update patients set clinic_id={u(2)} where id={u(33)}",denied='identity are immutable')
    test('record identity reassignment rejected',f"update patients set id={u(34)} where id={u(33)}",denied='identity are immutable')
    test('patient number remains stable',f"update patients set patient_number=90000 where id={u(31)}",denied='GENERATED ALWAYS')
    test('patient number cannot be regenerated',f"update patients set patient_number=DEFAULT where id={u(31)}",denied='patient number is immutable')
    test('owner cannot bypass role RPC in browser',f"update staff_roles set role='receptionist' where profile_id={u(11)};select role from staff_roles where profile_id={u(11)}",'owner',actor=auth(11))
    test('manager receives workload without financial totals',f"select operations_summary({u(1)},{u(12)},current_date)->>'canViewMoney'",'false')
    test('collected and refunded amounts remain separate',settle()+";"+settle(expected='paid',status='refunded',reason="'Synthetic refund'")+f";select operations_summary({u(1)},{u(11)},current_date)->'money'->0->>'collected'='100.00' and operations_summary({u(1)},{u(11)},current_date)->'money'->0->>'refunded'='100.00'",'t')
    test('stale notification claim is quarantined without resend',"insert into notification_jobs(clinic_id,type,scheduled_for,status,updated_at,idempotency_key) values("+u(1)+",'reminder_2h',now()-interval '2 hours','in_progress',now()-interval '2 hours','synthetic-stale');select count(*) from claim_due_notification_jobs(20);select status from notification_jobs where idempotency_key='synthetic-stale'",'failed')
    def lab(action,payload,actor=13,clinic=1):
        encoded=json.dumps(payload).replace("'","''")
        return f"select lab_workbench({u(clinic)},{u(actor)},'{action}','{encoded}'::jsonb)"
    def ident(n): return '00000000-0000-4000-8000-%012d' % n
    order_payload={'patientId':ident(31),'idempotencyKey':ident(601),'specimenType':'Synthetic sample','tests':['Synthetic A','Synthetic B']}
    checked('begin;'+service+lab('create',order_payload)+';commit;')
    order_id=checked('select id from lab_orders limit 1')
    specimen_id=checked('select id from lab_specimens limit 1')
    test_id=checked('select id from lab_order_tests order by test_name limit 1')
    test('lab retry returns one order',lab('create',order_payload)+';select count(*) from lab_orders','1')
    test('lab changed retry payload rejected',lab('create',{**order_payload,'tests':['Different']}),denied='idempotency conflict')
    test('lab cross-clinic patient rejected',lab('create',{**order_payload,'patientId':ident(32)}),denied='patient access denied')
    test('lab reception access denied',lab('list',{},actor=15),denied='clinic access denied')
    test('lab browser RPC execution denied',lab('list',{}),denied='permission denied',actor=auth(13))
    test('lab direct browser rows hidden','select count(*) from lab_orders','0',actor=auth(13))
    test('lab scoped list includes authorized order',lab('list',{})+";select count(*) from lab_order_tests",'2')
    transition={'orderId':order_id,'specimenId':specimen_id,'expectedVersion':1,'status':'collected'}
    test('lab cannot skip collection',lab('transition',{**transition,'status':'processing'}),denied='invalid specimen transition')
    draft={'orderId':order_id,'testId':test_id,'expectedRevision':0,'value':'1.50','unit':'synthetic','referenceText':''}
    test('lab result before processing denied',lab('draft',draft),denied='specimen not processing')
    for version,status in enumerate(['collected','received','processing'],1): checked('begin;'+service+lab('transition',{**transition,'expectedVersion':version,'status':status})+';commit;')
    test('lab stale specimen mutation denied',lab('transition',transition),denied='specimen changed')
    checked('begin;'+service+lab('draft',draft)+';commit;')
    test('lab duplicate result retry cannot append',lab('draft',draft),denied='draft changed')
    test('lab correction without reason denied',lab('draft',{**draft,'expectedRevision':1}),denied='correction reason required')
    test('lab drafts append only',"update lab_result_drafts set value='overwrite'",denied='append-only')
    test('lab release without clinic policy denied',lab('release',{'orderId':order_id}),denied='unsupported action')
    test('lab correction preserves original',lab('draft',{**draft,'expectedRevision':1,'value':'2','reason':'Synthetic correction'})+";select count(*) from lab_result_drafts",'2')
    rejected=lab('transition',{**transition,'expectedVersion':4,'status':'rejected','reason':'Synthetic rejection'})
    recollect=lab('recollect',{**transition,'expectedVersion':5})
    test('lab recollection preserves prior specimen and results',rejected+';'+recollect+";select count(*)=2 and (select count(*) from lab_result_drafts)=1 from lab_specimens",'t')
    test('lab former specimen cannot satisfy new sample',rejected+';'+recollect+';'+lab('draft',{**draft,'expectedRevision':1,'reason':'New sample'}),denied='specimen not processing')
    def concurrent_registration(key): return checked('begin;'+service+register(key)+';commit;')
    with ThreadPoolExecutor(max_workers=8) as pool: list(pool.map(concurrent_registration,range(401,409)))
    test('concurrent arrivals use distinct ticket numbers',"select count(*)=9 and count(distinct queue_number)=9 and (select count(*) from payments)=9 from visits",'t')
    with ThreadPoolExecutor(max_workers=8) as pool: list(pool.map(concurrent_registration,[501]*8))
    test('concurrent retries charge once',"select count(*)=10 and (select count(*) from payments)=10 from visits",'t')
    print(f'PASS {len(results)} operation/security checks')
finally:
    # This name is generated by this process; never drop a caller-specified DB.
    if created: sql(f'drop database if exists {database} with (force);','postgres')
