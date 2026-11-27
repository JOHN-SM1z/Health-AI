from pathlib import Path
import subprocess,json,re,concurrent.futures
out=Path('/private/tmp/health-ai-db-audit.0xe3j2');root=Path('/Users/jahonshoh/Health-AI')
base=['psql','-X','-q','-A','-t','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1']
def run(sql):return subprocess.run(base,input=sql,capture_output=True,text=True)
def u(n):return f"'00000000-0000-4000-8000-{n:012d}'"
def auth(n):return f"set local role authenticated; set local request.jwt.claim.role='authenticated'; set local request.jwt.claim.sub={u(n)};"
probes={
'25_same_clinic_payment_update_denied':f"insert into payments(clinic_id,appointment_id,patient_id,amount) values({u(1)},{u(61)},{u(31)},100);"+auth(12)+f"update payments set status='paid' where appointment_id={u(61)};",
'26_reception_full_payment_amount':f"insert into payments(clinic_id,appointment_id,patient_id,amount) values({u(1)},{u(61)},{u(31)},100);"+auth(15)+f"select amount from payments where appointment_id={u(61)};",
'27_parent_tenant_reassignment':f"insert into doctor_services(doctor_id,service_id) values ({u(21)},{u(41)});insert into staff_roles(clinic_id,profile_id,role) values ({u(2)},{u(12)},'manager');"+auth(12)+f"update services set clinic_id={u(2)} where id={u(41)};reset role;select d.clinic_id<>s.clinic_id from doctor_services ds join doctors d on d.id=ds.doctor_id join services s on s.id=ds.service_id;",
'28_doctor_changes_appointment_primary_key':auth(13)+f"update appointments set id={u(65)},created_at='2020-01-01' where id={u(63)};", # unrelated => zero rows; next correctly owned row separately
'29_doctor_changes_owned_appointment_created_at':auth(13)+f"update appointments set created_at='2020-01-01' where id={u(61)};select created_at='2020-01-01' from appointments where id={u(61)};",
'30_no_composite_foreign_keys':"select count(*) from pg_constraint where contype='f' and connamespace='public'::regnamespace and array_length(conkey,1)>1;",
'31_authenticated_cross_clinic_claim':auth(15)+f"select count(*) from claim_due_notification_jobs(200) where clinic_id={u(2)};",
}
results=[]
for name,sql in probes.items():
 s='begin;'+sql+'rollback;';(out/(name+'.sql')).write_text(s);r=run(s);item={'probe':name,'exit':r.returncode,'result':r.stdout.strip(),'error':r.stderr.strip()};results.append(item);print(json.dumps(item))
# Application payment transition uses read/check, then UPDATE by id with no expected status.
r=run(f"insert into payments(id,clinic_id,appointment_id,patient_id,amount,status) values({u(71)},{u(1)},{u(61)},{u(31)},100,'pending');");assert r.returncode==0,r.stderr
with concurrent.futures.ThreadPoolExecutor() as pool:
 a=pool.submit(run,f"begin;select status from payments where id={u(71)};select pg_sleep(0.5);update payments set status='paid' where id={u(71)};commit;")
 b=pool.submit(run,f"begin;select status from payments where id={u(71)};select pg_sleep(1.0);update payments set status='failed' where id={u(71)};commit;")
 ra,rb=a.result(),b.result()
r=run(f"select status from payments where id={u(71)};")
item={'probe':'32_payment_read_check_write_race','a_exit':ra.returncode,'a_read':ra.stdout.strip(),'b_exit':rb.returncode,'b_read':rb.stdout.strip(),'final_status':r.stdout.strip()};results.append(item);print(json.dumps(item))
# Run the documented setup snapshot as a single SQL transaction, as advertised.
r=run('create database audit_snapshot;');assert r.returncode==0,r.stderr
snapbase=[*base];snapbase[snapbase.index('postgres')]='audit_snapshot'
bootstrap=(out/'bootstrap.sql').read_text();bootstrap='\n'.join(line for line in bootstrap.splitlines() if not line.startswith('create role '))
r=subprocess.run(snapbase,input=bootstrap,capture_output=True,text=True);assert r.returncode==0,r.stderr
r=subprocess.run(snapbase+['-1','-f',str(root/'supabase/full-db-setup.sql')],capture_output=True,text=True)
item={'probe':'33_full_setup_single_transaction','exit':r.returncode,'error':r.stderr[-2000:]};results.append(item);print(json.dumps(item))
(out/'extra-probe-results.json').write_text(json.dumps(results,indent=2))
s=(root/'src/lib/supabase/database.types.ts').read_text().split('  public: {',1)[1].split('    Views:',1)[0]
types=set(re.findall(r'^      (\w+): \{',s,re.M))
sql='\n'.join(p.read_text() for p in (root/'supabase/migrations').glob('*.sql'));tables=set(re.findall(r'create table (?:if not exists )?public\.(\w+)',sql,re.I))
print('Types-only tables:',sorted(types-tables));print('Migration tables missing from types:',sorted(tables-types))
