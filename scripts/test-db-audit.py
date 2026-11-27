"""Rehearse audit upgrades on disposable databases, never on a hosted DB.
PGHOST must be a local Unix socket directory. Optional --ref replays a Git
schema snapshot before applying the new audit migrations from this checkout.
"""
import argparse, os, subprocess, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--ref')
args = parser.parse_args()
host = os.environ.get('PGHOST', '')
if not host.startswith('/') or not Path(host).is_dir():
    raise SystemExit('Use a local Unix socket PGHOST; network databases are refused')
name = 'health_audit_' + uuid.uuid4().hex[:12]
base = ['psql','-X','-q','-A','-t','-h',host,'-p',os.environ.get('PGPORT','5432'),'-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose']
def sql(statement, db=name):
    return subprocess.run(base+['-d',db],input=statement,text=True,capture_output=True)
def checked(statement):
    r=sql(statement)
    if r.returncode: raise AssertionError(r.stderr)
    return r.stdout.strip()
def git(*parts):
    return subprocess.check_output(['git',*parts],cwd=ROOT,text=True)
def uid(n): return "'00000000-0000-4000-8000-%012d'"%n
SERVICE="set local request.jwt.claim.role='service_role';"
checks=0
def test(label,statement,expected=None,error=None,actor=SERVICE):
    global checks
    r=sql('begin;'+actor+statement+';rollback;')
    ok=(r.returncode!=0 and error in r.stderr) if error else (r.returncode==0 and (expected is None or r.stdout.strip().splitlines()[-1:]==[expected]))
    if not ok: raise AssertionError(label+': '+(r.stderr or r.stdout))
    checks+=1
    print('PASS '+label,flush=True)

created=False
try:
    r=sql('create database '+name,'postgres')
    if r.returncode: raise AssertionError(r.stderr)
    created=True
    for role,extra in [('anon',''),('authenticated',''),('service_role','bypassrls')]:
        checked(f"do $$ begin if not exists(select 1 from pg_roles where rolname='{role}') then create role {role} nologin {extra}; end if; end $$;")
    bootstrap=(ROOT/'docs/db-audit-evidence-2026-10-05/bootstrap.sql').read_text()
    bootstrap='\n'.join(l for l in bootstrap.splitlines() if not l.startswith('create role '))
    checked(bootstrap)
    checked("alter table storage.buckets add column file_size_limit bigint, add column allowed_mime_types text[];alter table auth.users add column email text; create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb) $$; alter default privileges in schema public grant all on tables to anon,authenticated,service_role;")
    paths=git('ls-tree','-r','--name-only',args.ref,'supabase/migrations').splitlines() if args.ref else [str(p.relative_to(ROOT)) for p in sorted((ROOT/'supabase/migrations').glob('*.sql'))]
    pending=[]
    for path in paths:
        if '20261008' in path and 'db_audit_' in path: continue
        body=git('show',args.ref+':'+path) if args.ref else (ROOT/path).read_text()
        checked('begin;'+body+'\ncommit;')
    print('PASS baseline replay '+str(len(paths))+' files',flush=True)
    # Explicit privileges reproduce hosted Supabase defaults without real users.
    checked("grant usage on schema public to anon,authenticated,service_role; grant all on all tables in schema public to service_role;")
    checked(f"""
insert into clinics(id,name,slug,timezone) values({uid(1)},'Audit A','audit-a','UTC'),({uid(2)},'Audit B','audit-b','UTC');
insert into auth.users(id) values({uid(11)});
insert into profiles(id) values({uid(11)});
insert into staff_roles(clinic_id,profile_id,role) values({uid(1)},{uid(11)},'doctor');
insert into doctors(id,clinic_id,profile_id,name) values({uid(21)},{uid(1)},{uid(11)},'Audit doctor'),({uid(22)},{uid(1)},null,'Audit isolated doctor');
insert into services(id,clinic_id,name,duration_minutes,price) values({uid(41)},{uid(1)},'Audit service',30,100),({uid(42)},{uid(1)},'Audit isolated service',30,100);
insert into doctor_services(doctor_id,service_id) values({uid(21)},{uid(41)}),({uid(22)},{uid(42)});
insert into patients(id,clinic_id,full_name) values({uid(31)},{uid(1)},'Audit patient one'),({uid(32)},{uid(1)},'Audit patient two');
begin;{SERVICE}
insert into appointments(id,clinic_id,doctor_id,patient_id,service_id,start_at,end_at,status) values({uid(51)},{uid(1)},{uid(21)},{uid(31)},{uid(41)},'2035-01-01 09:00Z','2035-01-01 09:30Z','cancelled');
insert into payments(id,clinic_id,appointment_id,patient_id,amount) values({uid(61)},{uid(1)},{uid(51)},{uid(31)},100);
commit;
""")
    probes=[('null claim limit',"select count(*) from claim_due_notification_jobs(null)"),('payment patient mismatch',f"update payments set patient_id={uid(32)} where id={uid(61)}"),('catalogue tenant move',f"update doctors set clinic_id={uid(2)} where id={uid(22)}")]
    for label,statement in probes:
        r=sql('begin;'+SERVICE+statement+';rollback;')
        print('BASELINE '+label+': '+('accepted (gap reproduced)' if r.returncode==0 else 'already rejected'),flush=True)
    for f in sorted((ROOT/'supabase/migrations').glob('20261008*_db_audit_*.sql')):
        checked('begin;'+f.read_text()+'\ncommit;')
    test('payment cannot change to another patient',probes[1][1],error='23503')
    test('appointment cannot change patient under payment',f"update appointments set patient_id={uid(32)} where id={uid(51)}",error='23503')
    test('valid payment amount update remains supported',f"update payments set amount=101 where id={uid(61)};select amount::integer from payments where id={uid(61)}",expected='101')
    test('doctor tenant immutable',probes[2][1],error='immutable')
    test('service tenant immutable',f"update services set clinic_id={uid(2)} where id={uid(42)}",error='immutable')
    test('ordinary catalogue edit still supported',f"update services set name='Edited audit service' where id={uid(42)};select name from services where id={uid(42)}",expected='Edited audit service')
    for value in ['null','0','-1','201']:
        test('reject claim limit '+value,f"select count(*) from claim_due_notification_jobs({value})",error='22023')
    test('server may make bounded claim',"select count(*) from claim_due_notification_jobs(1)",expected='0')
    for fn,params in [('claim_due_notification_jobs','1'),('claim_webhook_update',"'audit','id'"),('finish_webhook_update',"'audit','id'"),('release_webhook_update',"'audit','id'")]:
        test(fn+' internal caller guard',f'select {fn}({params})',error='42501',actor="set local request.jwt.claim.role='authenticated';")
        test(fn+' browser grant revoked',f'select {fn}({params})',error='42501',actor="set local role authenticated;set local request.jwt.claim.role='authenticated';")
    test('webhook duplicate claim suppressed',"select claim_webhook_update('audit','id');select claim_webhook_update('audit','id')",expected='f')
    test('completed webhook cannot be reclaimed',"select claim_webhook_update('audit','id');select finish_webhook_update('audit','id');select release_webhook_update('audit','id');select claim_webhook_update('audit','id')",expected='f')
    test('failed webhook can retry',"select claim_webhook_update('audit','id');select release_webhook_update('audit','id');select claim_webhook_update('audit','id')",expected='t')
    test('no destructive browser table privileges',"select count(*) from pg_class where relnamespace='public'::regnamespace and relkind in('r','p') and (has_table_privilege('authenticated',oid,'TRUNCATE') or has_table_privilege('anon',oid,'TRUNCATE') or has_table_privilege('authenticated',oid,'TRIGGER'))",expected='0')
    test('new tables retain hardened default privileges',"create table public.audit_default_probe(id int);select has_table_privilege('authenticated','public.audit_default_probe','TRUNCATE')",expected='f')
    test('timestamp function search path fixed',"select proconfig::text from pg_proc where oid='public.set_updated_at()'::regprocedure",expected='{search_path=pg_catalog}')
    test('existing payment preserved',f"select count(*) from payments where id={uid(61)} and patient_id={uid(31)}",expected='1')
    test('one notification claim signature remains',"select count(*) from pg_proc where pronamespace='public'::regnamespace and proname='claim_due_notification_jobs'",expected='1')
    test('all application tables retain RLS',"select count(*) from pg_class where relnamespace='public'::regnamespace and relkind='r' and not relrowsecurity",expected='0')
    print(f'PASS {checks} upgrade regression checks',flush=True)
finally:
    if created:
        r=sql('drop database '+name,'postgres')
        if r.returncode: raise AssertionError('Could not remove disposable database '+name)
