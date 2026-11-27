from pathlib import Path
import subprocess,json,re
out=Path('/private/tmp/health-ai-db-audit.0xe3j2');root=Path('/Users/jahonshoh/Health-AI')
base=['psql','-X','-q','-A','-t','-h',str(out),'-p','55439','-d','postgres','-v','ON_ERROR_STOP=1']
def run(s):return subprocess.run(base,input=s,capture_output=True,text=True)
s="""begin;
insert into notification_jobs(id,clinic_id,type,scheduled_for,idempotency_key,status,updated_at)
values ('00000000-0000-4000-8000-000000000093','00000000-0000-4000-8000-000000000001','reminder_2h',now()-interval '2 days','audit-orphan','in_progress',now()-interval '1 day');
select updated_at < now()-interval '12 hours' from notification_jobs where id='00000000-0000-4000-8000-000000000093';
select count(*) from claim_due_notification_jobs(200) where id='00000000-0000-4000-8000-000000000093';
rollback;
"""
r=run(s);result={'probe':'34_day_old_in_progress_not_reclaimed','exit':r.returncode,'result':r.stdout.strip(),'error':r.stderr.strip()};print(json.dumps(result));(out/'final-probe-results.json').write_text(json.dumps([result],indent=2));(out/'34_day_old_in_progress_not_reclaimed.sql').write_text(s)
r=run("select table_name,column_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position;")
actual={}
for line in r.stdout.splitlines():
 t,c=line.split('|');actual.setdefault(t,set()).add(c)
ts=(root/'src/lib/supabase/database.types.ts').read_text().split('  public: {',1)[1].split('    Views:',1)[0]
mismatches={}
for name,body in re.findall(r'^      (\w+): \{\n        Row: \{(.*?)^        \}',ts,re.M|re.S):
 fields=set(re.findall(r'^          (\w+):',body,re.M))
 if name not in actual:mismatches[name]={'missing_table':True}
 elif fields != actual[name]:mismatches[name]={'type_only':sorted(fields-actual[name]),'db_only':sorted(actual[name]-fields)}
print('Schema/type comparison:',json.dumps(mismatches));(out/'schema-type-drift.json').write_text(json.dumps(mismatches,indent=2))
